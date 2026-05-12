// Bash worker handler — PERMISSION_ENGINE.md §13.7 slice 81.
// Runs inside the spawned worker process; the broker has already
// applied the sandbox wrap to the worker itself (slice 79's
// sandboxRunner), so this handler spawns `bash -c <command>`
// without any wrapping of its own.
//
// What this handler owns:
//   - argument validation (command, timeout_ms, cwd shape)
//   - Bun.spawn of `bash -c <command>` with scrubbed env
//   - SIGTERM → SIGKILL escalation on timeout
//   - bounded output capture (4 MiB cap per stream)
//   - mapping the spawn result into BrokerResponse
//
// What this handler does NOT own:
//   - sandbox wrapping (broker side, slice 79)
//   - per-call abort propagation from the harness (slice 83
//     lifecycle work — the harness can only kill the WORKER
//     via the broker, not the bash subprocess directly)
//   - translation back to BashOutput / ToolError shape (harness
//     side, slice 82 — the harness-facing bashTool wraps
//     broker.execute and re-translates)
//   - duration_ms / truncated typed fields (harness measures
//     wallclock around broker.execute and inspects output for
//     the truncation footer pattern)
//
// Originally the spawn lived in `src/tools/builtin/bash.ts`. That
// site stays unchanged in slice 81 — the harness still calls
// `bashTool.execute` directly. Slice 82 inserts the broker hop:
// `bashTool.execute` will build a BrokerRequest, call
// `broker.execute`, and translate the response.
//
// Why a factory with seams: production wiring binds `Bun.spawn` +
// the real `scrubEnv` + `process.cwd()`; tests inject scripted
// processes + a small output cap so the truncation path is
// reachable without 4 MiB of synthetic output + a tight
// timeoutGraceMs so the SIGTERM→SIGKILL escalation is observable
// within test wall-clock budgets.

import { resolve as resolvePath } from 'node:path';
import type { BrokerCallOptions, BrokerRequest, BrokerResponse } from '../types.ts';
import type { WorkerToolHandler } from '../worker-runtime.ts';
import { readCapped } from './read-capped.ts';

// Mirrors `src/tools/builtin/bash.ts` constants. Slice 82 will
// consolidate; for now they're duplicated to keep the existing
// tool's behavior unchanged.
export const BASH_DEFAULT_TIMEOUT_MS = 30_000;
export const BASH_MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const BASH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// `BASH_ABORT_GRACE_MS` (was 5_000) removed in slice 115 — it was
// exported but never read. The actual grace window for SIGTERM →
// SIGKILL escalation is `BASH_TIMEOUT_GRACE_MS` below; the abort
// path uses the same value via `escalateToSigkill(timeoutGraceMs)`
// (slice 108). Two constants for one window was a holdover from
// a pre-consolidation draft.
export const BASH_TIMEOUT_GRACE_MS = 2_000;

