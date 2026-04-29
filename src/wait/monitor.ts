import { statSync } from 'node:fs';
import type { BgManager } from '../bg/index.ts';

// `monitor` primitive (spec §7.3.1). Where wait_for stops on the
// first match, monitor accumulates events over a duration and
// returns the batch when the budget is exhausted. ZERO LLM calls
// during the wait — the model runs once at the end.
//
// Conditions cover the streaming use cases the spec calls out:
// tail every line of a bg process's output, capture every match of
// a regex against bg output, watch a file for repeated changes.

export type MonitorCondition =
  | { kind: 'process_output_lines'; processId: string }
  | { kind: 'process_output_pattern'; processId: string; pattern: RegExp }
  | { kind: 'file_changes'; path: string };

export interface MonitorOptions {
  // Wall-clock cap. When reached, monitor returns whatever events
  // it collected with reason='duration'. Required so a model can't
  // accidentally wait forever for a quiet process.
  durationMs: number;
  // Cap on the number of events. When reached, monitor returns
  // with reason='max_events'. Default 100 — bounded payload that
  // fits in a typical model context.
  maxEvents?: number;
  // Poll interval. Defaults to 200ms — tighter than wait_for's
  // 500ms because monitor is generally observing rapidly-changing
  // state (logs, file mutations).
  pollIntervalMs?: number;
  // Optional abort signal. Caller-abort stops the monitor with
  // reason='aborted'.
  signal?: AbortSignal;
  // Required for process_output_* conditions; ignored otherwise.
  bgManager?: BgManager;
}

export type MonitorEventKind = 'process_output_line' | 'process_output_match' | 'file_change';

export interface MonitorEvent {
  kind: MonitorEventKind;
  // Wall-clock timestamp captured when the event was extracted
  // from the source. Approximate per-poll-batch — we don't have
  // per-byte kernel timestamps. Documented in BACKLOG risks.
  timestamp: number;
  payload: Record<string, unknown>;
}

export type MonitorReason = 'duration' | 'max_events' | 'aborted' | 'process_exited';

export interface MonitorResult {
  events: MonitorEvent[];
  reason: MonitorReason;
  elapsedMs: number;
  // For process_* conditions: the source process's final state at
  // termination. Useful for the model to know whether the process
  // is still running (duration/max_events termination) or has
  // exited.
  processStatus?: 'running' | 'exited' | 'killed' | 'failed';
  processExitCode?: number | null;
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MAX_EVENTS = 100;

// Tail size carried across polls in `process_output_pattern` so a
// match that straddles a poll boundary (start in poll N's tail,
// end in poll N+1's head) still emits an event. Same value as
// wait_for's process_output overlap. Patterns longer than 64 bytes
// risk missing if they span more than one tail-poll cycle —
// documented as risk; pull-in if real workflows need longer.
const PATTERN_OVERLAP_BYTES = 64;

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

const safeMtimeMs = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

// Build a combined signal: caller signal + duration timer. Cleanup
// clears the timer; mirrors waitFor's buildTimeoutSignal pattern.
const buildDurationSignal = (
  durationMs: number,
  caller?: AbortSignal,
): {
  signal: AbortSignal;
  cleanup: () => void;
  durationFired: () => boolean;
} => {
  const ac = new AbortController();
  let durationFired = false;
  const timer = setTimeout(() => {
    durationFired = true;
    ac.abort();
  }, durationMs);
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
    durationFired: () => durationFired,
  };
};

// Extract complete lines from a buffer + new chunk, returning the
// extracted lines and the remaining partial-line tail. Splits by
// \n only (we strip a trailing \r per line to handle \r\n).
const extractLines = (buffer: string, chunk: string): { lines: string[]; rest: string } => {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  // The last part may be incomplete (no trailing \n yet); keep it
  // as the rest for the next poll. Empty string is fine — means
  // chunk ended exactly at \n.
  const rest = parts.pop() ?? '';
  return {
    lines: parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)),
    rest,
  };
};

