import type { Provider, StreamEvent } from '../providers/index.ts';

// Per CONTRACTS.md §4: retry on 5xx / 429 / network with exponential
// backoff, up to 3 attempts. We can only safely retry if no events have
// been yielded yet — once a text_delta or tool_use_start crosses the
// boundary, the harness has committed and replaying would emit
// duplicates. So this only covers the "connect failed before any
// output" case, which in practice is what 429 / overload / DNS errors
// look like.
export interface RetryOptions {
  maxAttempts: number;
  // Base delay in ms; actual delay is `base * 4^(attempt - 1)` to mirror
  // the spec's 200 / 800 / 3200 schedule with maxAttempts=3 and base=200.
  baseDelayMs: number;
  // Optional sleep override for tests so they don't waste 4 seconds.
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Best-effort detection of retryable failures across SDK shapes. Anthropic
// throws an `APIError` with `.status`; OpenAI uses `.status`; Google's
// SDK varies. We duck-type instead of importing every SDK's error class.
export const isRetryableError = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  const status = (e as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Network errors typically lack `.status` and have a code or message
  // hint. Be conservative: only known network failure codes.
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string') {
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
  }
  return false;
};

const computeBackoff = (attempt: number, base: number): number =>
  // attempt is 1-indexed; backoff is base * 4^(attempt - 1).
  base * 4 ** (attempt - 1);

// Upper bound on how long we'll honor a server-supplied Retry-After. A 429 under
// a per-minute token limit can advertise a multi-second wait; we honor the short,
// common cases but cap so a pathological value can't hang a turn past its budget
// (the eval per-case timeout is 60s; three capped waits stay well under it).
export const MAX_RETRY_AFTER_MS = 8_000;

// Extract a server-supplied retry delay (ms) from a thrown SDK error, honoring
// the standard rate-limit headers. OpenAI/Anthropic APIErrors carry `.headers`
// (a `Headers` instance OR a plain object); OpenAI also sends `retry-after-ms`
// (milliseconds) alongside the HTTP-standard `retry-after` (seconds). Duck-typed
// so we don't import each SDK's error class. Returns undefined when absent or
// non-numeric (an HTTP-date Retry-After is ignored — rare for 429).
export const retryAfterMs = (e: unknown): number | undefined => {
  const headers = (e as { headers?: unknown }).headers;
  if (headers === null || typeof headers !== 'object') return undefined;
  const read = (key: string): string | undefined => {
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === 'function') {
      const v = (getter as (k: string) => unknown).call(headers, key);
      return typeof v === 'string' ? v : undefined;
    }
    const v = (headers as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return undefined;
  };
  const ms = read('retry-after-ms');
  if (ms !== undefined) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const secs = read('retry-after');
  if (secs !== undefined) {
    const n = Number(secs);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return undefined;
};

// Wraps `provider.generate(req)` with retry semantics. The wrapper itself
// is an async generator; on first event we commit to the attempt and
// stop retrying. A failure before the first event is retried up to
// `maxAttempts` times when the error matches `isRetryableError`.
export async function* generateWithRetry(
  provider: Provider,
  req: Parameters<Provider['generate']>[0],
  options: RetryOptions = DEFAULT_RETRY,
): AsyncIterable<StreamEvent> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  while (true) {
    attempt += 1;
    let yieldedAny = false;
    try {
      for await (const ev of provider.generate(req)) {
        yieldedAny = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (yieldedAny) throw e;
      if (attempt >= options.maxAttempts) throw e;
      if (!isRetryableError(e)) throw e;
      // Wait the LONGER of our exponential backoff and the server's Retry-After
      // (a 200ms backoff that ignores a "retry in 5s" hint just burns an attempt
      // against a still-saturated limit), capped so a huge value can't hang.
      const backoff = computeBackoff(attempt, options.baseDelayMs);
      const serverHint = retryAfterMs(e);
      const delay = Math.min(Math.max(backoff, serverHint ?? 0), MAX_RETRY_AFTER_MS);
      await sleep(delay);
    }
  }
}
