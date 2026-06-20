// Canonical provider types per AGENTIC_CLI §14 and PROVIDERS.md §1.
//
// `sampling: SamplingSupport` from PROVIDERS.md §1 is intentionally omitted
// in M1 — it's coupled to TOKEN_TUNING.md §10, which is its own subsystem
// step. Will be added when that step lands.

export type ProviderFamily =
  | 'anthropic'
  | 'openai'
  | 'ollama'
  | 'llama_cpp'
  | 'google'
  | 'mistral'
  | 'openrouter';

export type ToolCallingMode = 'native' | 'adapted';
export type CacheMode = 'server_5min' | 'server_persistent' | 'client_only';
export type ConstrainedKind = 'gbnf' | 'json_mode' | 'tools' | 'regex';
export type PromptDialect = 'claude' | 'openai_chat' | 'llama3' | 'qwen' | 'deepseek';

// `model_context_window_exceeded`: on Claude 4.5+ models the API accepts a
// request whose input + max_tokens overflows the context window and, if
// generation then reaches the limit, stops with this reason instead of a
// validation error (earlier models need the `model-context-window-exceeded`
// beta header). Distinct from `max_tokens` (the per-call OUTPUT cap): here
// the whole window — input included — is exhausted, so the honest
// remediation is compaction / shorter input, not a bigger output cap.
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'model_context_window_exceeded';

export interface ProviderCapabilities {
  // Core features
  tools: ToolCallingMode | false;
  cache: CacheMode | false;
  vision: boolean;
  streaming: boolean;
  constrained: ConstrainedKind | false;

  // Limits
  context_window: number;
  output_max_tokens: number;

  // Hints (non-blocking)
  recommended_max_tools_per_step?: number;
  prompt_template_dialect?: PromptDialect;
  // The model supports an EXTENDED prompt-cache retention window (OpenAI's
  // `prompt_cache_retention: '24h'`), keeping a cached prefix warm for up to
  // 24h instead of the 5–10min in-memory default. Parity with Anthropic's 1h
  // cache TTL: a session's later turns still hit the cache after idle gaps.
  // Adapter-translated — only the OpenAI adapter reads it today; others omit.
  extended_prompt_cache?: boolean;
  // Among `extended_prompt_cache` models, this one accepts ONLY `24h` — the
  // `in_memory` retention value is rejected (OpenAI documents gpt-5.5 / 5.5-pro
  // / future models as 24h-only). The adapter uses this to NOT send the
  // `in_memory` data-residency opt-out to such a model (it would be an invalid
  // value); the opt-out can't be honored there and the adapter warns instead.
  // Absent/false on models that accept both 24h and in_memory (e.g. gpt-5.4).
  extended_prompt_cache_24h_only?: boolean;

  // Cost (USD per 1k tokens — values are illustrative per spec §5)
  cost_per_1k_input: number;
  cost_per_1k_output: number;
  cost_per_1k_cached_input?: number;
  // Cache-write rate for the DEFAULT 5-minute ephemeral cache (~1.25× input
  // on Anthropic). `cost_per_1k_cache_write_1h` is the 1-hour extended-cache
  // rate (~2× input); the Anthropic adapter swaps it into the effective
  // `cost_per_1k_cache_write` when the operator opts into the 1h TTL, so the
  // cost stays exact. Only providers with a distinct 1h tier set it.
  cost_per_1k_cache_write?: number;
  cost_per_1k_cache_write_1h?: number;
  // The model needs EXPLICIT `cache_control` breakpoints to cache its prompt
  // (Qwen/Anthropic-style), as opposed to automatic server-side caching. The
  // OpenRouter adapter reads this to emit cache_control markers on the stable
  // system segments; other adapters ignore it. Absent/false ⇒ automatic or no cache.
  cache_explicit_breakpoints?: boolean;

  // Whether the model accepts the `temperature` / `top_p` sampling
  // parameters at the API boundary. Vendors deprecate these on
  // newer frontier models (e.g. Anthropic's Opus 4.7 returns HTTP
  // 400 "temperature is deprecated for this model") — without this
  // gate every workflow that follows TOKEN_TUNING §9 (recap LLM
  // render and others) would 400 on those models. Adapters strip
  // both parameters before sending when this is `false`. Default
  // (omitted = `true`) keeps backward compat for every existing
  // model that still accepts the field.
  supports_sampling?: boolean;

  // Whether the model uses Anthropic-style ADAPTIVE thinking
  // (`thinking: { type: 'adaptive' }`) rather than the legacy
  // manual budget (`type: 'enabled', budget_tokens`). Newer
  // frontier models made adaptive the only mode and 400 on
  // `enabled` (Opus 4.7/4.8); deprecated `enabled` on Sonnet 4.6.
  // When true, the adapter engages thinking via adaptive and drops
  // `budget_tokens` (the model decides depth; `effort` guides it).
  // When false/omitted, the adapter keeps the manual budget path.
  // Provider-specific today (Anthropic); other families ignore it.
  supports_adaptive_thinking?: boolean;

