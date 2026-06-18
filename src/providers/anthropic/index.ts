import Anthropic from '@anthropic-ai/sdk';
import { anthropicEffort } from '../effort.ts';
import { boolFromEnv } from '../env.ts';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  GenerateRequest,
  Provider,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessage,
  ProviderReasoningBlock,
  ProviderToolDef,
  StreamEvent,
  UsageInfo,
} from '../types.ts';
import {
  type CacheTtl,
  MAX_CACHE_BREAKPOINTS_PER_REQUEST,
  cacheMarker,
  countCacheBreakpoints,
  messagesWithTailCacheBreakpoint,
  systemSegmentsWithCacheBreakpoints,
  systemWithCacheBreakpoint,
  toolsWithCacheBreakpoint,
} from './cache.ts';
import { ANTHROPIC_CAPS } from './capabilities.ts';
import { type RawAnthropicEvent, normalizeAnthropicStream } from './stream.ts';

export interface CreateAnthropicProviderOptions {
  apiKey?: string;
  // Inject a pre-built SDK client (test seam).
  client?: Anthropic;
  // Prompt-cache TTL for ALL breakpoints: the default 5-minute ephemeral,
  // or the 1-hour extended cache. 1h keeps the (large) context alive across
  // >5min inter-turn gaps so it isn't re-written each lapse — paying a 2×
  // write premium (vs 1.25×) on every write in exchange. Net win only when
  // such gaps are common (a dev session with pauses); it can RAISE cost on
  // rapid-turn sessions. Opt-in, all-or-nothing (mixed TTL would make the
  // response's single cache_creation number un-attributable to a rate, so
  // cost accounting couldn't stay exact). When omitted, falls back to the
  // FORJA_ANTHROPIC_CACHE_TTL env var so the CLI path (registry factory
  // invoked with no options) can A/B test by flipping one env var.
  cacheTtl?: CacheTtl;
  // Override capabilities — supplied by the catalog-file loader for an
  // operator-registered model. When omitted, capabilities resolve from
  // the static ANTHROPIC_CAPS catalog.
  capabilities?: ProviderCapabilities;
  // Custom endpoint (Anthropic-compatible gateway / proxy). Optional;
  // omitted ⇒ the SDK's default base URL.
  baseURL?: string;
}

// Resolve the cache TTL default from the environment for callers who don't
// pass an explicit option (the registry factory used by CLI bootstrap
// forwards none today). Only the exact string '1h' opts in; everything
// else — unset, empty, '5m', typos — keeps the safe 5-minute default.
const cacheTtlFromEnv = (): CacheTtl =>
  process.env.FORJA_ANTHROPIC_CACHE_TTL === '1h' ? '1h' : '5m';

// Strip `name` from tool_result blocks. Our canonical
// ProviderToolResultBlock keeps `name` as optional metadata for
// Gemini (which correlates results to calls by name). Anthropic
// only accepts `tool_use_id`/`content`/`is_error` and 400s with
// `Extra inputs are not permitted` if `name` leaks through.
// Content blocks Anthropic actually accepts on the wire. `reasoning` is the
// provider-neutral opaque carrier — it is mapped to a native thinking block on
// replay (Phase 2, flagged) or dropped; it is never sent as-is.
type AnthropicSendableBlock = Exclude<ProviderContentBlock, ProviderReasoningBlock>;
// Native Anthropic reasoning wire blocks — signed `thinking` or `redacted_thinking`
// (safety-redacted, opaque `data`). Neither is a ProviderContentBlock; both only
// exist at the wire boundary, reconstructed from a captured reasoning block. Both
// MUST round-trip unchanged with tool_results or the API rejects the turn.
type AnthropicReasoningWireBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };
type AnthropicWireBlock = AnthropicSendableBlock | AnthropicReasoningWireBlock;

const stripToolResultName = (block: AnthropicSendableBlock): AnthropicSendableBlock => {
  if (block.type !== 'tool_result') return block;
  const cleaned: AnthropicSendableBlock = {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
  };
  if (block.is_error !== undefined) cleaned.is_error = block.is_error;
  return cleaned;
};

