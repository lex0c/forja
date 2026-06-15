import { describe, expect, test } from 'bun:test';
import {
  MAX_RETRY_AFTER_MS,
  generateWithRetry,
  isRetryableError,
  retryAfterMs,
} from '../../src/harness/retry.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

const minimalProvider = (generate: Provider['generate']): Provider => ({
  id: 'mock/m',
  family: 'anthropic',
  capabilities: {
    tools: 'native',
    cache: false,
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 1000,
    output_max_tokens: 100,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  },
  generate,
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

describe('isRetryableError', () => {
  test('429 is retryable', () => {
    const e = new Error('rate limited') as Error & { status: number };
    e.status = 429;
    expect(isRetryableError(e)).toBe(true);
  });

  test('500-599 are retryable', () => {
    for (const status of [500, 502, 503, 529]) {
      const e = new Error('server error') as Error & { status: number };
      e.status = status;
      expect(isRetryableError(e)).toBe(true);
    }
  });

  test('400-499 (except 429) are NOT retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const e = new Error('bad request') as Error & { status: number };
      e.status = status;
      expect(isRetryableError(e)).toBe(false);
    }
  });

  test('network error codes are retryable', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      const e = new Error('net') as Error & { code: string };
      e.code = code;
      expect(isRetryableError(e)).toBe(true);
    }
  });

  test('plain Error with no status/code is NOT retryable', () => {
    expect(isRetryableError(new Error('mystery'))).toBe(false);
  });

  test('non-Error throws are NOT retryable', () => {
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });
});

describe('generateWithRetry', () => {
  const dummyReq = {
    model: 'mock/m',
    messages: [{ role: 'user' as const, content: 'hi' }],
    max_tokens: 10,
  };

  test('passes through when first attempt succeeds', async () => {
    const provider = minimalProvider(async function* () {
      yield { kind: 'start', message_id: 'msg' };
      yield { kind: 'text_delta', text: 'hi' };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    const events = await collect(
      generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }),
    );
    expect(events).toHaveLength(3);
  });

  test('retries on 429 and succeeds on second attempt', async () => {
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      if (attempts === 1) {
        const e = new Error('rate limit') as Error & { status: number };
        e.status = 429;
        throw e;
      }
      yield { kind: 'start', message_id: 'msg' };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    const events = await collect(
      generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }),
    );
    expect(attempts).toBe(2);
    expect(events).toHaveLength(2);
  });

  test('does NOT retry once events have been yielded', async () => {
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      yield { kind: 'start', message_id: 'msg' };
      yield { kind: 'text_delta', text: 'partial' };
      const e = new Error('mid-stream blew up') as Error & { status: number };
      e.status = 500;
      throw e;
    });
    let caught: unknown = null;
    try {
      await collect(
        generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }),
      );
    } catch (e) {
      caught = e;
    }
    expect(attempts).toBe(1);
    expect(caught).toBeInstanceOf(Error);
  });

  test('does NOT retry non-retryable errors (e.g., 400)', async () => {
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      const e = new Error('bad request') as Error & { status: number };
      e.status = 400;
      throw e;
      // biome-ignore lint/correctness/useYield: throw before yield
    });
    let caught: unknown = null;
    try {
      await collect(
        generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }),
      );
    } catch (e) {
      caught = e;
    }
    expect(attempts).toBe(1);
    expect(caught).toBeInstanceOf(Error);
  });

  test('exhausts retries and throws the last error', async () => {
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      const e = new Error(`fail ${attempts}`) as Error & { status: number };
      e.status = 503;
      throw e;
      // biome-ignore lint/correctness/useYield: throw before yield
    });
    let caught: unknown = null;
    try {
      await collect(
        generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }),
      );
    } catch (e) {
      caught = e;
    }
    expect(attempts).toBe(3);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('fail 3');
  });

  test('respects custom sleep schedule (proves backoff is honored)', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      if (attempts < 3) {
        const e = new Error('overloaded') as Error & { status: number };
        e.status = 529;
        throw e;
      }
      yield { kind: 'start', message_id: 'msg' };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    await collect(
      generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 200, sleep }),
    );
    // Two retries → two sleeps with exponential backoff.
    expect(sleeps).toEqual([200, 800]);
  });

  test('honors a server Retry-After when longer than the backoff (capped)', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      if (attempts === 1) {
        // 429 advertising a 5s wait — far longer than the 200ms backoff.
        const e = new Error('rate limited') as Error & { status: number; headers: unknown };
        e.status = 429;
        e.headers = { 'retry-after': '5' };
        throw e;
      }
      yield { kind: 'start', message_id: 'msg' };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    await collect(
      generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 200, sleep }),
    );
    // Honored the 5s hint (> 200ms backoff), capped below the ceiling.
    expect(sleeps).toEqual([5000]);
    expect(sleeps[0]).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
  });

  test('caps an absurd Retry-After at MAX_RETRY_AFTER_MS', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    let attempts = 0;
    const provider = minimalProvider(async function* () {
      attempts += 1;
      if (attempts === 1) {
        const e = new Error('rate limited') as Error & { status: number; headers: unknown };
        e.status = 429;
        e.headers = { 'retry-after-ms': '999999' };
        throw e;
      }
      yield { kind: 'start', message_id: 'msg' };
      yield { kind: 'stop', reason: 'end_turn' };
    });
    await collect(
      generateWithRetry(provider, dummyReq, { maxAttempts: 3, baseDelayMs: 200, sleep }),
    );
    expect(sleeps).toEqual([MAX_RETRY_AFTER_MS]);
  });
});

describe('retryAfterMs', () => {
  test('reads retry-after-ms (milliseconds) from a plain-object header bag', () => {
    expect(retryAfterMs({ headers: { 'retry-after-ms': '1500' } })).toBe(1500);
  });
  test('reads retry-after (seconds) and converts to ms', () => {
    expect(retryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000);
  });
  test('prefers retry-after-ms over retry-after', () => {
    expect(retryAfterMs({ headers: { 'retry-after-ms': '250', 'retry-after': '9' } })).toBe(250);
  });
  test('reads from a Headers-like object with .get()', () => {
    const headers = new Headers({ 'retry-after': '2' });
    expect(retryAfterMs({ headers })).toBe(2000);
  });
  test('undefined when no headers / non-numeric / absent', () => {
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
    expect(
      retryAfterMs({ headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }),
    ).toBeUndefined();
    expect(retryAfterMs({ headers: {} })).toBeUndefined();
  });
});
