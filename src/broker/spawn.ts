// Spawn broker — PERMISSION_ENGINE.md §13.7 second slice. Per
// request, spawns a fresh worker subprocess via Bun.spawn,
// pipes the request as a single NDJSON line on stdin, reads
// the response as a single NDJSON line on stdout. Workers are
// per-call disposable: one spawn per execute call. Lifetime
// hygiene + worker-pool come in later slices.
//
// Why per-call spawn vs. long-lived workers: spec line 928
// ("CLI main não tem exec privilege") wants the security
// boundary; per-call spawn AS A STARTING POINT gives clean
// process state per invocation (no tool state survives across
// calls) at the cost of fork overhead per call. A future slice
// MAY add a worker pool if profiling shows fork-cost dominates;
// the broker contract (Broker interface) doesn't promise either
// shape, so callers can't depend on it.
//
// Wire format on stdin/stdout: one NDJSON line per direction.
// Broker → worker: `JSON.stringify(request) + '\n'`. Worker →
// broker: `JSON.stringify(response) + '\n'`. The broker reads
// the LAST non-empty line of stdout so a noisy worker (debug
// prints, etc.) doesn't break parsing — the contract is that
// the response is the final NDJSON line. Stderr is captured
// separately + surfaced in the response.
//
// Sandbox wrap: when `sandboxProfile !== null` AND a
// `sandboxRunner` callback is configured, the broker wraps the
// inner argv before spawning. The runner is the existing
// `maybeWrapSandboxArgv` in `src/permissions/sandbox-runner.ts`
// in production wiring; tests pass spies. The broker doesn't
// know what bwrap is — it only knows "given a profile, ask the
// runner what argv to spawn".
//
// FIFO serialization: same single in-flight chain as the
// in-process broker. Concurrent execute calls queue. This is
// per-broker — operators that need parallel exec can construct
// multiple broker instances (a future worker-pool slice may
// internalize that).
//
// Failure modes mapped into BrokerResponse:
//   - sandbox runner throws        → ok:false, error:'sandbox wrap failed: ...'
//   - spawn throws                 → ok:false, error:'spawn failed: ...'
//   - stdin write throws           → ok:false, error:'stdin write failed: ...', child killed
//   - timeout exceeded             → ok:false, error:'timeout after Nms', child killed
//   - worker produces no output    → ok:false, error:'worker produced no response', exitCode set
//   - last line isn't valid JSON   → ok:false, error:'invalid response: ...', exitCode set
//   - parsed JSON missing fields   → ok:false, error:'response missing required fields', exitCode set
//   - worker emits valid response  → response returned verbatim (worker is the source of truth)

import type { Broker, BrokerCallOptions, BrokerRequest, BrokerResponse } from './types.ts';

// The subprocess shape the broker depends on. Narrower than
// `Bun.Subprocess` so tests can pass mocks without depending
// on the full Bun typings.
export interface SpawnedProcess {
  stdin: {
    write(data: string): unknown;
    end(): unknown;
  };
  stdout: ReadableStream<Uint8Array> | null | undefined;
  stderr: ReadableStream<Uint8Array> | null | undefined;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

export interface SpawnFnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export type SpawnFn = (argv: readonly string[], options: SpawnFnOptions) => SpawnedProcess;

// Sandbox wrap callback. Production passes a closure around
// `maybeWrapSandboxArgv`; tests pass spies. Returning a new
// argv (e.g., `['bwrap', ...flags, '--', ...innerArgv]`) is the
// runner's responsibility. Throwing is treated as a per-call
// failure and mapped into BrokerResponse.
export type SandboxRunner = (args: {
  profile: string;
  cwd: string;
  innerArgv: readonly string[];
}) => readonly string[];

export interface CreateSpawnBrokerOptions {
  // The worker entry. Slice 79 doesn't ship a worker script —
  // production wiring will pass `process.execPath` + `['run',
  // 'src/broker/worker.ts']` or similar (slice 80). Tests pass
  // `/bin/sh` + `['-c', '<inline script>']`.
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  // Kill the worker if it takes longer than this many ms.
  // Undefined means no timeout (production should ALWAYS set
  // a timeout; tests omit it to validate happy path).
  timeoutMs?: number;
  sandboxRunner?: SandboxRunner;
  // Test seam. Defaults to Bun.spawn wrapper.
  spawn?: SpawnFn;
}

const REQUIRED_FIELDS_ERROR = 'response missing required fields';

const isBrokerResponse = (v: unknown): v is BrokerResponse => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== 'boolean') return false;
  if (typeof o.stdout !== 'string') return false;
  if (typeof o.stderr !== 'string') return false;
  if (o.exitCode !== undefined && typeof o.exitCode !== 'number') return false;
  if (o.error !== undefined && typeof o.error !== 'string') return false;
  return true;
};

const defaultSpawn: SpawnFn = (argv, options) => {
  // Bun.spawn types are generic over the stdio mode; we always
  // use 'pipe' so the returned shape always has the streams +
  // FileSink we depend on. The cast narrows that for the
  // SpawnedProcess interface this module consumes. The cwd/env
  // are conditionally spread so undefined values don't tickle
  // exactOptionalPropertyTypes.
  const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  };
  if (options.cwd !== undefined) spawnOpts.cwd = options.cwd;
  if (options.env !== undefined) spawnOpts.env = options.env;
  const proc = Bun.spawn([...argv], spawnOpts);
  return proc as unknown as SpawnedProcess;
};