// Narrowed spawned-process shape this handler depends on. Distinct
// from `SpawnedProcess` in `../spawn.ts` (which is for the broker's
// spawn of the worker) — bash spawns a CHILD inside the worker and
// doesn't write to its stdin.
export interface BashSpawnedProcess {
  stdout: ReadableStream<Uint8Array> | null | undefined;
  stderr: ReadableStream<Uint8Array> | null | undefined;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

export interface BashSpawnFnOptions {
  cwd: string;
  env: Record<string, string>;
}

export type BashSpawnFn = (
  argv: readonly string[],
  options: BashSpawnFnOptions,
) => BashSpawnedProcess;

export interface CreateBashHandlerOptions {
  // Test seam — defaults to Bun.spawn wrapper.
  spawn?: BashSpawnFn;
  // Test seam — defaults to identity (in production wiring,
  // `src/sanitize/index.ts#scrubEnv`). Identity is fine for
  // tests; production strips the secret-bearing env vars.
  scrubEnv?: (env: NodeJS.ProcessEnv) => Record<string, string>;
  // Base cwd when `request.args.cwd` is absent or relative.
  // Defaults to `process.cwd()` of the worker process.
  baseCwd?: string;
  // Override the output cap. Tests use a small value to exercise
  // the truncation footer without 4 MiB of synthetic output.
  maxOutputBytes?: number;
  // SIGTERM → SIGKILL grace window on timeout path. Tests pin
  // a small value so the escalation is observable within test
  // wall-clock budgets.
  timeoutGraceMs?: number;
}

const defaultSpawn: BashSpawnFn = (argv, opts) => {
  const proc = Bun.spawn([...argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc as unknown as BashSpawnedProcess;
};

const identityScrubEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

const errorResponse = (error: string): BrokerResponse => ({
  ok: false,
  stdout: '',
  stderr: '',
  error,
});

export const createBashHandler = (options: CreateBashHandlerOptions = {}): WorkerToolHandler => {
  const spawnFn = options.spawn ?? defaultSpawn;
  const scrubEnvFn = options.scrubEnv ?? identityScrubEnv;
  const baseCwd = options.baseCwd ?? process.cwd();
  const maxOutputBytes = options.maxOutputBytes ?? BASH_MAX_OUTPUT_BYTES;
  const timeoutGraceMs = options.timeoutGraceMs ?? BASH_TIMEOUT_GRACE_MS;

  return {
    name: 'bash',
    execute: async (
      request: BrokerRequest,
      callOptions?: BrokerCallOptions,
    ): Promise<BrokerResponse> => {
      const args = request.args;

      // Pre-aborted signal: never spawn. Same shape as the spawn
      // broker's pre-abort check (slice 83) so callers see one
      // canonical aborted response regardless of where it fired.
      if (callOptions?.signal?.aborted === true) {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          error: 'aborted',
        };
      }

      const rawCommand = args.command;
      if (typeof rawCommand !== 'string' || rawCommand.length === 0) {
        return errorResponse('bash handler: args.command must be a non-empty string');
      }

      let timeoutMs = BASH_DEFAULT_TIMEOUT_MS;
      if (args.timeout_ms !== undefined) {
        // Triple check is load-bearing (slice 117 documentation):
        //   - `typeof === 'number'` rejects strings / null / etc.
        //   - `Number.isInteger` rejects non-integer numbers AND
        //     NaN / Infinity / -Infinity (these are not integers).
        //   - `>= 100` rejects zero, negatives, and tiny values
        //     that would timer-race the spawn.
        // `Number.isFinite` would be REDUNDANT with `isInteger`
        // (isInteger returns false for NaN/Infinity), but adding
        // it doesn't cost anything and keeps the conditions
        // structurally parallel to other numeric validators that
        // accept floats — a future relaxation that removed
        // isInteger would still have isFinite catching the
        // NaN/Infinity edge case. Triple check stays.
        if (
          typeof args.timeout_ms !== 'number' ||
          !Number.isFinite(args.timeout_ms) ||
          !Number.isInteger(args.timeout_ms) ||
          args.timeout_ms < 100
        ) {
          return errorResponse('bash handler: timeout_ms must be an integer >= 100');
        }
        timeoutMs = Math.min(args.timeout_ms, BASH_MAX_TIMEOUT_MS);
      }

      let cwd = baseCwd;
      if (args.cwd !== undefined) {
        if (typeof args.cwd !== 'string') {
          return errorResponse('bash handler: args.cwd must be a string');
        }
        if (args.cwd.length === 0) {
          return errorResponse('bash handler: args.cwd must be non-empty');
        }
        // Always normalize via resolvePath (slice 115, R7 P1). Pre-slice
        // the absolute branch returned `args.cwd` verbatim — so an
        // absolute path with `..` components (`/etc/../bin/sh`) was
        // passed to spawn unnormalized. `isAbsolute` only checks the
        // leading slash, not the path shape. `resolvePath` normalizes
        // `..`/`./` lexically regardless of whether the input is
        // absolute or relative, producing a canonical form.
        // `resolvePath('/work/proj', '/etc/../tmp')` returns `/tmp`
        // — the leading absolute path replaces baseCwd, and the
        // intermediate `..` is collapsed.
        cwd = resolvePath(baseCwd, args.cwd);
      }

      let proc: BashSpawnedProcess;
      try {
        proc = spawnFn(['bash', '-c', rawCommand], {
          cwd,
          env: scrubEnvFn(process.env),
        });
      } catch (e) {
        return errorResponse(
          `bash handler: failed to spawn bash: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      let timedOut = false;
      let aborted = false;
      let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
      // First-arm-wins guard (slice 108, R7 #37). Pre-slice both
      // the timeout path AND the abort path called
      // `escalateToSigkill`, each overwriting the `let`-bound
      // timer reference. The previous timer was orphaned but
      // still pending — it fired its callback after the grace
      // window, hitting a try/catch on an already-dead proc
      // (functionally a no-op) but leaking a setTimeout handle
      // into the event loop. Under stress (concurrent timeout +
      // abort across many calls), the leak compounded and Bun
      // surfaced MaxListenersExceededWarning style symptoms.
      //
      // Fix: the FIRST escalation arms the timer; subsequent
      // calls (abort during the grace window, or vice versa)
      // silently no-op. The grace period applies once; the
      // SIGKILL fires once. Worker process state is the same;
      // the timer accounting is clean.
      const escalateToSigkill = (graceMs: number): void => {
        if (killEscalationTimer !== undefined) return;
        killEscalationTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, graceMs);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          // already exited
        }
        escalateToSigkill(timeoutGraceMs);
      }, timeoutMs);

      // Mid-exec abort propagation. Same SIGTERM → SIGKILL grace
      // as the timeout path so a bash process that traps TERM
      // still dies. The orphan-read-stop signal (below) fires when
      // proc.exited resolves regardless of why it died.
      const signal = callOptions?.signal;
      let signalListener: (() => void) | null = null;
      if (signal !== undefined) {
        signalListener = (): void => {
          aborted = true;
          try {
            proc.kill('SIGTERM');
          } catch {
            // already exited
          }
          escalateToSigkill(timeoutGraceMs);
        };
        signal.addEventListener('abort', signalListener, { once: true });
      }

      const readStopAc = new AbortController();
      // `.finally` (not `.then`) so rejection of `proc.exited`
      // ALSO aborts the read controller (slice 108, R7 #36).
      // Pre-slice the `.then(...)` callback was the only path
      // to readStopAc.abort(); a Bun edge case where the
      // process surface rejects (very rare — typically
      // proc.exited resolves with the exit code) would leave
      // the readers waiting on stream end forever, freezing
      // the call until the outer timeout fired. .finally
      // runs on both resolve and reject; the readers always
      // get the stop signal regardless of which path
      // proc.exited took.
      //
      // The trailing `.catch(() => {})` swallows the rejection
      // on this branch ONLY — `proc.exited` is also part of
      // the main `Promise.all` below, which surfaces the
      // rejection through the try/catch wrapping the await.
      // Without the swallow here, the .finally chain would
      // produce an unhandled rejection (the rejection propagates
      // through .finally; only an explicit handler consumes it).
      void proc.exited.finally(() => readStopAc.abort()).catch(() => {});

      let outRes: { text: string; truncated: boolean } = { text: '', truncated: false };
      let errRes: { text: string; truncated: boolean } = { text: '', truncated: false };
      let exitCode = -1;
      let waitError: Error | null = null;
      try {
        const stdoutP =
          proc.stdout !== null && proc.stdout !== undefined
            ? readCapped(proc.stdout, maxOutputBytes, readStopAc.signal)
            : Promise.resolve({ text: '', truncated: false });
        const stderrP =
          proc.stderr !== null && proc.stderr !== undefined
            ? readCapped(proc.stderr, maxOutputBytes, readStopAc.signal)
            : Promise.resolve({ text: '', truncated: false });
        try {
          const [o, e, code] = await Promise.all([stdoutP, stderrP, proc.exited]);
          outRes = o;
          errRes = e;
          exitCode = code;
        } catch (e) {
          // Slice 116 (R7 P1): pre-slice a Promise.all rejection
          // (readCapped throws on a stream error, or proc.exited
          // rejects in the Bun edge case slice 108 documented)
          // propagated up through execute() as a throw. The
          // caller (worker-runtime) caught it and surfaced as a
          // generic worker error — operators saw exec-threw
          // catch-all attribution in audit, not the canonical
          // bash error shape.
          //
          // Now: capture the rejection here, let the finally
          // clean up timers/listeners, return a structured
          // BrokerResponse with the partial output already
          // captured before the throw + a clear error message.
          // The existing aborted/timedOut branches below still
          // run, so caller cancellation still maps to the
          // canonical 'aborted' shape regardless of which side
          // of the race threw.
          waitError = e instanceof Error ? e : new Error(String(e));
        }
      } finally {
        clearTimeout(timer);
        if (killEscalationTimer !== undefined) clearTimeout(killEscalationTimer);
        if (signal !== undefined && signalListener !== null) {
          signal.removeEventListener('abort', signalListener);
        }
      }

      // Slice 117 (R7 P1): emit truthful truncation flags on every
      // return path. Pre-slice the bash tool inferred truncation
      // by regex-testing the trailing pattern — fragile + false
      // positive on legit content quoting the marker. The handler
      // KNOWS truthfully via readCapped's returned `truncated`
      // field; carrying that across the BrokerResponse wire is
      // the canonical source.
      const stdoutTruncated = outRes.truncated;
      const stderrTruncated = errRes.truncated;

      // Abort takes precedence over timeout — if the caller cancelled
      // AND the timeout fired (rare; e.g., abort during the grace
      // window), the canonical shape is aborted, not timeout.
      if (aborted) {
        return {
          ok: false,
          stdout: outRes.text,
          stderr: errRes.text,
          exitCode,
          error: 'aborted',
          stdoutTruncated,
          stderrTruncated,
        };
      }

      if (timedOut) {
        return {
          ok: false,
          stdout: outRes.text,
          stderr: errRes.text,
          exitCode,
          error: `bash handler: timed out after ${timeoutMs}ms`,
          stdoutTruncated,
          stderrTruncated,
        };
      }

      // Slice 116 (R7 P1): the wait error path is checked LAST
      // (after aborted + timedOut) so caller-initiated cancellation
      // wins attribution. If neither flag fired and Promise.all
      // rejected, surface the throw as a structured error response
      // instead of re-throwing up the stack.
      if (waitError !== null) {
        return {
          ok: false,
          stdout: outRes.text,
          stderr: errRes.text,
          error: `bash handler: wait failed: ${waitError.message}`,
          stdoutTruncated,
          stderrTruncated,
        };
      }

      return {
        ok: exitCode === 0,
        stdout: outRes.text,
        stderr: errRes.text,
        exitCode,
        stdoutTruncated,
        stderrTruncated,
      };
    },
  };
};
