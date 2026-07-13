import OpenAI from 'openai';
import { XAI_REASONING_EFFORT } from '../effort.ts';
import {
  type OpenAIMessage,
  openaiPromptCacheKey,
  toOpenAIMessages,
  toOpenAITools,
} from '../openai/index.ts';
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
import { XAI_CAPS } from './capabilities.ts';
import { normalizeXaiStream, type RawXaiChunk } from './stream.ts';

// The native xAI API is an OpenAI-compatible Chat Completions endpoint. Reused
// via the OpenAI SDK with this base URL; the model divergences (flat
// `reasoning_effort`, `reasoning_content` deltas, always-on reasoning, `stop`
// rejected by reasoning models) are handled here, so it is its own family
// rather than an `openai` catalog entry — the OpenAI adapter forces reasoning
// models onto the Responses API (`useResponses`) and disables its cache/replay
// levers behind a custom baseURL, neither of which fits Grok.
export const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';

export interface CreateXaiProviderOptions {
  apiKey?: string;
  // xAI endpoint; overridable for a proxy. Falls back to the canonical base URL
  // (the catalog can also pin it per entry via base_url).
  baseURL?: string;
  // Inject a pre-built SDK client (test seam).
  client?: OpenAI;
  // Override capabilities — supplied by the catalog-file loader for an
  // operator-registered model; otherwise resolved from XAI_CAPS.
  capabilities?: ProviderCapabilities;
  // Send `stream_options: { include_usage: true }` so the final chunk carries
  // token counts. Native api.x.ai supports it, so the default is on; but a
  // proxy pinned via `baseURL` may reject the unknown param with HTTP 400 —
  // set this false there (cost telemetry reports zeros, but the run succeeds).
  // When omitted, falls back to the FORJA_XAI_INCLUDE_USAGE env var so a CLI
  // user (registry factory forwards no options) can opt out without code.
  // Mirrors the OpenAI adapter's escape hatch.
  includeUsage?: boolean;
}

// Resolve the `includeUsage` default from the env for callers that pass no
// explicit option (notably the registry factory on the CLI path). Truthy by
// default; recognized falsy strings disable the param.
const includeUsageFromEnv = (): boolean => {
  const v = process.env.FORJA_XAI_INCLUDE_USAGE;
  if (v === undefined || v === '') return true;
  const norm = v.toLowerCase();
  return !(norm === '0' || norm === 'false' || norm === 'no' || norm === 'off');
};