  // Whether the model accepts a reasoning-EFFORT control surface
  // (the agnostic `GenerateRequest.effort`). Each adapter maps it to
  // its native surface only when this is true: Anthropic
  // `output_config.effort`, OpenAI flat `reasoning_effort`, Gemini
  // numeric `thinkingConfig.thinkingBudget`. False/omitted ⇒ the
  // adapter drops `effort` for that model — non-reasoning models
  // (e.g. OpenAI gpt-4o) and models that don't expose the surface
  // 400 on it, so emission must be gated. The operational-budget
  // axis of `/effort` still applies regardless; only the
  // provider-effort axis is gated here (best-effort per the
  // "request expresses intent, per-provider follows" convention).
  supports_reasoning_effort?: boolean;
  // The model produces reasoning to capture & replay but does NOT expose
  // effort-level selection (it has the generic reasoning toggle only). Distinct
  // from `supports_reasoning_effort`: the OpenRouter adapter replays these models'
  // reasoning and toggles them via `reasoning.enabled`, never sending an effort
  // level the model would reject. Adapters that don't model this ignore it.
  supports_reasoning?: boolean;
  // The model accepts the `xhigh` reasoning-effort level (between `high` and
  // `max`). Narrower than `max`: on Anthropic only Opus 4.7/4.8 expose it, so a
  // request for `xhigh` is clamped down to `high` when this is false/omitted, to
  // avoid a 400. OpenAI's reasoning models take `xhigh` natively (it's their top
  // level), so the OpenAI adapter doesn't consult this flag.
  supports_effort_xhigh?: boolean;

  // Ceiling for the numeric thinking budget (Gemini's
  // `thinkingConfig.thinkingBudget`), in tokens. Gemini 2.5 caps it
  // per model (Flash/Flash-Lite 24576, Pro 32768) and 400s above the
  // cap. The adapter clamps the resolved budget to this before send,
  // so a playbook's large legacy `sampling.thinking_budget` (the
  // loader allows big values for provider-specific handling) is fitted
  // rather than rejected. Omitted ⇒ no clamp (providers with no such
  // ceiling, or where the budget surface isn't numeric).
  max_thinking_budget?: number;

  // Operational
  max_rps?: number;
  notes: string[];
}

// One model entry as authored in the operator-owned catalog file
// (`~/.config/forja/model_providers.json`, AGENTIC_CLI §14.2). That
// file is the runtime source of truth; `CANONICAL_MODEL_PROVIDERS`
// (src/providers/seed-catalog.ts) is the embedded seed `forja init`
// writes into it. `family` must be one Forja ships an adapter for
// (anthropic/openai/ollama/google today; openrouter later); the
// catalog loader skips entries with an unknown family fail-soft.
export interface ModelProviderEntry {
  // Canonical fully-qualified id, e.g. "anthropic/claude-opus-4-8".
  id: string;
  family: ProviderFamily;
  // What the underlying SDK sees, e.g. "claude-opus-4-8".
  model_name: string;
  // Name of the env var that holds the API key — NEVER the key
  // itself. Optional: Ollama-local needs none; when omitted the
  // adapter falls back to its own default env (OPENAI_API_KEY, …).
  api_key_env?: string;
  // Custom endpoint for Ollama-remote / OpenAI-compatible hosts.
  // Optional; omitted ⇒ the adapter's default base URL.
  base_url?: string;
  // Ollama-only: explicit num_ctx (the KV-cache window the daemon serves),
  // bypassing the DEFAULT_OLLAMA_NUM_CTX cap. That cap protects LOCAL VRAM;
  // a cloud/remote host (`base_url`) has none, so a cloud entry sets this to
  // its real window (e.g. 131072) instead of being clamped to 32K. Other
  // families ignore it. Omitted ⇒ the adapter's default cap applies.
  num_ctx?: number;
  capabilities: ProviderCapabilities;
}