// Reconstruct the native signed thinking block from a captured reasoning block,
// VERBATIM — the signature must round-trip byte-identical or Anthropic 400s the
// tool-bearing turn. Only `provider: 'anthropic'` blocks map; foreign-tagged
// blocks (a different family captured them mid-session) are dropped, mirroring
// the API's own cross-model behavior. Returns undefined for anything unusable.
const reasoningToWireBlock = (
  block: ProviderReasoningBlock,
): AnthropicReasoningWireBlock | undefined => {
  if (block.provider !== 'anthropic') return undefined;
  const data = block.data as {
    thinking?: unknown;
    signature?: unknown;
    redacted_thinking?: unknown;
  } | null;
  if (data === null || typeof data !== 'object') return undefined;
  // Safety-redacted thinking: opaque `data`, no readable summary — replayed
  // verbatim (the multi-turn protocol breaks if it's dropped, per the API docs).
  if (typeof data.redacted_thinking === 'string') {
    return { type: 'redacted_thinking', data: data.redacted_thinking };
  }
  // Signed thinking: text (possibly empty under display:'omitted') + signature.
  if (typeof data.thinking === 'string' && typeof data.signature === 'string') {
    if (data.signature.length === 0) return undefined;
    return { type: 'thinking', thinking: data.thinking, signature: data.signature };
  }
  return undefined;
};

const toAnthropicMessage = (
  m: ProviderMessage,
  reasoningReplay: boolean,
): { role: ProviderMessage['role']; content: string | AnthropicWireBlock[] } => {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  const out: AnthropicWireBlock[] = [];
  for (const b of m.content) {
    if (b.type === 'reasoning') {
      // Off (Phase 1 behavior): drop. On: replay as a native thinking block,
      // placed in situ — the loop already stores reasoning FIRST in the
      // assistant turn, so it lands before text/tool_use as the contract needs.
      if (!reasoningReplay) continue;
      const wire = reasoningToWireBlock(b);
      if (wire !== undefined) out.push(wire);
      continue;
    }
    out.push(stripToolResultName(b));
  }
  return { role: m.role, content: out };
};

const toAnthropicTool = (t: ProviderToolDef): Anthropic.Tool => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
});

