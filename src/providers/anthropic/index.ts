import Anthropic from '@anthropic-ai/sdk';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  GenerateRequest,
  Provider,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
  UsageInfo,
} from '../types.ts';
import {
  MAX_CACHE_BREAKPOINTS_PER_REQUEST,
  countCacheBreakpoints,
  messagesWithTailCacheBreakpoint,
  systemWithCacheBreakpoint,
  toolsWithCacheBreakpoint,
} from './cache.ts';
import { ANTHROPIC_CAPS } from './capabilities.ts';
import { type RawAnthropicEvent, normalizeAnthropicStream } from './stream.ts';

export interface CreateAnthropicProviderOptions {
  apiKey?: string;
  // Inject a pre-built SDK client (test seam).
  client?: Anthropic;
}

// Strip `name` from tool_result blocks. Our canonical
// ProviderToolResultBlock keeps `name` as optional metadata for
// Gemini (which correlates results to calls by name). Anthropic
// only accepts `tool_use_id`/`content`/`is_error` and 400s with
// `Extra inputs are not permitted` if `name` leaks through.
const stripToolResultName = (block: ProviderContentBlock): ProviderContentBlock => {
  if (block.type !== 'tool_result') return block;
  const cleaned: ProviderContentBlock = {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
  };
  if (block.is_error !== undefined) cleaned.is_error = block.is_error;
  return cleaned;
};

const toAnthropicMessage = (
  m: ProviderMessage,
): { role: ProviderMessage['role']; content: ProviderMessage['content'] } => ({
  role: m.role,
  content: typeof m.content === 'string' ? m.content : m.content.map(stripToolResultName),
});

const toAnthropicTool = (t: ProviderToolDef): Anthropic.Tool => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
});

export const createAnthropicProvider = (
  modelName: string,
  options: CreateAnthropicProviderOptions = {},
): Provider => {
  const caps = ANTHROPIC_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(`unknown Anthropic model: ${modelName}`);
  }

  let client: Anthropic;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('Anthropic API key required (pass options.apiKey or set ANTHROPIC_API_KEY)');
    }
    client = new Anthropic({ apiKey });
  }

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    // The SDK's typed `messages.stream({...})` accepts our shape directly;
    // we cast the returned async iterable to the local minimal event type
    // (structural compatibility — the SDK's events are a superset).
    //
    // Cache breakpoints (CONTEXT_TUNING.md §3.1, PROVIDERS.md §3.1):
    // anchors are placed on (a) the system block, (b) the last tool,
    // and (c) the last message's last content block. See
    // `./cache.ts` for the full strategy and the gap to four
    // breakpoints (the [project_context] / [memory_index] split).
    const cachedSystem = systemWithCacheBreakpoint(req.system);
    const cachedTools =
      req.tools !== undefined
        ? toolsWithCacheBreakpoint(req.tools.map(toAnthropicTool))
        : undefined;
    const cachedMessages = messagesWithTailCacheBreakpoint(req.messages.map(toAnthropicMessage));
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
      req.thinking_budget !== undefined &&
      req.thinking_budget > 0 &&
      req.thinking_budget >= req.max_tokens
    ) {
      throw new Error(
        `anthropic request: 'thinking_budget' (${req.thinking_budget}) must be strictly less than 'max_tokens' (${req.max_tokens}) — Anthropic API rejects equal or greater with HTTP 400. The runtime resolved max_tokens against the provider capability ceiling (capabilities.output_max_tokens=${caps.output_max_tokens}); raise the playbook's 'sampling.max_tokens' or lower 'sampling.thinking_budget'.`,
      );
    }
    // Some frontier models (e.g. Opus 4.7) deprecated `temperature`
    // and `top_p` at the API; sending either returns HTTP 400.
    // The capability flag opts those models out — adapter strips
    // both before send. Default (cap omitted ⇒ `true`) keeps every
    // other Claude model accepting the canonical TOKEN_TUNING §9
    // values unchanged.
    const acceptsSampling = caps.supports_sampling !== false;
    const stream = client.messages.stream({
      model: modelName,
      max_tokens: req.max_tokens,
      messages: cachedMessages,
      ...(cachedSystem !== undefined ? { system: cachedSystem } : {}),
      ...(cachedTools !== undefined ? { tools: cachedTools } : {}),
      ...(acceptsSampling && req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(acceptsSampling && req.top_p !== undefined ? { top_p: req.top_p } : {}),
      // Extended thinking (`PLAYBOOKS.md` §1.1
      // `sampling.thinking_budget`). Anthropic's surface is
      // `thinking: { type:'enabled', budget_tokens }`; budget=0
      // disables, which the SDK shape encodes as omitting the
      // block entirely. We mirror that by gating the spread on
      // `> 0` — passing `budget_tokens: 0` would be rejected by
      // the API, so the disable-via-zero idiom (PLAYBOOKS.md §1.1)
      // collapses to "no `thinking` field on the request".
      ...(req.thinking_budget !== undefined && req.thinking_budget > 0
        ? { thinking: { type: 'enabled' as const, budget_tokens: req.thinking_budget } }
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
    capabilities: caps,
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
      const cachedSystem = systemWithCacheBreakpoint(req.system);
      const cachedMessages = messagesWithTailCacheBreakpoint(req.messages.map(toAnthropicMessage));
      const schemaTool: Anthropic.Tool = {
        name: req.output_schema_name,
        description:
          req.output_schema_description ??
          'Emit the structured output for the constrained request.',
        input_schema: req.output_schema as Anthropic.Tool.InputSchema,
      };
      const cachedTools = toolsWithCacheBreakpoint([schemaTool]);
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
        // Same sampling-deprecation gate as the streaming path —
        // see comment there for rationale.
        ...(caps.supports_sampling !== false && req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
        ...(caps.supports_sampling !== false && req.top_p !== undefined
          ? { top_p: req.top_p }
          : {}),
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
        messages: messages.map(toAnthropicMessage),
      });
      return response.input_tokens;
    },
  };
};
