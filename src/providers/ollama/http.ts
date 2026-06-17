// Native Ollama HTTP client for `/api/chat`. We call the endpoint directly with
// `fetch` (no SDK dependency): abort is per-request via `AbortSignal`, and parsing
// stays under our own control. `chat()` is non-streaming (one response object —
// used by the constrained path); `chatStream()` reads the NDJSON stream
// incrementally for the agent loop.

import { safeJsonParse } from '../../broker/safe-json.ts';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

// A single NDJSON line over this many chars (with no newline) is pathological —
// guard against a runaway / hostile stream growing the buffer unbounded.
const MAX_STREAM_LINE_CHARS = 16 * 1024 * 1024;

// --- Wire shapes (the subset we send/read) — mirror docs.ollama.com/api/chat.

export interface OllamaToolCall {
  // Ollama has no per-call id; `arguments` arrives already parsed as an object
  // (unlike OpenAI, which sends a JSON string).
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  // Reasoning text on thinking-capable models (returned when `think` is on).
  thinking?: string;
  // Present on assistant turns that call tools.
  tool_calls?: OllamaToolCall[];
  // Correlates a `role: 'tool'` result back to its call by name (Ollama has no
  // per-call id). Recent daemons read it; older ones ignore the extra field.
  tool_name?: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: unknown[];
  // `"json"` or a full JSON Schema object (structured outputs).
  format?: 'json' | Record<string, unknown>;
  // num_ctx / num_predict / temperature / top_p / stop / seed ...
  options?: Record<string, unknown>;
  // boolean in F1; recent models also accept "low" | "medium" | "high".
  think?: boolean;
  keep_alive?: string | number;
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  // On a streamed response each chunk carries a partial `message` (content is a
  // delta); the final chunk (done: true) adds the durations and token counts.
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// --- Typed errors so the adapter can surface a failure with an actionable hint
//     (LOCAL_MODELS §11). `status` is what the harness retry path keys on:
//     isRetryableError reads it, so a 5xx/429 thrown before the first event is
//     retried by generateWithRetry. `retryable` is documentary — the harness
//     reads `status`, not this flag.

export type OllamaErrorCode =
  | 'local.daemon.unavailable'
  | 'local.model.not_loaded'
  | 'local.http_error';

export class OllamaHttpError extends Error {
  constructor(
    readonly code: OllamaErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OllamaHttpError';
  }
}

// Parse one NDJSON line into a chat chunk. Ollama can emit an `{ "error": ... }`
// line mid-stream (e.g. the model runner crashed); surface it as a typed error
// rather than letting a missing `message` blow up the normalizer downstream.
const parseChunk = (line: string): OllamaChatResponse => {
  let obj: unknown;
  try {
    // safeJsonParse: NDJSON from a remote/cloud daemon is a trust boundary —
    // strip proto-pollution keys before the object flows into the normalizer.
    obj = safeJsonParse(line);
  } catch {
    throw new OllamaHttpError(
      'local.http_error',
      `Ollama /api/chat emitted a non-JSON line: ${line.slice(0, 120)}`,
    );
  }
  if (obj === null || typeof obj !== 'object') {
    throw new OllamaHttpError(
      'local.http_error',
      `Ollama /api/chat emitted a non-object line: ${line.slice(0, 120)}`,
    );
  }
  const err = (obj as { error?: unknown }).error;
  if (typeof err === 'string') {
    throw new OllamaHttpError('local.http_error', `Ollama /api/chat stream error: ${err}`);
  }
  return obj as OllamaChatResponse;
};

export interface OllamaHttpOptions {
  // Resolved by the caller (the factory reads FORJA_OLLAMA_BASE_URL); defaults to
  // localhost so the client is usable standalone (e.g. in tests).
  baseUrl?: string;
  headers?: Record<string, string>;
  // Injectable for tests and to pin Bun's fetch explicitly.
  fetch?: typeof fetch;
}

export interface OllamaHttp {
  chat(req: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatResponse>;
  chatStream(req: OllamaChatRequest, signal?: AbortSignal): AsyncIterable<OllamaChatResponse>;
}

export const createOllamaHttp = (opts: OllamaHttpOptions = {}): OllamaHttp => {
  const baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };

  // POST /api/chat with the given stream flag; validates transport + HTTP status,
  // mapping failures to a typed OllamaHttpError. Returns the raw Response so the
  // caller reads it as JSON (chat) or as an NDJSON stream (chatStream).
  const request = async (
    req: OllamaChatRequest,
    stream: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...req, stream }),
        // `?? null`: RequestInit.signal is `AbortSignal | null`, and
        // exactOptionalPropertyTypes rejects an explicit `undefined`.
        signal: signal ?? null,
      });
    } catch (e) {
      // A user/loop abort must propagate as-is, not be masked as a daemon error.
      if (e instanceof Error && e.name === 'AbortError') {
        throw e;
      }
      throw new OllamaHttpError(
        'local.daemon.unavailable',
        `cannot reach Ollama at ${baseUrl} — is the daemon running? (\`ollama serve\`): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).trim();
      if (res.status === 404) {
        throw new OllamaHttpError(
          'local.model.not_loaded',
          `model "${req.model}" is not available on the Ollama host — pull it first: \`ollama pull ${req.model}\`${
            body ? ` (${body})` : ''
          }`,
          false,
          404,
        );
      }
      throw new OllamaHttpError(
        'local.http_error',
        `Ollama /api/chat failed: HTTP ${res.status}${body ? ` ${body}` : ''}`,
        res.status >= 500,
        res.status,
      );
    }
    return res;
  };

  return {
    async chat(req, signal) {
      const res = await request(req, false, signal);
      // Validate before casting: a 200 with a malformed body (a proxy, or a
      // divergent daemon version) would otherwise blow up in the normalizer as an
      // opaque `Cannot read properties of undefined`, losing the typed hint.
      const json: unknown = await res.json();
      const message = (json as { message?: unknown } | null)?.message;
      if (message === null || typeof message !== 'object') {
        throw new OllamaHttpError(
          'local.http_error',
          'Ollama /api/chat returned a malformed response (missing `message`)',
        );
      }
      return json as OllamaChatResponse;
    },

    async *chatStream(req, signal) {
      const res = await request(req, true, signal);
      if (res.body === null) {
        throw new OllamaHttpError('local.http_error', 'Ollama /api/chat returned no response body');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          // Emit every complete line; a partial trailing line stays buffered
          // until the read that completes it (NDJSON can split across reads).
          let nl = buffer.indexOf('\n');
          while (nl !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) {
              yield parseChunk(line);
            }
            nl = buffer.indexOf('\n');
          }
          if (buffer.length > MAX_STREAM_LINE_CHARS) {
            throw new OllamaHttpError(
              'local.http_error',
              `Ollama /api/chat stream exceeded ${MAX_STREAM_LINE_CHARS} chars without a newline`,
            );
          }
        }
        // Flush any bytes the decoder held back (a multi-byte char split at the
        // final read) before emitting a trailing line that lacked a newline.
        buffer += decoder.decode();
        const rest = buffer.trim();
        if (rest.length > 0) {
          yield parseChunk(rest);
        }
      } finally {
        // Cancel the body on abandonment (abort / break). The `await` does NOT
        // pin the harness: abortableIterable calls iter.return() fire-and-forget,
        // so a slow cancel only delays this orphaned generator, not the loop.
        await reader.cancel().catch(() => undefined);
      }
    },
  };
};
