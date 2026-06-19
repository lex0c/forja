import { boolFromEnv } from '../env.ts';
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
import {
  DEFAULT_OLLAMA_NUM_CTX,
  effortToThink,
  ollamaOptions,
  toOllamaMessages,
  toOllamaTools,
} from './messages.ts';
import { normalizeOllamaStream } from './stream.ts';

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

// FORJA_OLLAMA_KEEP_ALIVE override. Forwarded verbatim as Ollama's `keep_alive`
// (e.g. "-1" pins the model in VRAM, "30m" / "300" set an idle window). Unset
// leaves Ollama's own default (~5m), which already avoids reloads between close
// steps; raising it helps long sessions with pauses.
const keepAliveFromEnv = (): string | number | undefined => {
  const v = process.env.FORJA_OLLAMA_KEEP_ALIVE;
  if (v === undefined || v === '') {
    return undefined;
  }
  // A bare integer (300, -1, 0) is sent as a NUMBER — Ollama wants seconds as a
  // number, not the string "300"; a Go duration like "5m"/"30s" stays a string.
  return /^-?\d+$/.test(v) ? Number(v) : v;
};

// FORJA_OLLAMA_HEADERS — a JSON object of string headers (e.g. an Authorization
// bearer for Ollama Cloud / a guarded LAN host), so auth reaches production where
// the registry factory runs with no options. Invalid JSON / non-string values are
// ignored. Exported for direct testing.
export const parseOllamaHeaders = (raw: string | undefined): Record<string, string> | undefined => {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export interface CreateOllamaProviderOptions {
  // Defaults to FORJA_OLLAMA_BASE_URL or http://localhost:11434.
  baseUrl?: string;
  // Extra headers (e.g. auth for a remote / cloud host). Falls back to
  // FORJA_OLLAMA_HEADERS (a JSON object) in production.
  headers?: Record<string, string>;
  // Inject fetch (test seam / pin Bun's fetch).
  fetch?: typeof fetch;
  // Override capabilities (otherwise resolved from the static catalog).
  capabilities?: ProviderCapabilities;
  // Override num_ctx, bypassing the default cap (a VRAM trade-off). Falls back to
  // FORJA_OLLAMA_NUM_CTX, then to the capped model window.
  numCtx?: number;
  // Ollama `keep_alive` (model residency). Falls back to FORJA_OLLAMA_KEEP_ALIVE,
  // then to Ollama's own default when unset.
  keepAlive?: string | number;
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
  const headers = options.headers ?? parseOllamaHeaders(process.env.FORJA_OLLAMA_HEADERS);
  if (headers !== undefined) {
    httpOpts.headers = headers;
  }
  if (options.fetch !== undefined) {
    httpOpts.fetch = options.fetch;
  }
  const http = createOllamaHttp(httpOpts);

  // Explicit override (option or env) bypasses the default num_ctx cap.
  const numCtx = options.numCtx ?? numCtxFromEnv();
  const keepAlive = options.keepAlive ?? keepAliveFromEnv();

  // The window Ollama will ACTUALLY serve this turn: the override, or the model
  // capacity capped at DEFAULT_OLLAMA_NUM_CTX. Ollama sizes its KV cache to
  // num_ctx and truncates the prompt SILENTLY above it (dropping the oldest
  // tokens — including the system prompt), so the harness must budget against
  // this served window, not the raw catalog capacity. We therefore re-expose it
  // AS `capabilities.context_window`: compaction, the subagent composer, and the
  // window-relative allocator all read that field, and reporting the uncapped
  // 128K/256K capacity there would let them pack a prompt the daemon then
  // truncates. Floored at nothing and capped at the model capacity so an
  // over-large override can't claim a window past what the model was trained for.
  const servedNumCtx = numCtx ?? Math.min(caps.context_window, DEFAULT_OLLAMA_NUM_CTX);
  const effectiveWindow = Math.min(servedNumCtx, caps.context_window);
  const effectiveCaps: ProviderCapabilities =
    effectiveWindow === caps.context_window ? caps : { ...caps, context_window: effectiveWindow };

  // Reasoning replay: thinking-capable models round-trip the model's `thinking`
  // on tool follow-ups (Ollama's tool-calling guidance). Default on, gated on the
  // model's reasoning surface; FORJA_OLLAMA_REASONING_REPLAY=0 opts out.
  const reasoningReplay =
    effectiveCaps.supports_reasoning_effort === true &&
    boolFromEnv('FORJA_OLLAMA_REASONING_REPLAY', true);

  // Shared request builder for both paths. `format` is added only by the
  // constrained path; the streaming path leaves it unset.
  const buildBody = (req: GenerateRequest): OllamaChatRequest => {
    const body: OllamaChatRequest = {
      model: modelName,
      messages: toOllamaMessages(req, reasoningReplay),
      options: ollamaOptions(req, effectiveCaps, servedNumCtx),
    };
    const tools = toOllamaTools(req.tools);
    if (tools !== undefined) {
      body.tools = tools;
    }
    const think = effortToThink(req, effectiveCaps);
    if (think !== undefined) {
      body.think = think;
    }
    if (keepAlive !== undefined) {
      body.keep_alive = keepAlive;
    }
    return body;
  };

  // http.chatStream throws OllamaHttpError on transport/HTTP failure before the
  // first chunk; it propagates to the loop (and generateWithRetry can retry a
  // pre-output 5xx), the same convention the other adapters use for SDK errors.
  // On abort, the harness's abortableIterable abandons this iterator; the
  // for-await cleanup chains return() down to chatStream's finally →
  // reader.cancel(), so the in-flight fetch is actually aborted — no signal param
  // on Provider.generate needed.
  const generate = (req: GenerateRequest): AsyncIterable<StreamEvent> =>
    normalizeOllamaStream(http.chatStream(buildBody(req)));

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
    // `content` is typed string, but a divergent daemon may return a message
    // object without it — coalesce so the empty check fires instead of a deref.
    const output = res.message.content ?? '';
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
    capabilities: effectiveCaps,
    // Reasoning replay round-trips the model's `thinking` on tool follow-ups for
    // thinking-capable models (gated above). Off ⇒ toOllamaMessages drops
    // reasoning blocks and the estimator skips them.
    replaysReasoning: reasoningReplay,
    generate,
    generateConstrained,
    // Char-based estimate via the shared helper. Deliberately NOT calibrated
    // against Ollama's prompt_eval_count: that counts the whole prompt (system +
    // tools + chat template), not the messages-only figure this contract returns,
    // so folding it in would inflate the count with fixed overhead. The shared
    // estimator is the same approximation every adapter uses.
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(estimateMessagesTokens(messages, { countReasoning: reasoningReplay })),
  };
};
