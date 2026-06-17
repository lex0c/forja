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
import { OLLAMA_CAPS } from './capabilities.ts';
import {
  DEFAULT_OLLAMA_BASE_URL,
  type OllamaChatRequest,
  type OllamaHttpOptions,
  createOllamaHttp,
} from './http.ts';
import { effortToThink, ollamaOptions, toOllamaMessages, toOllamaTools } from './messages.ts';
import { normalizeOllamaResponse } from './stream.ts';

// FORJA_OLLAMA_NUM_CTX override (positive integer). Lets an operator raise the
// served window past the default cap (a VRAM trade-off) without code changes,
// since the registry invokes the factory with no options.
const numCtxFromEnv = (): number | undefined => {
  const v = process.env.FORJA_OLLAMA_NUM_CTX;
  if (v === undefined || v === '') {
    return undefined;
  }
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export interface CreateOllamaProviderOptions {
  // Defaults to FORJA_OLLAMA_BASE_URL or http://localhost:11434.
  baseUrl?: string;
  // Extra headers (e.g. auth for a remote / cloud host).
  headers?: Record<string, string>;
  // Inject fetch (test seam / pin Bun's fetch).
  fetch?: typeof fetch;
  // Override capabilities (otherwise resolved from the static catalog).
  capabilities?: ProviderCapabilities;
  // Override num_ctx, bypassing the default cap (a VRAM trade-off). Falls back to
  // FORJA_OLLAMA_NUM_CTX, then to the capped model window.
  numCtx?: number;
}

export const createOllamaProvider = (
  modelName: string,
  options: CreateOllamaProviderOptions = {},
): Provider => {
  const caps = options.capabilities ?? OLLAMA_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(`unknown Ollama model: ${modelName}`);
  }

  // No API key: Ollama is local. A remote/cloud host carries auth via headers.
  // The daemon being down surfaces at generate time (the factory can't probe it
  // synchronously), as a typed OllamaHttpError with an actionable hint.
  const baseUrl = options.baseUrl ?? process.env.FORJA_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  // Build conditionally: exactOptionalPropertyTypes rejects passing an explicit
  // `undefined` for the optional headers/fetch fields.
  const httpOpts: OllamaHttpOptions = { baseUrl };
  if (options.headers !== undefined) {
    httpOpts.headers = options.headers;
  }
  if (options.fetch !== undefined) {
    httpOpts.fetch = options.fetch;
  }
  const http = createOllamaHttp(httpOpts);

  // Explicit override (option or env) bypasses the default num_ctx cap.
  const numCtx = options.numCtx ?? numCtxFromEnv();

  // Shared request builder for both paths. `format` is added only by the
  // constrained path; the streaming path leaves it unset.
  const buildBody = (req: GenerateRequest): OllamaChatRequest => {
    const body: OllamaChatRequest = {
      model: modelName,
      messages: toOllamaMessages(req),
      options: ollamaOptions(req, caps, numCtx),
    };
    const tools = toOllamaTools(req.tools);
    if (tools !== undefined) {
      body.tools = tools;
    }
    const think = effortToThink(req, caps);
    if (think !== undefined) {
      body.think = think;
    }
    return body;
  };

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    // http.chat throws OllamaHttpError on transport/HTTP failure; it propagates
    // to the loop (same convention the other adapters use for SDK errors).
    const res = await http.chat(buildBody(req));
    yield* normalizeOllamaResponse(res);
  };

  // Structured output via Ollama's `format` (a full JSON Schema). Single
  // round-trip; the bytes come from the forced-format channel and the caller
  // validates against the schema (ConstrainedResult contract). Caller tools are
  // rejected up-front (they'd compete with the schema), mirroring the OpenAI path.
  const generateConstrained = async (req: ConstrainedRequest): Promise<ConstrainedResult> => {
    if (req.tools !== undefined && req.tools.length > 0) {
      throw new Error("ollama generateConstrained: 'tools' must be empty (format schema only)");
    }
    const body = buildBody(req);
    body.format = req.output_schema;
    const res = await http.chat(body);
    // A `length` stop means the JSON was cut at num_predict — it parses as
    // invalid downstream with no clue why, so surface the truncation here.
    if (res.done_reason === 'length') {
      throw new Error(
        `ollama constrained: structured output truncated at num_predict=${req.max_tokens} (done_reason=length) — raise max_tokens or simplify the schema`,
      );
    }
    const output = res.message.content;
    if (output.length === 0) {
      throw new Error(
        `ollama constrained: model returned empty content (done_reason=${res.done_reason ?? 'unknown'})`,
      );
    }
    return {
      output,
      usage: {
        input: res.prompt_eval_count ?? 0,
        output: res.eval_count ?? 0,
        cache_read: 0,
        cache_creation: 0,
      },
    };
  };

  return {
    id: `ollama/${modelName}`,
    family: 'ollama',
    capabilities: caps,
    // Ollama has no reasoning-replay channel; reasoning blocks are dropped on
    // send (toOllamaMessages), so the token estimator must not count them.
    replaysReasoning: false,
    generate,
    generateConstrained,
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(estimateMessagesTokens(messages, { countReasoning: false })),
  };
};
