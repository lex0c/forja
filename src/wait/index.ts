import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';

// `wait_for` primitive (spec §7.3.1). Blocks until a condition is
// met or a timeout fires, with **zero LLM calls** during the wait —
// only wall-clock cost. The harness's combined signal (caller abort
// + maxWallClockMs) cascades through `options.signal`, so a Ctrl+C
// or wall-clock cap aborts the wait promptly.
//
// Conditions in this slice (Step 2.2.1) are non-bg utility waits.
// Process-aware conditions (`process_exit`, `process_output`) and
// composition (`all_of`, `any_of`) land in 2.2.2 / 2.2.3.

export type WaitCondition =
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_change'; path: string }
  | { kind: 'port_open'; host: string; port: number }
  | {
      kind: 'http_response';
      url: string;
      status?: number;
      // 'follow' (default) follows 3xx redirects transparently; the
      // matched status is the FINAL response. 'manual' surfaces the
      // literal status of the requested URL — useful when the model
      // wants to detect a redirect (301/302) without traversing the
      // chain. fetch's `manual` returns an opaqueredirect (status 0)
      // for 3xx in some implementations, but Bun surfaces the actual
      // 3xx code, which is what we match against.
      redirect?: 'follow' | 'manual';
    };

export interface WaitOptions {
  // Hard cap on the wait. When reached, the result reports
  // matched=false with conditionMet='timeout'.
  timeoutMs: number;
  // Poll interval for non-streaming conditions (file_exists,
  // file_change, port_open, http_response). Defaults to 500ms.
  // Lower = more responsive, higher = cheaper. The condition
  // resolves at the next poll boundary, so worst-case detection
  // latency is one pollIntervalMs.
  pollIntervalMs?: number;
  // Optional abort signal. When fired, the wait returns immediately
  // with matched=false and conditionMet='aborted'. The harness's
  // combined signal (caller + wall-clock) is the canonical source.
  signal?: AbortSignal;
}

export type WaitConditionMet =
  | 'sleep'
  | 'file_exists'
  | 'file_change'
  | 'port_open'
  | 'http_response'
  | 'timeout'
  | 'aborted';

export interface WaitResult {
  // True iff the condition fired. False on timeout or abort.
  matched: boolean;
  conditionMet: WaitConditionMet;
  elapsedMs: number;
  // Optional payload for conditions that observed something
  // diagnostic (e.g. http_response captures the actual status code,
  // file_change captures the new mtime).
  payload?: Record<string, unknown>;
}

const DEFAULT_POLL_INTERVAL_MS = 500;

// Sleep helper that respects an abort signal. Resolves on timer fire,
// rejects on abort. Used both for the `sleep` condition and as the
// inter-poll delay in polling conditions.
const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// Combine the caller's optional signal with a fresh timeout signal so
// the polling loops have a single signal to await. The combined
// signal aborts on EITHER the caller's signal firing or the timeout
// firing. The returned `cleanup` clears the timer; callers MUST run
// it on every exit path to avoid leaked timers when the condition
// resolves before the timeout.
const buildTimeoutSignal = (
  timeoutMs: number,
  caller?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; timeoutFired: () => boolean } => {
  const ac = new AbortController();
  let timeoutFired = false;
  const timer = setTimeout(() => {
    timeoutFired = true;
    ac.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => {
    clearTimeout(timer);
    ac.abort();
  };
  if (caller !== undefined) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  return {
    signal: ac.signal,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
    timeoutFired: () => timeoutFired,
  };
};

// Floor on per-attempt TCP connect timeout. Without this, a small
// `pollIntervalMs` (say 10ms) caps each connect attempt at 10ms —
// shorter than legitimate DNS lookups and TCP handshakes on a real
// network — and every probe fails as a phantom "service down". The
// outer combined signal still cuts the attempt short on abort, so a
// generous per-attempt floor doesn't hold the loop past the user-
// supplied timeout.
const MIN_CONNECT_TIMEOUT_MS = 200;

// Probe a single TCP connection. Resolves true on connect (closes
// the connection immediately — no payload sent), false on any error
// or signal abort. `signal` is the outer combined signal (caller +
// wait-timeout); when it fires, we destroy the socket and resolve
// false rather than letting the connect attempt run to its own
// timer.
const tryConnect = (
  host: string,
  port: number,
  connectTimeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const onAbort = (): void => {
      settle(false);
    };
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      try {
        socket.destroy();
      } catch {
        // socket already destroyed
      }
      resolve(ok);
    };
    if (signal.aborted) {
      settle(false);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => settle(false), connectTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      settle(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      settle(false);
    });
  });

// Try a single HTTP probe. Resolves with the actual status code on
// any non-network response (including 4xx/5xx), null on network error.
// HEAD is preferred — avoids downloading a body. `redirect` controls
// whether 3xx responses are followed transparently ('follow', current
// default — matches "wait for the URL chain to settle") or surfaced
// as the literal status ('manual' — matches "wait for THIS URL to
// respond"). Caller signal threads to fetch so a wait-level timeout
// can interrupt a slow server mid-request.
const tryHttp = async (
  url: string,
  signal: AbortSignal,
  redirect: 'follow' | 'manual',
): Promise<number | null> => {
  try {
    const res = await fetch(url, { method: 'HEAD', signal, redirect });
    return res.status;
  } catch {
    return null;
  }
};

