import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { stableStringify } from '../canonical-json.ts';
// Shared chars/4 heuristic — see `src/providers/tokens.ts` for accuracy
// bounds. OpenAI has no server-side countTokens endpoint until tiktoken
// lands in M5.
import { OPENAI_REASONING_EFFORT } from '../effort.ts';
import { deriveSeedFromRequest } from '../seed.ts';
import { estimateMessagesTokens } from '../tokens.ts';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  GenerateRequest,
  Provider,
  ProviderCapabilities,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../types.ts';
import { OPENAI_CAPS } from './capabilities.ts';

// OpenAI reasoning effort, gated by capability. Chat Completions
// takes a FLAT `reasoning_effort` field — the nested `reasoning`
// object belongs to the Responses API, a DIFFERENT endpoint, and is
// rejected here with HTTP 400. Only reasoning models accept the
// param at all, so emit it strictly when the model declares support
// (non-reasoning models like gpt-4o 400 on it); otherwise omit. The
// agnostic level maps 1:1 except `max`→`xhigh` (the API's ceiling).
export const openaiReasoningParam = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): { reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' } =>
  req.effort !== undefined && caps.supports_reasoning_effort === true
    ? { reasoning_effort: OPENAI_REASONING_EFFORT[req.effort] }
    : {};
import { type RawOpenAIChunk, normalizeOpenAIStream } from './stream.ts';

export interface CreateOpenAIProviderOptions {
  apiKey?: string;
  // Useful for OpenAI-compatible endpoints (Azure OpenAI, OpenRouter, etc.).
  baseURL?: string;
  // Inject a pre-built SDK client (test seam).
  client?: OpenAI;
  // Send `stream_options: { include_usage: true }` so the final chunk
  // carries token counts. OpenAI itself supports this since 2024; some
  // OpenAI-compatible endpoints (older Azure deployments, certain proxies)
  // reject unknown params with HTTP 400. Set this to `false` if you hit
  // that — cost tracking will report zeros, but the run will succeed.
  // When omitted, falls back to the FORJA_OPENAI_INCLUDE_USAGE env var
  // so users on the CLI path (where the registry factory is invoked
  // with no options) can still opt out without code changes.
  includeUsage?: boolean;
}

// OpenAI `prompt_cache_key` (cache routing): requests sharing this key are
// routed to the same backend, raising the automatic prefix-cache hit rate
// (OpenAI's documented lever). Key off the STABLE prefix — system + tools —
// so every turn of a session, and any other session with the same prefix,
// routes together; that prefix is exactly what OpenAI caches. Stable across
// turns (system/tools don't change within a session) and order-independent
// (stableStringify on the tool list). One sha256 per request; cheap.
export const openaiPromptCacheKey = (req: GenerateRequest): string =>
  createHash('sha256')
    .update(req.system ?? '')
    .update(stableStringify(req.tools ?? []))
    .digest('hex');

// Resolve the `includeUsage` default from the environment for callers
// who don't pass an explicit option (notably the registry factory used
// by the CLI bootstrap, which forwards no options today). Truthy by
// default; recognized falsy strings disable the param.
const includeUsageFromEnv = (): boolean => {
  const v = process.env.FORJA_OPENAI_INCLUDE_USAGE;
  if (v === undefined || v === '') return true;
  const norm = v.toLowerCase();
  return !(norm === '0' || norm === 'false' || norm === 'no' || norm === 'off');
};

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// One ProviderMessage may map to several OpenAI messages: assistant turns
// with tool_use blocks become an assistant message + tool_use, and user
// turns containing tool_result blocks split into one `role: 'tool'`
// message per result. OpenAI requires tool results to be their own
// messages, not nested in user content.
//
// Ordering matters: when a user message mixes tool_results and text, the
// tool_results come first (they answer the prior assistant call) and the
// new user text follows. Emitting text first would make the model see a
// new user prompt before the tool results it requested.
const toOpenAIMessages = (m: ProviderMessage): OpenAIMessage[] => {
  if (typeof m.content === 'string') {
    return [{ role: m.role, content: m.content }];
  }

  const out: OpenAIMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const toolResults: OpenAIMessage[] = [];

  for (const block of m.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (m.role !== 'assistant') {
        throw new Error('tool_use blocks must appear on assistant messages');
      }
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    } else {
      // tool_result
      if (m.role !== 'user') {
        throw new Error('tool_result blocks must appear on user messages');
      }
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: block.content,
      });
    }
  }

  // Tool results come first so they read as the answer to the prior
  // assistant turn, not as something the user volunteered after speaking.
  out.push(...toolResults);

  if (m.role === 'assistant') {
    const content = textParts.length > 0 ? textParts.join('') : null;
    if (content !== null || toolCalls.length > 0) {
      const msg: OpenAIMessage = { role: 'assistant', content };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  } else if (textParts.length > 0) {
    out.push({ role: 'user', content: textParts.join('') });
  }

  return out;
};