// Anthropic thinking surface, gated by the model's capability.
// ADAPTIVE models (Opus 4.7/4.8, Sonnet 4.6 — `supports_adaptive_
// thinking`) only accept `thinking:{type:'adaptive'}`; manual
// `type:'enabled'` is REJECTED with HTTP 400 on Opus 4.7/4.8 and
// deprecated on Sonnet 4.6. In adaptive mode the model chooses its
// own depth (guided by `output_config.effort`), so `budget_tokens`
// is dropped. We engage adaptive when EITHER a legacy budget was
// requested (> 0, the old "I want thinking" signal) OR an effort
// level was set (high-level reasoning intent) — both mean the
// operator cares about reasoning. LEGACY models keep the manual
// `enabled + budget_tokens` surface; budget=0 omits the block
// (disable-via-zero idiom, PLAYBOOKS.md §1.1).
// Opt-in (Phase 2): replay signed thinking blocks across tool-bearing turns so
// interleaved thinking stays ON during the agentic loop. Default OFF until the
// long-horizon eval proves value. Adaptive-thinking models (the current Claude
// family) auto-enable interleaved thinking with NO beta header; the signature
// round-trips byte-identical via the reasoning block (never canonicalized).
export const anthropicThinkingParam = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
  reasoningReplay = false,
  thinkingDefaultOn = false,
): { thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } } => {
  const budget = req.thinking_budget;
  const adaptive = caps.supports_adaptive_thinking === true;
  // `budget: 0` (or negative) is the explicit disable-via-zero idiom and ALWAYS
  // wins, even with thinking default-on (PLAYBOOKS §1.1) — evals/CI pin this for
  // determinism.
  if (budget !== undefined && budget <= 0) return {};
  // When thinking is engaged:
  //   - ADAPTIVE models (Opus 4.7/4.8, Sonnet 4.6): ON by default
  //     (`thinkingDefaultOn`, from FORJA_ANTHROPIC_THINKING) OR an explicit
  //     budget > 0. The Anthropic guidance is to default to adaptive thinking;
  //     `effort` (output_config.effort) guides DEPTH, not on/off, so the two are
  //     orthogonal.
  //   - LEGACY models (Haiku): only via an explicit budget > 0 — there's no
  //     adaptive surface and we don't wire the interleaved-thinking beta header.
  //
  // The AUTO default YIELDS to an explicit `temperature`/`top_p` pin: engaging
  // thinking strips sampling (Anthropic 400s on thinking + sampling), so a caller
  // that pinned sampling for DETERMINISM (the verify-* fact-check subagents at
  // temperature 0.1, the compaction summarizer at 0, any eval/subagent with a
  // sampling override) must keep it — auto-thinking would silently drop it. An
  // EXPLICIT budget > 0 still wins (the caller asked for thinking outright; the
  // pinned sampling is then stripped as before).
  const hasExplicitSampling = req.temperature !== undefined || req.top_p !== undefined;
  const wantThinking = adaptive
    ? (budget !== undefined && budget > 0) || (thinkingDefaultOn && !hasExplicitSampling)
    : budget !== undefined && budget > 0;
  if (!wantThinking) return {};
  // Defensive gate: thinking is allowed only on NO-TOOL turns. When the model
  // emits a `thinking` block before a `tool_use`, the Anthropic contract
  // requires that unmodified block (including its cryptographic `signature`)
  // to be replayed with the next turn's `tool_result`, or the follow-up
  // request breaks reasoning continuity / returns HTTP 400. Forja drops
  // `signature_delta` at the stream layer and does not store thinking blocks
  // in `ProviderMessage`, so it cannot round-trip them yet. Until that lands
  // (deferred behind a long-horizon eval), suppress thinking whenever tools
  // are present — preserving the one case where it plausibly helps (reasoning
  // before a tool-less action) while keeping every tool-bearing turn safe.
  // The `generate` closure surfaces a one-time warning when this fires so the
  // operator learns why a configured `thinking_budget` had no effect. With
  // reasoning replay ON the gate lifts: the signed thinking block now round-
  // trips with the tool_result, so thinking is safe on tool-bearing turns.
  if (!reasoningReplay && req.tools !== undefined && req.tools.length > 0) return {};
  // Legacy branch is only reached with budget > 0 (see `wantThinking`).
  return adaptive
    ? { thinking: { type: 'adaptive' } }
    : { thinking: { type: 'enabled', budget_tokens: budget as number } };
};

// Anthropic rejects `temperature` and `top_p` sent TOGETHER on
// current models (HTTP 400: "`temperature` and `top_p` cannot both
// be specified for this model"). This is distinct from the
// `supports_sampling` gate above (Opus 4.7 deprecated BOTH knobs
// entirely): Haiku 4.5 and the rest of the 4.x family accept
// sampling, they just reject the pair. Anthropic's own guidance is
// to tune one OR the other, never both — so when a caller provides
// both (recap's TOKEN_TUNING §9 sampling sets `temperature: 0.2`
// AND `top_p: 0.95`), the adapter sends only `temperature`, the
// primary determinism knob. Sending at most one is always valid,
// so this needs no per-model capability flag. When sampling is
// stripped wholesale (`acceptsSampling === false`), neither goes.
const samplingParams = (
  req: { temperature?: number; top_p?: number },
  acceptsSampling: boolean,
): { temperature?: number } | { top_p?: number } | Record<string, never> => {
  if (!acceptsSampling) return {};
  if (req.temperature !== undefined) return { temperature: req.temperature };
  if (req.top_p !== undefined) return { top_p: req.top_p };
  return {};
};

