import OpenAI from 'openai';
import { boolFromEnv } from '../env.ts';
import { toOpenAITools } from '../openai/index.ts';
import { deriveSeedFromRequest } from '../seed.ts';
import { estimateMessagesTokens } from '../tokens.ts';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  GenerateRequest,
  Provider,
  ProviderCapabilities,
  ProviderMessage,
  StreamEvent,
} from '../types.ts';
import { OPENROUTER_CAPS } from './capabilities.ts';
import { buildReasoningParam, toOpenRouterMessages } from './messages.ts';
import { type RawORChunk, normalizeOpenRouterStream } from './stream.ts';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CreateOpenRouterProviderOptions {
  apiKey?: string;
  // OpenRouter's endpoint; overridable for a proxy. Falls back to the canonical
  // base URL (the catalog can also pin it per entry via base_url).
  baseURL?: string;
  // Inject a pre-built SDK client (test seam).
  client?: OpenAI;
  // Override capabilities — supplied by the catalog-file loader for an
  // operator-registered model; otherwise resolved from OPENROUTER_CAPS.
  capabilities?: ProviderCapabilities;
}

// Optional attribution headers (OpenRouter rankings). Omitted when unset — they
// are never required for a request to work. Read from the env so they reach the
// registry factory (invoked with no options on the CLI path).
const attributionHeaders = (): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  const referer = process.env.FORJA_OPENROUTER_REFERER;
  const title = process.env.FORJA_OPENROUTER_TITLE;
  if (referer !== undefined && referer.length > 0) out['HTTP-Referer'] = referer;
  if (title !== undefined && title.length > 0) out['X-Title'] = title;
  return Object.keys(out).length > 0 ? out : undefined;
};

export const createOpenRouterProvider = (
  modelName: string,
  options: CreateOpenRouterProviderOptions = {},
): Provider => {
  const caps = options.capabilities ?? OPENROUTER_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(
      `unknown OpenRouter model: ${modelName} (pass options.capabilities or add it to OPENROUTER_CAPS)`,
    );
  }

  let client: OpenAI;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'OpenRouter API key required (pass options.apiKey; the catalog provides it from the model api_key_env in model_providers.json — no env fallback)',
      );
    }
    const headers = attributionHeaders();
    const sdkOpts: { apiKey: string; baseURL: string; defaultHeaders?: Record<string, string> } = {
      apiKey,
      baseURL: options.baseURL ?? DEFAULT_OPENROUTER_BASE_URL,
    };
    if (headers !== undefined) sdkOpts.defaultHeaders = headers;
    client = new OpenAI(sdkOpts);
  }

  // Reasoning replay round-trips the model's reasoning_details on tool follow-ups
  // (OpenRouter's documented continuity mechanism). Gated on the model's reasoning
  // surface; FORJA_OPENROUTER_REASONING_REPLAY=0 opts out.
  const reasoningReplay =
    caps.supports_reasoning_effort === true &&
    boolFromEnv('FORJA_OPENROUTER_REASONING_REPLAY', true);
  // Reasoning models often reject sampling params; OpenRouter silently drops
  // unsupported params anyway, but we still honor an explicit opt-out.
  const acceptsSampling = caps.supports_sampling !== false;
  // Explicit prompt-cache breakpoints (qwen-style). When set, the system prompt
  // is sent as structured blocks with cache_control markers on the stable
  // segments; otherwise it stays a flat string (automatic/no cache).
  const explicitCache = caps.cache_explicit_breakpoints === true;

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    const params: Record<string, unknown> = {
      model: modelName,
      messages: toOpenRouterMessages(req, reasoningReplay, explicitCache),
      stream: true,
      // OpenRouter accepts max_tokens on every model (unlike OpenAI's native
      // reasoning models, which require max_completion_tokens).
      max_tokens: req.max_tokens,
      // Disable middle-out compression (on by default for <=8k endpoints) so the
      // Forja context engine is the sole authority on truncation — no silent
      // mid-prompt drops (same premise as the Ollama served-window fix).
      transforms: [],
      // Force the final usage chunk. OpenRouter documents usage as always-on now
      // (the legacy include flags are no-ops), but sending it is a harmless no-op
      // that guarantees cost telemetry even on a route that doesn't auto-emit it.
      usage: { include: true },
    };
    if (req.tools !== undefined) params.tools = toOpenAITools(req.tools);
    const reasoning = buildReasoningParam(req, caps);
    if (reasoning !== undefined) params.reasoning = reasoning;
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;
    if (req.seed_in_eval === true) params.seed = deriveSeedFromRequest(req);
    if (req.stop_sequences !== undefined) params.stop = req.stop_sequences;

    const stream = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0],
    )) as unknown as AsyncIterable<RawORChunk>;
    yield* normalizeOpenRouterStream(stream);
  };

  // Structured output via FORCED tool calling (mirrors the OpenAI adapter): one
  // function tool whose parameters are the schema, forced with tool_choice. More
  // lenient than response_format:json_schema (which rejects non-strict schemas).
  const generateConstrained = async (req: ConstrainedRequest): Promise<ConstrainedResult> => {
    if (req.tools !== undefined && req.tools.length > 0) {
      throw new Error(
        "openrouter generateConstrained: 'tools' must be empty (forced schema tool only)",
      );
    }
    const params: Record<string, unknown> = {
      model: modelName,
      messages: toOpenRouterMessages(req, reasoningReplay, explicitCache),
      max_tokens: req.max_tokens,
      transforms: [],
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
        prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      } | null;
    };

    const toolCall = response.choices?.[0]?.message?.tool_calls?.find(
      (c) => c.function?.name === req.output_schema_name,
    );
    if (toolCall?.function?.arguments === undefined) {
      const finish = response.choices?.[0]?.finish_reason ?? 'unknown';
      throw new Error(
        `openrouter constrained: model returned no tool_call for forced tool '${req.output_schema_name}' (finish_reason=${finish})`,
      );
    }
    const u = response.usage;
    const prompt = u?.prompt_tokens ?? 0;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      output: toolCall.function.arguments,
      usage: {
        input: Math.max(0, prompt - cached),
        output: u?.completion_tokens ?? 0,
        cache_read: cached,
        cache_creation: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
      },
    };
  };

  return {
    id: `openrouter/${modelName}`,
    family: 'openrouter',
    capabilities: caps,
    replaysReasoning: reasoningReplay,
    generate,
    generateConstrained,
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(estimateMessagesTokens(messages, { countReasoning: reasoningReplay })),
  };
};