const toOpenAITools = (
  tools: ProviderToolDef[],
): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> =>
  tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

export const createOpenAIProvider = (
  modelName: string,
  options: CreateOpenAIProviderOptions = {},
): Provider => {
  const caps = OPENAI_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(`unknown OpenAI model: ${modelName}`);
  }

  let client: OpenAI;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('OpenAI API key required (pass options.apiKey or set OPENAI_API_KEY)');
    }
    const sdkOpts: { apiKey: string; baseURL?: string } = { apiKey };
    if (options.baseURL !== undefined) sdkOpts.baseURL = options.baseURL;
    client = new OpenAI(sdkOpts);
  }

  const includeUsage = options.includeUsage ?? includeUsageFromEnv();

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    const messages: OpenAIMessage[] = [];
    if (req.system !== undefined) {
      messages.push({ role: 'system', content: req.system });
    }
    for (const m of req.messages) {
      messages.push(...toOpenAIMessages(m));
    }

    const params: Record<string, unknown> = {
      model: modelName,
      messages,
      stream: true,
      max_tokens: req.max_tokens,
    };
    if (includeUsage) {
      // Opt into the final-chunk usage payload so we can compute cost.
      // Documented as configurable in CreateOpenAIProviderOptions because
      // some compat endpoints reject the param outright.
      params.stream_options = { include_usage: true };
    }
    if (req.tools !== undefined) params.tools = toOpenAITools(req.tools);
    // Cache-routing hint — only to real OpenAI. A custom baseURL signals an
    // OpenAI-compatible endpoint (Azure / OpenRouter / proxy) that may reject
    // the unknown param with HTTP 400 (same caution as stream_options above);
    // those endpoints have their own caching, if any, and lose nothing here.
    if (options.baseURL === undefined) {
      params.prompt_cache_key = openaiPromptCacheKey(req);
    }
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.top_p !== undefined) params.top_p = req.top_p;
    // Determinism intent (`PLAYBOOKS.md` §1.1
    // `sampling.seed_in_eval`). OpenAI's `seed` param is
    // best-effort but documented as the canonical reproducibility
    // surface for the Chat Completions API. Derive a stable
    // 32-bit seed from the request's system + messages so
    // replays of the same conversation get the same seed AND
    // step N differs from step N+1 within a run (each step's
    // message history is longer / different).
    if (req.seed_in_eval === true) params.seed = deriveSeedFromRequest(req);
    // Reasoning effort (TOKEN_TUNING.md §4.2). Flat `reasoning_effort`,
    // gated on capability — see `openaiReasoningParam`. The legacy
    // numeric `thinking_budget` is still intentionally NOT forwarded:
    // a token count doesn't map onto the coarse effort string, and
    // `effort` is the canonical reasoning control now.
    Object.assign(params, openaiReasoningParam(req, caps));
    if (req.stop_sequences !== undefined) params.stop = req.stop_sequences;

    const stream = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0],
    )) as AsyncIterable<RawOpenAIChunk>;
    yield* normalizeOpenAIStream(stream);
  };

  return {
    id: `openai/${modelName}`,
    family: 'openai',
    capabilities: caps,
    generate,
    generateConstrained: (_req: ConstrainedRequest): Promise<ConstrainedResult> =>
      Promise.reject(new Error('generateConstrained not implemented for OpenAI in M4.2')),
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(estimateMessagesTokens(messages)),
  };
};
