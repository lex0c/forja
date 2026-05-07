import Anthropic from '@anthropic-ai/sdk';
import type {
  ConstrainedRequest,
  GenerateRequest,
  Provider,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
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
    const stream = client.messages.stream({
      model: modelName,
      max_tokens: req.max_tokens,
      messages: cachedMessages,
      ...(cachedSystem !== undefined ? { system: cachedSystem } : {}),
      ...(cachedTools !== undefined ? { tools: cachedTools } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
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
    generateConstrained: (_req: ConstrainedRequest): Promise<string> =>
      // For Anthropic this would map to forced tool_choice, but the M1
      // autonomous loop does not call constrained generation. Implemented
      // when the DAG executor (M6) needs it.
      Promise.reject(new Error('generateConstrained not implemented in M1')),
    countTokens: async (messages: ProviderMessage[]): Promise<number> => {
      const response = await client.messages.countTokens({
        model: modelName,
        messages: messages.map(toAnthropicMessage),
      });
      return response.input_tokens;
    },
  };
};