export const createAnthropicProvider = (
  modelName: string,
  options: CreateAnthropicProviderOptions = {},
): Provider => {
  const caps = options.capabilities ?? ANTHROPIC_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(
      `unknown Anthropic model: ${modelName} (pass options.capabilities or add it to ANTHROPIC_CAPS)`,
    );
  }

  const cacheTtl = options.cacheTtl ?? cacheTtlFromEnv();
  // Engage 1h ONLY when we can also price it (a model with a declared 1h
  // write rate). `oneHourRate` is the single source both the request marker
  // and the effective cost rate key off — so we never tag a request 1h
  // (billed 2× by Anthropic) while still costing it at the 5-min rate, or
  // the reverse. When 1h is on, every cache write bills at it (2× input)
  // vs the 5-min rate (1.25×); surface that as the effective
  // `cost_per_1k_cache_write` so computeCost / the /stats breakdown stay
  // exact — without mutating the shared ANTHROPIC_CAPS entry (a const
  // reused by every instance of this model).
  const oneHourRate = cacheTtl === '1h' ? caps.cost_per_1k_cache_write_1h : undefined;
  const marker = cacheMarker(oneHourRate !== undefined ? '1h' : '5m');
  const effectiveCaps: ProviderCapabilities =
    oneHourRate !== undefined ? { ...caps, cost_per_1k_cache_write: oneHourRate } : caps;

  // Warn once per provider instance when extended thinking is suppressed
  // because tools are present (see `anthropicThinkingParam`). A per-request
  // warning would spam an agentic loop; a config-level mismatch only needs
  // to be said once. stderr, never stdout (stdout stays pure for --json).
  let warnedThinkingSuppressedByTools = false;

  let client: Anthropic;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('Anthropic API key required (pass options.apiKey or set ANTHROPIC_API_KEY)');
    }
    client = new Anthropic({
      apiKey,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    });
  }

  // Resolved once: whether to replay signed thinking blocks across tool turns
  // and lift the suppression gate. Default ON (the Anthropic docs make preserving
  // thinking blocks across tool use MANDATORY when thinking is engaged); set
  // FORJA_ANTHROPIC_REASONING_REPLAY=0 to opt out. Near-inert unless a
  // thinking_budget is set — with thinking off there are no blocks to replay, so
  // default-ON only changes behavior for sessions that actually enable thinking
  // (where it's required for correctness). Gated to ADAPTIVE-thinking models —
  // they auto-enable interleaved thinking with no beta header (the header-free
  // path the docs describe). Legacy/non-adaptive (e.g. Haiku) would need the
  // `interleaved-thinking-2025-05-14` header we don't wire, so replay stays off.
  const reasoningReplay =
    boolFromEnv('FORJA_ANTHROPIC_REASONING_REPLAY', true) &&
    caps.supports_adaptive_thinking === true;
  // Adaptive thinking default-ON for adaptive models (the Anthropic guidance:
  // default to adaptive thinking for non-trivial work). Set FORJA_ANTHROPIC_THINKING=0
  // to opt out globally (CI/eval determinism, cost-sensitive sessions); a per-call
  // `thinking_budget: 0` disables it for that call. Inert on legacy models.
  const thinkingDefaultOn = boolFromEnv('FORJA_ANTHROPIC_THINKING', true);

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    // The SDK's typed `messages.stream({...})` accepts our shape directly;
    // we cast the returned async iterable to the local minimal event type
    // (structural compatibility — the SDK's events are a superset).
    //
    // Cache breakpoints (CONTEXT_TUNING.md §3.1, PROVIDERS.md §3.1):
    // anchors are placed on (a) the system block, (b) the last tool,
    // and (c) the last message's last content block. See
    // `./cache.ts` for the full strategy. When the producer
    // supplies `systemSegments`, the prefix is split into multiple
    // TextBlockParams — segments flagged `cacheBreakpoint: true`
    // anchor independent invalidation envelopes (CONTEXT_TUNING.md
    // §3.1). Without segments, the entire system string is one
    // block as before.
    const cachedSystem =
      req.systemSegments !== undefined
        ? systemSegmentsWithCacheBreakpoints(req.systemSegments, marker)
        : systemWithCacheBreakpoint(req.system, marker);
    const cachedTools =
      req.tools !== undefined
        ? toolsWithCacheBreakpoint(req.tools.map(toAnthropicTool), marker)
        : undefined;
    const cachedMessages = messagesWithTailCacheBreakpoint(
      req.messages.map((m) => toAnthropicMessage(m, reasoningReplay)),
      marker,
    );
    // Anthropic 400s on > 4 cache_control markers per request.
    // Asserting here means a future composition change that adds a
    // fourth or fifth marker fails fast in unit/integration tests
    // rather than at the API boundary.
    const breakpointCount = countCacheBreakpoints({
      system: cachedSystem,
      tools: cachedTools,
      messages: cachedMessages,
    });
    if (breakpointCount > MAX_CACHE_BREAKPOINTS_PER_REQUEST) {
      throw new Error(
        `anthropic request exceeds the ${MAX_CACHE_BREAKPOINTS_PER_REQUEST}-breakpoint cache_control limit (${breakpointCount} markers); review src/providers/anthropic/cache.ts`,
      );
    }
    // `thinking_budget` cross-check (PLAYBOOKS.md §1.1, Anthropic
    // API contract). The Messages API rejects requests where the
    // extended-thinking budget is greater than or equal to
    // `max_tokens`. The loader-side gate (`subagents/load.ts`
    // §thinking_budget) only catches the case where BOTH values
    // are explicitly declared in playbook frontmatter; when only
    // `thinking_budget` is set, the runtime resolver picks
    // `capabilities.output_max_tokens` for `max_tokens` and the
    // pair becomes whatever capability the selected provider
    // ships. This check is where that runtime-resolved pair gets
    // validated — surfacing the failure as a source-aware error
    // before the call leaves the binary, with both the resolved
    // values and the capability ceiling visible so the operator
    // knows which side to adjust. Zero is the disable-via-zero
    // idiom (PLAYBOOKS.md §1.1) and gated below by `> 0` —
    // skipped here so a playbook with `thinking_budget: 0` and
    // `max_tokens: 0` doesn't trip the check (the request would
    // be rejected anyway, but for max_tokens=0, not for the
    // budget).
    if (
      // Only the LEGACY enabled path sends `budget_tokens`; adaptive
      // models drop it (`anthropicThinkingParam`), so the
      // budget-vs-max_tokens cross-check is moot there — skip it. (Reasoning
      // replay only engages on ADAPTIVE models, so it never reaches this
      // legacy-only branch; no replay-specific carve-out is needed here.)
      caps.supports_adaptive_thinking !== true &&
      // Tools present ⇒ thinking is suppressed (`anthropicThinkingParam`), so no
      // `budget_tokens` leaves the binary and validating would reject a request
      // that's actually valid — restrict the check to no-tool turns.
      (req.tools === undefined || req.tools.length === 0) &&
      req.thinking_budget !== undefined &&
      req.thinking_budget > 0 &&
      req.thinking_budget >= req.max_tokens
    ) {
      throw new Error(
        `anthropic request: 'thinking_budget' (${req.thinking_budget}) must be strictly less than 'max_tokens' (${req.max_tokens}) — Anthropic API rejects equal or greater with HTTP 400. The runtime resolved max_tokens against the provider capability ceiling (capabilities.output_max_tokens=${caps.output_max_tokens}); raise the playbook's 'sampling.max_tokens' or lower 'sampling.thinking_budget'.`,
      );
    }
    // Extended thinking is suppressed on tool-bearing turns
    // (`anthropicThinkingParam`). Tell the operator once why a configured
    // `thinking_budget` produced no thinking, so it doesn't read as a silent
    // no-op — the budget is honored only on no-tool turns until the
    // thinking-block signature round-trip lands.
    if (
      !reasoningReplay &&
      !warnedThinkingSuppressedByTools &&
      req.thinking_budget !== undefined &&
      req.thinking_budget > 0 &&
      req.tools !== undefined &&
      req.tools.length > 0
    ) {
      warnedThinkingSuppressedByTools = true;
      process.stderr.write(
        `forja: extended thinking suppressed on tool-bearing turns (thinking_budget=${req.thinking_budget}); Anthropic requires replaying the thinking-block signature with tool_results, which Forja does not yet round-trip. Scope thinking_budget to a tool-less playbook for it to take effect.\n`,
      );
    }
    // Some frontier models (e.g. Opus 4.7) deprecated `temperature`
    // and `top_p` at the API; sending either returns HTTP 400.
    // The capability flag opts those models out — adapter strips
    // both before send. Default (cap omitted ⇒ `true`) keeps every
    // other Claude model accepting the canonical TOKEN_TUNING §9
    // values unchanged.
    const acceptsSampling = caps.supports_sampling !== false;
    // Extended thinking — adaptive vs legacy manual budget, gated by capability.
    // See `anthropicThinkingParam`. Computed first because it decides sampling:
    // Anthropic REJECTS `thinking` sent together with a `temperature`/`top_p`
    // override (HTTP 400) on models that accept sampling (e.g. Sonnet 4.6). Opus
    // 4.7/4.8 already strip sampling via `acceptsSampling`, but a sampling-capable
    // adaptive model with a thinking_budget + a configured temperature (an eval's
    // default temperature:0, or a Sonnet session with reasoning replay on) would
    // otherwise send both and 400. So whenever thinking is engaged, drop sampling.
    const thinkingParam = anthropicThinkingParam(req, caps, reasoningReplay, thinkingDefaultOn);
    const thinkingEngaged = 'thinking' in thinkingParam;
    const stream = client.messages.stream({
      model: modelName,
      max_tokens: req.max_tokens,
      messages: cachedMessages,
      ...(cachedSystem !== undefined ? { system: cachedSystem } : {}),
      ...(cachedTools !== undefined ? { tools: cachedTools } : {}),
      ...samplingParams(req, acceptsSampling && !thinkingEngaged),
      ...thinkingParam,
      // Agnostic reasoning effort (TOKEN_TUNING.md §4). Anthropic's native
      // `output_config.effort` maps via `anthropicEffort`, which clamps `xhigh`
      // (Opus 4.7/4.8 only) down to `high` where unsupported to avoid a 400.
      // Affects text, tool calls, and — when adaptive thinking is engaged above
      // — thinking depth. Gated on the capability: not every model exposes it.
      ...(req.effort !== undefined && caps.supports_reasoning_effort === true
        ? {
            output_config: {
              effort: anthropicEffort(req.effort, caps.supports_effort_xhigh === true),
            },
          }
        : {}),
      ...(req.stop_sequences !== undefined ? { stop_sequences: req.stop_sequences } : {}),
      // `seed_in_eval` is intentionally NOT forwarded here. The
      // Anthropic Messages API does not expose a seed surface
      // (as of the SDK pinned in package.json); the field stays
      // present on GenerateRequest for cross-provider intent,
      // and OpenAI / Google translate to their respective seed
      // params. When Anthropic ships a seed, this is the single
      // site to wire it.
      // metadata is intentionally not forwarded in M1: the SDK's MetadataParam
      // shape (`{ user_id?: string | null }`) is narrower than our generic
      // Record<string,string>; the harness will pass user identity through a
      // dedicated channel when telemetry needs it.
    });
    yield* normalizeAnthropicStream(stream as AsyncIterable<RawAnthropicEvent>);
  };

  return {
    id: `anthropic/${modelName}`,
    family: 'anthropic',
    capabilities: effectiveCaps,
    replaysReasoning: reasoningReplay,
    generate,
    generateConstrained: async (req: ConstrainedRequest): Promise<ConstrainedResult> => {
      // Anthropic's structured-output surface is forced tool calling:
      // declare ONE tool whose `input_schema` is the desired JSON
      // shape, set `tool_choice: {type:'tool', name}`, and the model
      // is required to emit exactly one `tool_use` block whose `input`
      // satisfies the schema. We then stringify that input — the
      // caller (recap LLM render path) parses + validates against the
      // same schema, so a misbehaving model still gets caught at the
      // boundary.
      //
      // Why we forbid `req.tools`:
      // ConstrainedRequest extends GenerateRequest, which carries a
      // `tools` field for the unconstrained path. Mixing user-supplied
      // tools with the forced schema tool would let the model pick a
      // different tool, defeating the schema-binding intent. Reject
      // up-front so that mistake surfaces at the call site, not as a
      // mysteriously-missing tool_use.
      if (req.tools !== undefined && req.tools.length > 0) {
        throw new Error(
          "anthropic generateConstrained: 'tools' must be empty (forced schema tool only)",
        );
      }
      // Thread the SAME `marker` as the streaming path so the constrained
      // (recap) call's cache writes use the operator's chosen TTL — and are
      // therefore billed at the rate `effectiveCaps` prices them with.
      // Omitting it here would tag these writes 5-min while costing them at
      // the 1h rate when the flag is on.
      const cachedSystem =
        req.systemSegments !== undefined
          ? systemSegmentsWithCacheBreakpoints(req.systemSegments, marker)
          : systemWithCacheBreakpoint(req.system, marker);
      const cachedMessages = messagesWithTailCacheBreakpoint(
        req.messages.map((m) => toAnthropicMessage(m, reasoningReplay)),
        marker,
      );
      const schemaTool: Anthropic.Tool = {
        name: req.output_schema_name,
        description:
          req.output_schema_description ??
          'Emit the structured output for the constrained request.',
        input_schema: req.output_schema as Anthropic.Tool.InputSchema,
      };
      const cachedTools = toolsWithCacheBreakpoint([schemaTool], marker);
      const breakpointCount = countCacheBreakpoints({
        system: cachedSystem,
        tools: cachedTools,
        messages: cachedMessages,
      });
      if (breakpointCount > MAX_CACHE_BREAKPOINTS_PER_REQUEST) {
        throw new Error(
          `anthropic constrained request exceeds the ${MAX_CACHE_BREAKPOINTS_PER_REQUEST}-breakpoint cache_control limit (${breakpointCount} markers); review src/providers/anthropic/cache.ts`,
        );
      }
      const response = await client.messages.create({
        model: modelName,
        max_tokens: req.max_tokens,
        messages: cachedMessages,
        tools: cachedTools,
        tool_choice: { type: 'tool', name: req.output_schema_name },
        ...(cachedSystem !== undefined ? { system: cachedSystem } : {}),
        // Same sampling handling as the streaming path — strip
        // wholesale when unsupported, and never send temperature +
        // top_p together (see `samplingParams`).
        ...samplingParams(req, caps.supports_sampling !== false),
        ...(req.stop_sequences !== undefined ? { stop_sequences: req.stop_sequences } : {}),
      });
      // Find the forced tool_use block. With `tool_choice` set to a
      // specific tool, Anthropic's contract is "exactly one tool_use
      // matching the requested name"; defending against the contract
      // breaking (older models, future API drift) means walking the
      // content array rather than indexing [0]. A missing block is a
      // hard error — the caller has no fallback at this layer.
      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use' && block.name === req.output_schema_name,
      );
      if (toolUse === undefined) {
        throw new Error(
          `anthropic constrained: model returned no tool_use for forced tool '${req.output_schema_name}'`,
        );
      }
      const usage: UsageInfo = {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cache_read: response.usage.cache_read_input_tokens ?? 0,
        cache_creation: response.usage.cache_creation_input_tokens ?? 0,
      };
      return {
        output: JSON.stringify(toolUse.input),
        usage,
      };
    },
    countTokens: async (messages: ProviderMessage[]): Promise<number> => {
      const response = await client.messages.countTokens({
        model: modelName,
        messages: messages.map((m) => toAnthropicMessage(m, reasoningReplay)),
      });
      return response.input_tokens;
    },
  };
};
