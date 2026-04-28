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
      await sleep(computeBackoff(attempt, options.baseDelayMs));
    }
  }
}