export const createXaiProvider = (
  modelName: string,
  options: CreateXaiProviderOptions = {},
): Provider => {
  const caps = options.capabilities ?? XAI_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(
      `unknown xAI model: ${modelName} (pass options.capabilities or add it to XAI_CAPS)`,
    );
  }

  let client: OpenAI;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'xAI API key required (pass options.apiKey; the catalog provides it from the model api_key_env in model_providers.json — no env fallback)',
      );
    }
    client = new OpenAI({ apiKey, baseURL: options.baseURL ?? DEFAULT_XAI_BASE_URL });
  }

  // Reasoning models reject `temperature`/`top_p` on some providers; Grok
  // accepts them, so sampling is on unless a model opts out via capability.
  const acceptsSampling = caps.supports_sampling !== false;
  // A reasoning model (grok-4.5 and future effort-capable Grok) is the proxy
  // for two behaviors: it accepts `reasoning_effort`, and it REJECTS `stop`
  // (xAI returns an error when `stop` is sent with a reasoning model). Gate on
  // the same capability the OpenAI adapter uses to detect reasoning models.
  const isReasoningModel = caps.supports_reasoning_effort === true;
  const includeUsage = options.includeUsage ?? includeUsageFromEnv();
  // xAI prompt-cache sticky routing: the `x-grok-conv-id` header routes a
  // conversation's requests to the same server so the automatic prompt cache is
  // actually reused turn-to-turn (without it, cached_tokens is often 0 on a long
  // loop and the caller pays full input price). Keyed on the STABLE prefix
  // (system + tools) via the shared openaiPromptCacheKey — the same derivation the
  // OpenAI adapter routes on — so every turn of a session, and any session with
  // the same prefix, routes together (system/tools don't change within a session).
  // Only on the real api.x.ai path: a custom `base_url` (proxy) has its own
  // routing and the header is meaningless there. `client`-injected callers (tests)
  // pass no baseURL, so the header is still emitted and observable.
  const sendConvId = options.baseURL === undefined;
  const convIdOptions = (req: GenerateRequest): { headers: Record<string, string> } | undefined =>
    sendConvId ? { headers: { 'x-grok-conv-id': openaiPromptCacheKey(req) } } : undefined;

  const buildMessages = (req: GenerateRequest): OpenAIMessage[] => {
    const messages: OpenAIMessage[] = [];
    // Flat system string — Grok's prompt cache is automatic (no explicit
    // breakpoints), so systemSegments are not consulted here.
    if (req.system !== undefined) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(...toOpenAIMessages(m));
    return messages;
  };

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    const params: Record<string, unknown> = {
      model: modelName,
      messages: buildMessages(req),
      stream: true,
      // xAI documents `max_completion_tokens` (visible output, excluding
      // reasoning tokens) as the current field; `max_tokens` is deprecated.
      max_completion_tokens: req.max_tokens,
    };
    // Opt into the final-chunk usage payload so cost is computable (unless the
    // caller/env disabled it for a param-strict proxy — see includeUsage).
    if (includeUsage) params.stream_options = { include_usage: true };
    if (req.tools !== undefined) params.tools = toOpenAITools(req.tools);
    // Flat `reasoning_effort` (Chat Completions), gated on capability. grok-4.5
    // always reasons and has no `none`, so a disable intent (`thinking_budget:
    // 0`) is NOT forwarded — omitting the field leaves the model on its default
    // (high). low/medium/high map 1:1; xhigh/max clamp to high (grok's top).
    if (req.effort !== undefined && isReasoningModel) {
      params.reasoning_effort = XAI_REASONING_EFFORT[req.effort];
    }
    if (acceptsSampling && req.temperature !== undefined) params.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) params.top_p = req.top_p;
    if (req.seed_in_eval === true) params.seed = deriveSeedFromRequest(req);
    // `stop` is rejected by xAI reasoning models — send it only for a
    // non-reasoning model.
    if (req.stop_sequences !== undefined && !isReasoningModel) params.stop = req.stop_sequences;

    const stream = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0],
      convIdOptions(req),
    )) as unknown as AsyncIterable<RawXaiChunk>;
    yield* normalizeXaiStream(stream);
  };

  // Structured output via FORCED tool calling (mirrors the OpenAI adapter): one
  // function tool whose parameters are the schema, forced with tool_choice.
  // More lenient than response_format:json_schema (which rejects non-strict
  // schemas). Single non-streaming round-trip.
  const generateConstrained = async (req: ConstrainedRequest): Promise<ConstrainedResult> => {
    if (req.tools !== undefined && req.tools.length > 0) {
      throw new Error("xai generateConstrained: 'tools' must be empty (forced schema tool only)");
    }
    const params: Record<string, unknown> = {
      model: modelName,
      messages: buildMessages(req),
      max_completion_tokens: req.max_tokens,
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
      convIdOptions(req),
    )) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      } | null;
    };

    const toolCall = response.choices?.[0]?.message?.tool_calls?.find(
      (c) => c.function?.name === req.output_schema_name,
    );
    if (toolCall?.function?.arguments === undefined) {
      const finish = response.choices?.[0]?.finish_reason ?? 'unknown';
      throw new Error(
        `xai constrained: model returned no tool_call for forced tool '${req.output_schema_name}' (finish_reason=${finish})`,
      );
    }
    // Usage convention MATCHES the streaming path (xai/stream.ts): prompt_tokens
    // INCLUDES cached, so input = prompt − cached; cache_read = cached; xAI
    // reports no cache-write, so cache_creation = 0. And `completion_tokens` is
    // the VISIBLE answer only — the billed reasoning is separate under
    // completion_tokens_details.reasoning_tokens and must be added to output.
    const u = response.usage;
    const prompt = u?.prompt_tokens ?? 0;
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const reasoning = u?.completion_tokens_details?.reasoning_tokens ?? 0;
    return {
      output: toolCall.function.arguments,
      usage: {
        input: Math.max(0, prompt - cached),
        output: (u?.completion_tokens ?? 0) + reasoning,
        cache_read: cached,
        cache_creation: 0,
      },
    };
  };

  return {
    id: `xai/${modelName}`,
    family: 'xai',
    capabilities: caps,
    // Chat Completions has no reasoning-input slot, so reasoning is never
    // replayed onto the wire (the stream surfaces it as thinking_delta for the
    // UI only). Keep this false so the token estimator does not count a
    // reasoning payload the adapter never sends.
    replaysReasoning: false,
    generate,
    generateConstrained,
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(estimateMessagesTokens(messages)),
  };
};
