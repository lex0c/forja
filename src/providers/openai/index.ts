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
import { generateConstrainedViaResponses, generateViaResponses } from './responses.ts';
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

// OpenAI extended prompt-cache retention (`prompt_cache_retention: '24h'`):
// keep the cached prefix warm for up to 24h instead of the 5–10min in-memory
// default, so a session's later turns still hit the cache after idle gaps —
// parity with Anthropic's longer cache TTL. Only set on models that support it
// (capability `extended_prompt_cache`) and on real OpenAI. Default ON; the env
// var opts out for ZDR / data-residency-conscious users (the 24h policy may
// offload key/value tensors to GPU-local storage) or compat endpoints that
// 400 on the param: `in_memory` / `off` / `0` / `false` → disabled.
const promptCacheRetentionFromEnv = (): '24h' | undefined => {
  const v = process.env.FORJA_OPENAI_PROMPT_CACHE_RETENTION;
  if (v === undefined || v === '') return '24h';
  const norm = v.toLowerCase();
  return norm === 'in_memory' || norm === 'off' || norm === '0' || norm === 'false'
    ? undefined
    : '24h';
};

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
  // Extended prompt-cache retention, resolved once: only on real OpenAI (a
  // custom baseURL may 400 on the param) and only for models whose capability
  // advertises support. Undefined → the param is omitted entirely.
  const promptCacheRetention =
    options.baseURL === undefined && caps.extended_prompt_cache === true
      ? promptCacheRetentionFromEnv()
      : undefined;
  // Sampling gate (mirrors the Anthropic adapter). Reasoning models —
  // OpenAI's o-series and gpt-5.x — REJECT `temperature`/`top_p` with HTTP
  // 400 ("Unsupported parameter"). The capability opts those models out
  // (`supports_sampling: false`); every other model keeps the canonical
  // sampling surface. Applies to both the streaming and constrained paths.
  const acceptsSampling = caps.supports_sampling !== false;
  // The output-cap field name. Reasoning models (o-series, gpt-5.x) REJECT
  // the legacy `max_tokens` and require `max_completion_tokens`; non-reasoning
  // models (gpt-4o) still accept `max_tokens`. The reasoning capability is the
  // proxy — it's exactly the set that renamed the field.
  const maxTokensField =
    caps.supports_reasoning_effort === true ? 'max_completion_tokens' : 'max_tokens';

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
      [maxTokensField]: req.max_tokens,
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
    if (promptCacheRetention !== undefined) params.prompt_cache_retention = promptCacheRetention;
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;
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

  // Structured output via FORCED tool calling, mirroring the Anthropic path
  // (anthropic/index.ts generateConstrained): declare ONE function tool whose
  // parameters are the desired JSON schema, force it with `tool_choice`, and
  // read the model's tool-call arguments — already a JSON string. Forced tool
  // calling, NOT strict `response_format: {type:'json_schema'}`, for leniency:
  // strict json_schema rejects schemas that aren't fully strict (every field
  // required, additionalProperties:false), which the recap schemas are not.
  // Single round-trip (non-streaming), like the recap render path expects.
  const generateConstrained = async (req: ConstrainedRequest): Promise<ConstrainedResult> => {
    // Same guard as Anthropic: caller tools would let the model pick a
    // different tool and defeat the schema binding. Reject up-front.
    if (req.tools !== undefined && req.tools.length > 0) {
      throw new Error(
        "openai generateConstrained: 'tools' must be empty (forced schema tool only)",
      );
    }
    const messages: OpenAIMessage[] = [];
    if (req.system !== undefined) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(...toOpenAIMessages(m));

    const params: Record<string, unknown> = {
      model: modelName,
      messages,
      [maxTokensField]: req.max_tokens,
      tools: [
        {
          type: 'function',
          function: {
            name: req.output_schema_name,
            description:
              req.output_schema_description ??
              'Emit the structured output for the constrained request.',
            parameters: req.output_schema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: req.output_schema_name } },
    };
    // Cache-routing hint — real OpenAI only (a custom baseURL may 400 on it).
    if (options.baseURL === undefined) params.prompt_cache_key = openaiPromptCacheKey(req);
    if (promptCacheRetention !== undefined) params.prompt_cache_retention = promptCacheRetention;
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;

    const response = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0],
    )) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } | null;
    };

    // With a named-function `tool_choice`, OpenAI returns exactly one matching
    // tool_call. Walk defensively (don't index [0]); a miss is a hard error —
    // the caller (recap render) has no fallback at this layer. Surface the
    // `finish_reason` so the common causes are diagnosable rather than hidden
    // behind a generic message: `length` = ran out of max_tokens before the
    // call, `content_filter` = the response was blocked.
    const toolCall = response.choices?.[0]?.message?.tool_calls?.find(
      (c) => c.function?.name === req.output_schema_name,
    );
    if (toolCall?.function?.arguments === undefined) {
      const finish = response.choices?.[0]?.finish_reason ?? 'unknown';
      throw new Error(
        `openai constrained: model returned no tool_call for forced tool '${req.output_schema_name}' (finish_reason=${finish})`,
      );
    }
    // Usage convention MATCHES the streaming path (openai/stream.ts): OpenAI's
    // prompt_tokens INCLUDES cached, so input = prompt − cached; cache_read =
    // cached; OpenAI reports no cache-write, so cache_creation = 0.
    const u = response.usage;
    const prompt = u?.prompt_tokens ?? 0;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      output: toolCall.function.arguments,
      usage: {
        input: Math.max(0, prompt - cached),
        output: u?.completion_tokens ?? 0,
        cache_read: cached,
        cache_creation: 0,
      },
    };
  };

  // Reasoning models (gpt-5.x) route through the Responses API: Chat
  // Completions 400s on tools+reasoning_effort for them. gpt-4o and other
  // non-reasoning models stay on the Chat Completions path above. Decided per
  // model (the capability), not per request.
  const useResponses = caps.supports_reasoning_effort === true;
  // Cache-routing hint for the Responses path — same lever the Chat Completions
  // path uses, gated on a real-OpenAI baseURL (a custom endpoint may 400 on the
  // unknown param). Computed here so responses.ts needn't import back into this
  // module (cycle) and the baseURL gate stays in one place.
  const responsesCacheKey = (req: GenerateRequest | ConstrainedRequest): string | undefined =>
    options.baseURL === undefined ? openaiPromptCacheKey(req) : undefined;

  return {
    id: `openai/${modelName}`,
    family: 'openai',
    capabilities: caps,
    generate: useResponses
      ? (req: GenerateRequest) =>
          generateViaResponses(
            client,
            modelName,
            caps,
            req,
            responsesCacheKey(req),
            promptCacheRetention,
          )
      : generate,
    generateConstrained: useResponses
      ? (req: ConstrainedRequest) =>
          generateConstrainedViaResponses(
            client,
            modelName,
            caps,
            req,
            responsesCacheKey(req),
            promptCacheRetention,
          )
      : generateConstrained,
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(estimateMessagesTokens(messages)),
  };
};