const safeMtimeMs = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

export const waitFor = async (
  condition: WaitCondition,
  options: WaitOptions,
): Promise<WaitResult> => {
  const start = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (options.signal?.aborted) {
    return { matched: false, conditionMet: 'aborted', elapsedMs: 0 };
  }

  // sleep is special: it fires on success EXACTLY at duration_ms (or
  // fails on abort/timeout). No polling, no escalation.
  if (condition.kind === 'sleep') {
    const target = Math.min(condition.durationMs, options.timeoutMs);
    try {
      await sleepMs(target, options.signal);
    } catch {
      return {
        matched: false,
        conditionMet: options.signal?.aborted ? 'aborted' : 'timeout',
        elapsedMs: Date.now() - start,
      };
    }
    if (condition.durationMs > options.timeoutMs) {
      // Slept all the way to timeoutMs but the requested duration is
      // longer — report as timeout, not match. Rare in practice (model
      // would specify a sleep with timeout > duration) but the
      // semantic is honest.
      return { matched: false, conditionMet: 'timeout', elapsedMs: Date.now() - start };
    }
    return { matched: true, conditionMet: 'sleep', elapsedMs: Date.now() - start };
  }

  const timeout = buildTimeoutSignal(options.timeoutMs, options.signal);
  // Single signal that aborts on EITHER caller-abort or wait-timeout.
  // Used by the polling loops (via sleepMs) and by http_response's
  // fetch.
  const combinedSignal = timeout.signal;

  const finishMatched = (
    kind: Exclude<WaitConditionMet, 'timeout' | 'aborted'>,
    payload?: Record<string, unknown>,
  ): WaitResult => {
    timeout.cleanup();
    const result: WaitResult = {
      matched: true,
      conditionMet: kind,
      elapsedMs: Date.now() - start,
    };
    if (payload !== undefined) result.payload = payload;
    return result;
  };
  const finishUnmatched = (): WaitResult => {
    timeout.cleanup();
    return {
      matched: false,
      conditionMet: timeout.timeoutFired() ? 'timeout' : 'aborted',
      elapsedMs: Date.now() - start,
    };
  };

  // Per-condition state captured before the poll loop starts. Keeping
  // the switch outside the loop avoids re-checking the discriminant
  // every poll cycle.
  let baselineMtime: number | null = null;
  if (condition.kind === 'file_change') {
    baselineMtime = safeMtimeMs(condition.path);
  }

  while (true) {
    if (combinedSignal.aborted) return finishUnmatched();

    switch (condition.kind) {
      case 'file_exists': {
        if (existsSync(condition.path)) {
          return finishMatched('file_exists', { path: condition.path });
        }
        break;
      }
      case 'file_change': {
        const current = safeMtimeMs(condition.path);
        // Treat "missing file → exists" as a change. Useful when the
        // model is waiting for a build artifact to appear. The
        // baseline-was-null case fires immediately on first poll
        // where the file exists.
        if (current !== null && current !== baselineMtime) {
          return finishMatched('file_change', {
            path: condition.path,
            mtimeMs: current,
            previousMtimeMs: baselineMtime,
          });
        }
        break;
      }
      case 'port_open': {
        // Per-attempt connect timeout has a floor (200ms) so legit
        // DNS lookups + handshakes have time to complete on
        // configurations with very small pollIntervalMs. The outer
        // combined signal still cuts the attempt short on abort.
        const connectTimeout = Math.max(pollIntervalMs, MIN_CONNECT_TIMEOUT_MS);
        const ok = await tryConnect(condition.host, condition.port, connectTimeout, combinedSignal);
        if (ok) {
          return finishMatched('port_open', {
            host: condition.host,
            port: condition.port,
          });
        }
        // Inter-poll sleep is intentionally short — tryConnect already
        // consumed wall-clock proportional to its timeout in the
        // failure path, so a full pollIntervalMs of additional sleep
        // would feel laggy. Capped at 100ms.
        try {
          await sleepMs(Math.min(pollIntervalMs, 100), combinedSignal);
        } catch {
          return finishUnmatched();
        }
        continue;
      }
      case 'http_response': {
        const redirect = condition.redirect ?? 'follow';
        const status = await tryHttp(condition.url, combinedSignal, redirect);
        if (status !== null) {
          const expected = condition.status;
          const matches =
            expected === undefined ? status >= 200 && status < 300 : status === expected;
          if (matches) {
            return finishMatched('http_response', {
              url: condition.url,
              status,
            });
          }
        }
        break;
      }
    }

    // Inter-poll sleep, abort-aware. If the timeout fires during the
    // sleep, sleepMs rejects and we exit through finishUnmatched.
    try {
      await sleepMs(pollIntervalMs, combinedSignal);
    } catch {
      return finishUnmatched();
    }
  }
};