// Per-turn token usage as reported by the provider. Adapters surface this
// once per turn (typically right before `stop`); not every provider exposes
// every field. `cache_read` / `cache_creation` are zero when the provider
// has no cache or the turn didn't touch one.
export interface UsageInfo {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

// Canonical stream event taxonomy. Adapters normalize provider-specific
// events into this single shape (CONTRACTS.md §4).
export type StreamEvent =
  | { kind: 'start'; message_id: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial_args: string }
  | { kind: 'tool_use_stop'; id: string; final_args: Record<string, unknown> }
  | { kind: 'thinking_delta'; text: string }
  // A captured, opaque reasoning artifact for the assistant turn (Anthropic
  // signed thinking block, OpenAI reasoning item). Emitted by the adapter at
  // reasoning-block stop; `thinking_delta` stays for live UI (orthogonal).
  // Collected into the assistant turn so it can be replayed next request.
  | { kind: 'reasoning'; provider: ProviderFamily; data: unknown }
  | { kind: 'usage'; usage: UsageInfo }
  | { kind: 'stop'; reason: StopReason }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

// Provider-level message shape. Distinct from storage's `Message`: this is
// what goes on the wire to a provider, not what we persist.
export type ProviderMessageRole = 'user' | 'assistant';

export interface ProviderTextBlock {
  type: 'text';
  text: string;
}

export interface ProviderToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  // Optional function name. Anthropic and OpenAI correlate tool results
  // back to their calls by id; Gemini correlates by name and has no
  // per-call id, so the harness populates this field for Gemini compat.
  // Other adapters can ignore it.
  name?: string;
  content: string;
  is_error?: boolean;
}

// Opaque, provider-specific reasoning state captured on an assistant turn and
// replayed verbatim on later requests so reasoning persists across tool
// round-trips (Anthropic thinking+signature, OpenAI reasoning items / codex
// phase). The harness treats `data` as a black box — only the owning adapter
// (matched by `provider`) reads it; foreign adapters DROP the block, mirroring
// the providers' own behavior (reasoning state is model-specific and a block
// replayed to a different model is dropped anyway). `data` is NEVER
// canonicalized/normalized — signatures must round-trip byte-identical.
export interface ProviderReasoningBlock {
  type: 'reasoning';
  provider: ProviderFamily;
  data: unknown;
}

export type ProviderContentBlock =
  | ProviderTextBlock
  | ProviderToolUseBlock
  | ProviderToolResultBlock
  | ProviderReasoningBlock;

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string | ProviderContentBlock[];
}

// Tool input schemas must declare `type: 'object'` to be accepted by both
// Anthropic and OpenAI tool calling. Anything else is a malformed schema.
export interface ProviderToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [k: string]: unknown;
}

export interface ProviderToolDef {
  name: string;
  description: string;
  input_schema: ProviderToolInputSchema;
}

// One slice of the system prompt with its own cache-invalidation
// envelope. Adapters that support per-segment cache marking
// (Anthropic) honor `cacheBreakpoint: true` by emitting a
// `cache_control` marker after the segment. Adapters without
// per-segment caching (OpenAI, Google) flatten the array to a
// single string — see `flattenSystemSegments` below.
//
// Spec: CONTEXT_TUNING.md §3.1 declares 4 breakpoints in the
// system+prefix area; this type is the producer-side surface the
// Anthropic adapter consumes to anchor them.
export interface SystemSegment {
  // Diagnostic id — lets future cache-stats audit attribute
  // invalidation to a specific segment. Producer (bootstrap) and
  // consumer (anthropic cache) share the strings; extend the union
  // when a new segment type lands.
  id: 'stable' | 'memory';
  text: string;
  // When true, the adapter emits a cache breakpoint marker after
  // this segment. Other adapters ignore the flag.
  cacheBreakpoint?: boolean;
}

// Flatten a SystemSegment[] back into the concatenated string form
// other providers (OpenAI, Google) and the audit/hash path require.
// Joins with the same `\n\n` separator `composeSystemPrompt` uses
// when fusing sections so adapters reading the string see identical
// content to the Anthropic adapter reading the segments.
export const flattenSystemSegments = (segments: SystemSegment[]): string =>
  segments
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join('\n\n');