export const monitor = async (
  condition: MonitorCondition,
  options: MonitorOptions,
): Promise<MonitorResult> => {
  const start = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const events: MonitorEvent[] = [];

  if (options.signal?.aborted) {
    return { events, reason: 'aborted', elapsedMs: 0 };
  }

  // Process_* conditions need the bg manager. Reject upfront —
  // matches waitFor's pattern; tool layer surfaces as
  // bg.manager_unavailable.
  if (
    (condition.kind === 'process_output_lines' || condition.kind === 'process_output_pattern') &&
    options.bgManager === undefined
  ) {
    throw new Error(`monitor(${condition.kind}) requires options.bgManager but none was provided`);
  }

  // process_output_pattern requires the global flag. The internal
  // dispatch uses `String.matchAll` for multi-match collection;
  // matchAll throws TypeError on non-/g RegExp. The tool layer
  // always compiles with /g, but programmatic callers passing a
  // raw RegExp could miss this — fail fast with a clear message
  // instead of letting matchAll explode mid-poll.
  if (condition.kind === 'process_output_pattern' && !condition.pattern.global) {
    throw new Error("monitor(process_output_pattern) requires a regex with the global ('g') flag");
  }

  const duration = buildDurationSignal(options.durationMs, options.signal);
  const combinedSignal = duration.signal;

  const finalize = (
    reason: MonitorReason,
    extra?: { processStatus?: MonitorResult['processStatus']; processExitCode?: number | null },
  ): MonitorResult => {
    duration.cleanup();
    const result: MonitorResult = {
      events,
      reason,
      elapsedMs: Date.now() - start,
    };
    if (extra?.processStatus !== undefined) result.processStatus = extra.processStatus;
    if (extra?.processExitCode !== undefined) result.processExitCode = extra.processExitCode;
    return result;
  };

  // Per-condition state captured before the poll loop.
  let stdoutCursor = 0;
  let stderrCursor = 0;
  let stdoutBuf = '';
  let stderrBuf = '';
  // Pattern-mode buffers. Carry the last PATTERN_OVERLAP_BYTES of
  // each stream's combined text (buffer + chunk) across polls. A
  // match in next poll's combined text is emitted only if it
  // extends past the buffer length — matches entirely inside the
  // buffer were already emitted in the prior poll, so we skip
  // them to avoid double-emission. Lines mode uses `stdoutBuf` /
  // `stderrBuf` for partial-line carry-over (different semantic;
  // separate state).
  let stdoutPatternBuf = '';
  let stderrPatternBuf = '';
  let baselineMtime: number | null = null;
  if (condition.kind === 'file_changes') {
    baselineMtime = safeMtimeMs(condition.path);
  }
  // Last-seen process state, captured per readOutput poll. Carried
  // into the duration / aborted / max_events termination payloads
  // so the model can distinguish "monitor stopped because the
  // duration ended, process still running" from "monitor stopped
  // because the process exited" without a separate getStatus call.
  let lastProcessStatus: MonitorResult['processStatus'] | undefined;
  let lastProcessExitCode: number | null | undefined;
  const carriedProcessExtra = (): {
    processStatus?: MonitorResult['processStatus'];
    processExitCode?: number | null;
  } => {
    const extra: {
      processStatus?: MonitorResult['processStatus'];
      processExitCode?: number | null;
    } = {};
    if (lastProcessStatus !== undefined) extra.processStatus = lastProcessStatus;
    if (lastProcessExitCode !== undefined) extra.processExitCode = lastProcessExitCode;
    return extra;
  };

  while (true) {
    if (combinedSignal.aborted) {
      // Distinguish the two abort sources via the helper's flag.
      return finalize(duration.durationFired() ? 'duration' : 'aborted', carriedProcessExtra());
    }
    if (events.length >= maxEvents) {
      return finalize('max_events', carriedProcessExtra());
    }

    switch (condition.kind) {
      case 'process_output_lines': {
        // bgManager presence checked at function entry — non-null
        // is guaranteed inside this branch.
        const bg = options.bgManager;
        if (bg === undefined) {
          duration.cleanup();
          throw new Error('bgManager unexpectedly undefined mid-monitor');
        }
        let r: Awaited<ReturnType<typeof bg.readOutput>>;
        try {
          r = await bg.readOutput(condition.processId, {
            sinceStdout: stdoutCursor,
            sinceStderr: stderrCursor,
          });
        } catch (e) {
          duration.cleanup();
          throw e;
        }
        lastProcessStatus = r.status;
        lastProcessExitCode = r.exitCode;
        const stdoutExt = extractLines(stdoutBuf, r.stdout);
        stdoutBuf = stdoutExt.rest;
        const now = Date.now();
        for (const line of stdoutExt.lines) {
          events.push({
            kind: 'process_output_line',
            timestamp: now,
            payload: { stream: 'stdout', line },
          });
          if (events.length >= maxEvents) {
            return finalize('max_events', {
              processStatus: r.status,
              processExitCode: r.exitCode,
            });
          }
        }
        const stderrExt = extractLines(stderrBuf, r.stderr);
        stderrBuf = stderrExt.rest;
        for (const line of stderrExt.lines) {
          events.push({
            kind: 'process_output_line',
            timestamp: now,
            payload: { stream: 'stderr', line },
          });
          if (events.length >= maxEvents) {
            return finalize('max_events', {
              processStatus: r.status,
              processExitCode: r.exitCode,
            });
          }
        }
        stdoutCursor = r.stdoutCursor;
        stderrCursor = r.stderrCursor;
        if (r.status !== 'running') {
          // Process gone — drain anything left in the buffer
          // (likely an unterminated tail). Spec is silent on
          // this; we emit any non-empty tail as a final event
          // so the model doesn't lose the trailing partial
          // line of a crash log.
          if (stdoutBuf.length > 0) {
            events.push({
              kind: 'process_output_line',
              timestamp: Date.now(),
              payload: { stream: 'stdout', line: stdoutBuf, partial: true },
            });
            stdoutBuf = '';
          }
          if (stderrBuf.length > 0 && events.length < maxEvents) {
            events.push({
              kind: 'process_output_line',
              timestamp: Date.now(),
              payload: { stream: 'stderr', line: stderrBuf, partial: true },
            });
            stderrBuf = '';
          }
          return finalize('process_exited', {
            processStatus: r.status,
            processExitCode: r.exitCode,
          });
        }
        break;
      }
      case 'process_output_pattern': {
        const bg = options.bgManager;
        if (bg === undefined) {
          duration.cleanup();
          throw new Error('bgManager unexpectedly undefined mid-monitor');
        }
        let r: Awaited<ReturnType<typeof bg.readOutput>>;
        try {
          r = await bg.readOutput(condition.processId, {
            sinceStdout: stdoutCursor,
            sinceStderr: stderrCursor,
          });
        } catch (e) {
          duration.cleanup();
          throw e;
        }
        lastProcessStatus = r.status;
        lastProcessExitCode = r.exitCode;
        const now = Date.now();
        // Combine the prior poll's tail (overlap buffer) with the
        // new chunk so a match straddling the poll boundary still
        // appears in matchAll. Emit only matches whose end extends
        // past the buffer — matches entirely inside the buffer were
        // already emitted in the previous poll, and re-emitting them
        // would double-count.
        const scanWithOverlap = (
          buffer: string,
          chunk: string,
          stream: 'stdout' | 'stderr',
        ): { ok: boolean; nextBuffer: string } => {
          if (chunk.length === 0 && buffer.length === 0) {
            return { ok: true, nextBuffer: buffer };
          }
          const combined = buffer + chunk;
          for (const m of combined.matchAll(condition.pattern)) {
            const idx = m.index ?? 0;
            const matchEnd = idx + m[0].length;
            // Skip matches that ended within the carry-over buffer
            // — those were already emitted last poll.
            if (matchEnd <= buffer.length) continue;
            events.push({
              kind: 'process_output_match',
              timestamp: now,
              payload: {
                stream,
                match: m[0],
                index: idx,
              },
            });
            if (events.length >= maxEvents) {
              return { ok: false, nextBuffer: combined.slice(-PATTERN_OVERLAP_BYTES) };
            }
          }
          return { ok: true, nextBuffer: combined.slice(-PATTERN_OVERLAP_BYTES) };
        };
        const stdoutScan = scanWithOverlap(stdoutPatternBuf, r.stdout, 'stdout');
        stdoutPatternBuf = stdoutScan.nextBuffer;
        if (!stdoutScan.ok) {
          return finalize('max_events', {
            processStatus: r.status,
            processExitCode: r.exitCode,
          });
        }
        const stderrScan = scanWithOverlap(stderrPatternBuf, r.stderr, 'stderr');
        stderrPatternBuf = stderrScan.nextBuffer;
        if (!stderrScan.ok) {
          return finalize('max_events', {
            processStatus: r.status,
            processExitCode: r.exitCode,
          });
        }
        stdoutCursor = r.stdoutCursor;
        stderrCursor = r.stderrCursor;
        if (r.status !== 'running') {
          return finalize('process_exited', {
            processStatus: r.status,
            processExitCode: r.exitCode,
          });
        }
        break;
      }
      case 'file_changes': {
        const current = safeMtimeMs(condition.path);
        if (current !== null && current !== baselineMtime) {
          events.push({
            kind: 'file_change',
            timestamp: Date.now(),
            payload: {
              path: condition.path,
              mtimeMs: current,
              previousMtimeMs: baselineMtime,
            },
          });
          baselineMtime = current;
          if (events.length >= maxEvents) return finalize('max_events');
        }
        break;
      }
    }

    try {
      await sleepMs(pollIntervalMs, combinedSignal);
    } catch {
      // Combined signal aborted during the inter-poll sleep.
      // Exit with the same payload shape the top-of-loop abort
      // uses so the model gets a consistent terminator regardless
      // of where the abort fired.
      return finalize(duration.durationFired() ? 'duration' : 'aborted', carriedProcessExtra());
    }
  }
};