export const createSpawnBroker = (options: CreateSpawnBrokerOptions): Broker => {
  const command = options.command;
  const baseArgs: readonly string[] = options.args ?? [];
  const cwd = options.cwd ?? process.cwd();
  const env = options.env;
  const timeoutMs = options.timeoutMs;
  const sandboxRunner = options.sandboxRunner;
  const spawn = options.spawn ?? defaultSpawn;

  let inFlight: Promise<void> = Promise.resolve();
  let closed = false;

  const executeOnce = async (
    request: BrokerRequest,
    callOptions?: BrokerCallOptions,
  ): Promise<BrokerResponse> => {
    // Pre-aborted signal: return immediately, never spawn. Same
    // posture as fetch() with a pre-aborted signal — no work.
    if (callOptions?.signal?.aborted === true) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: 'aborted',
      };
    }

    const innerArgv: readonly string[] = [command, ...baseArgs];

    let wrappedArgv: readonly string[] = innerArgv;
    if (sandboxRunner !== undefined && request.sandboxProfile !== null) {
      try {
        wrappedArgv = sandboxRunner({
          profile: request.sandboxProfile,
          cwd,
          innerArgv,
        });
      } catch (e) {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          error: `sandbox wrap failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    let proc: SpawnedProcess;
    try {
      const spawnOpts: SpawnFnOptions = { cwd };
      if (env !== undefined) spawnOpts.env = env;
      proc = spawn(wrappedArgv, spawnOpts);
    } catch (e) {
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Write the request line + close stdin. The worker is
    // expected to read until EOF so it knows the request is
    // complete. Errors here mean the child died before we
    // finished writing; kill defensively + drain exited so the
    // child doesn't linger.
    try {
      proc.stdin.write(`${JSON.stringify(request)}\n`);
      await Promise.resolve(proc.stdin.end());
    } catch (e) {
      try {
        proc.kill();
      } catch {
        // ignore — child may already be dead
      }
      await proc.exited.catch(() => 0);
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: `stdin write failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    // Signal handler — when the caller aborts, send SIGTERM to the
    // worker. The worker's own SIGTERM handler (worker.ts) catches
    // it and propagates JS-level abort to the running tool handler,
    // which kills its subprocesses + emits an aborted response. If
    // the worker doesn't handle SIGTERM the OS terminates the
    // process; the broker then sees the missing/non-parseable
    // response and the "aborted" branch below maps it to the
    // canonical aborted shape regardless.
    let signalAborted = false;
    let signalListener: (() => void) | null = null;
    const signal = callOptions?.signal;
    if (signal !== undefined) {
      signalListener = (): void => {
        signalAborted = true;
        try {
          proc.kill('SIGTERM');
        } catch {
          // already exited
        }
      };
      signal.addEventListener('abort', signalListener, { once: true });
    }

    const stdoutP =
      proc.stdout !== null && proc.stdout !== undefined
        ? new Response(proc.stdout).text()
        : Promise.resolve('');
    const stderrP =
      proc.stderr !== null && proc.stderr !== undefined
        ? new Response(proc.stderr).text()
        : Promise.resolve('');

    let exitCode: number;
    let stdoutText = '';
    let stderrText = '';
    try {
      const [out, err, code] = await Promise.all([stdoutP, stderrP, proc.exited]);
      stdoutText = out;
      stderrText = err;
      exitCode = code;
    } catch (e) {
      if (timer !== null) clearTimeout(timer);
      if (signal !== undefined && signalListener !== null) {
        signal.removeEventListener('abort', signalListener);
      }
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        error: `wait failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (timer !== null) clearTimeout(timer);
    if (signal !== undefined && signalListener !== null) {
      signal.removeEventListener('abort', signalListener);
    }

    if (signalAborted) {
      // Caller cancellation — override whatever the worker emitted
      // (a worker that caught SIGTERM may have produced a partial
      // response; one that didn't dies mid-write). Either way the
      // canonical shape is `error: 'aborted'`.
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        error: 'aborted',
      };
    }

    if (timedOut) {
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        error: `timeout after ${timeoutMs}ms`,
      };
    }

    // Extract the last non-empty line of stdout as the response.
    // Noisy stdout (debug prints) is allowed before the response
    // line, but the LAST line is the contract.
    const lines = stdoutText.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) {
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        error: 'worker produced no response',
      };
    }
    const lastLine = lines[lines.length - 1] as string;

    let parsed: unknown;
    try {
      parsed = JSON.parse(lastLine);
    } catch (e) {
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        error: `invalid response: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (!isBrokerResponse(parsed)) {
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        error: REQUIRED_FIELDS_ERROR,
      };
    }

    return parsed;
  };

  return {
    execute: async (
      request: BrokerRequest,
      callOptions?: BrokerCallOptions,
    ): Promise<BrokerResponse> => {
      if (closed) {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          error: 'broker closed',
        };
      }
      let result: BrokerResponse;
      const myTurn = inFlight.then(async () => {
        try {
          result = await executeOnce(request, callOptions);
        } catch (e) {
          // executeOnce shouldn't throw, but if it does (bug,
          // OOM, etc.) keep the queue draining + the contract
          // intact.
          result = {
            ok: false,
            stdout: '',
            stderr: '',
            error: `broker bug: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      });
      inFlight = myTurn.catch(() => {
        // Suppress — error mapped into result.
      });
      await myTurn;
      // biome-ignore lint/style/noNonNullAssertion: assigned in myTurn before await resolves
      return result!;
    },
    close: async (): Promise<void> => {
      closed = true;
      await inFlight;
    },
  };
};