// Agnostic reasoning-effort level (TOKEN_TUNING.md §4). One
// vocabulary the whole stack speaks; each adapter translates it to
// its native surface (`src/providers/effort.ts`). Ordered low < medium
// < high < xhigh < max. `xhigh` is the documented sweet spot for
// coding/agentic work on the frontier models (the level Claude Code
// defaults to); `max` is the ceiling. Not every model exposes every
// level — `xhigh` in particular is narrower than `max` on Anthropic
// (Opus 4.7/4.8 only), so adapters clamp it down where unsupported
// (see `supports_effort_xhigh`). OpenAI maps both `xhigh` and `max`
// onto its native top, `xhigh`.
export type ProviderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateRequest {
  model: string;
  system?: string;
  // Optional structured form. When set, adapters that support
  // per-segment cache marking use it; others fall back to `system`.
  // Producer MUST set both when emitting segments — `system` is the
  // canonical string for hash/audit, `systemSegments` is the
  // adapter-side cache hint. `flattenSystemSegments(systemSegments)`
  // must equal `system` (asserted in tests).
  systemSegments?: SystemSegment[];
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  max_tokens: number;
  temperature?: number;
  // Nucleus sampling (`PLAYBOOKS.md` §1.1, `TOKEN_TUNING.md`).
  // Range (0, 1]. When unset each provider applies its own default.
  // Anthropic, OpenAI, Google all consume `top_p`; an adapter that
  // does not support it drops the field silently — the request
  // contract here is "express intent", per-provider best-effort
  // is the convention this surface follows.
  top_p?: number;
  // Extended-thinking budget in tokens (`PLAYBOOKS.md` §1.1). 0
  // explicitly disables; positive integers cap the model's
  // hidden reasoning. Only Anthropic exposes a dedicated
  // budget surface today (`thinking: { type:'enabled',
  // budget_tokens }`); OpenAI's `reasoning.effort` is a
  // different shape (low/medium/high) and Google's
  // `thinking_config.thinking_budget` accepts a token count.
  // Adapters that cannot map the field drop it; refusing
  // here would force every playbook to declare per-provider
  // sampling overrides, which the spec deliberately does not.
  thinking_budget?: number;
  // Agnostic reasoning-effort level (TOKEN_TUNING.md §4). Set from
  // the `/effort` slash command via `HarnessConfig.effort`. Each
  // adapter maps it to its native surface: Anthropic
  // `output_config.effort` (1:1), OpenAI `reasoning.effort`
  // (max→xhigh), numeric providers a thinking budget from the
  // canonical ladder (`src/providers/effort.ts`). Orthogonal to
  // `thinking_budget` (the legacy per-playbook numeric knob);
  // adapters that read both give `effort` precedence. Unset ⇒ the
  // provider applies its own default.
  effort?: ProviderEffort;
  // Determinism intent flag (`PLAYBOOKS.md` §1.1
  // `sampling.seed_in_eval`). When true, the playbook author
  // declared this run wants seeded generation for reproducibility
  // across replays. Providers that support seeding (OpenAI's
  // `seed`, Google's `seed`) read the flag and inject a
  // deterministic seed; adapters without seed surface today
  // (Anthropic) drop the field — same best-effort convention
  // `top_p` and `thinking_budget` follow.
  seed_in_eval?: boolean;
  stop_sequences?: string[];
  metadata?: Record<string, string>;
}

export interface ConstrainedRequest extends GenerateRequest {
  output_schema: Record<string, unknown>;
  // Schema label, used as the tool name on Anthropic / OpenAI tool
  // calling and as the response_format name on JSON-mode providers.
  // Must match `^[a-z][a-z0-9_]{0,63}$` to satisfy provider naming
  // rules; the recap renderer uses literal labels like 'render_recap_pr'.
  output_schema_name: string;
  // Free-form description of what the schema captures. Surfaced to
  // the provider as the tool description; helps the model pick the
  // right shape even with the tool forced. Optional — the constrained
  // call works without it but quality typically improves when set.
  output_schema_description?: string;
}

export interface ConstrainedResult {
  // Stringified JSON of the model's structured output. Caller is
  // responsible for `JSON.parse` + schema validation; the provider
  // guarantees only that the bytes came from a forced structured-
  // output channel (forced tool_use on Anthropic, response_format
  // on OpenAI, GBNF on llama.cpp), not that the JSON validates
  // against the supplied schema.
  output: string;
  // Per-call token usage. Distinct from the streaming `usage` event
  // because constrained generation is a single round-trip. Adapters
  // populate this from the same fields the streaming path reads.
  usage: UsageInfo;
}

export interface Provider {
  id: string;
  family: ProviderFamily;
  capabilities: ProviderCapabilities;
  // The catalog entry this provider was built from (stamped by
  // catalog-file `entryToFactory`). Provenance ONLY — never read on the
  // generate path. The subagent spawn path snapshots it onto
  // subagent_runs (migration 076) so a spawned child rebuilds the SAME
  // provider instead of re-reading a possibly-edited model_providers.json
  // (which would let a mid-session edit / `--force` re-sync make the
  // child reject session.model or diverge on base_url/capabilities).
  // Absent on providers built outside the catalog (test mocks /
  // providerOverride) — the child then falls back to re-reading the file.
  catalogEntry?: ModelProviderEntry;
  // Whether this provider instance replays reasoning blocks onto the wire
  // (resolved once in the factory from FORJA_*_REASONING_REPLAY + capability).
  // Consumers that size the outbound prompt (the compaction trigger, token
  // estimators) read it to decide whether replayed reasoning payloads count
  // against the context window. Omitted/false ⇒ reasoning is dropped at send.
  replaysReasoning?: boolean;
  generate(req: GenerateRequest): AsyncIterable<StreamEvent>;
  generateConstrained(req: ConstrainedRequest): Promise<ConstrainedResult>;
  countTokens(messages: ProviderMessage[]): Promise<number>;
}
