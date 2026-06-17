// Native Ollama HTTP client for `/api/chat`. We call the endpoint directly with
// `fetch` (no SDK dependency): abort is per-request via `AbortSignal`, and parsing
// stays under our own control. F1 is non-streaming — `chat()` forces
// `stream: false` and returns the single response object; incremental NDJSON
// streaming is a F2 method layered on the same client.

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

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

// --- Typed errors so the adapter can map a failure to a StreamEvent `error`
//     with an actionable hint (LOCAL_MODELS §11).

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
}

export const createOllamaHttp = (opts: OllamaHttpOptions = {}): OllamaHttp => {
  const baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };

  return {
    async chat(req, signal) {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...req, stream: false }),
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
  };
};
