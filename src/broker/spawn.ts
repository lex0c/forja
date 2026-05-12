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

import { scrubEnv } from '../sanitize/index.ts';
import type { TelemetrySink, WorkerCrashEvent } from '../telemetry/index.ts';
import { safeJsonParse } from './safe-json.ts';
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
  // Env handed to the worker subprocess. When undefined (the
  // common production case via bootstrap), the broker uses
  // `scrubEnv(process.env)` — the same scrub the bash handler
  // applies before its inner subprocess (slice 105, R6 #44).
  // Pre-slice, undefined here meant Bun.spawn inherited the
  // FULL parent env, which carried every operator secret (API
  // keys, vault tokens, AWS creds) into the worker before any
  // scrub fired. Defense in depth: even a compromised worker
  // (handler bug, supply-chain attack) can't read raw
  // credentials directly.
  //
  // Operators with deliberate env needs pass an explicit map;
  // they keep full control and the scrub doesn't apply.
  env?: Record<string, string>;
  // Kill the worker if it takes longer than this many ms.
  // Undefined means "use the broker default" (slice 106 raised
  // this from "no timer" to `DEFAULT_TIMEOUT_MS=60_000`); 0
  // disables timing entirely (test seam — production should
  // never pass 0). Per-call `BrokerCallOptions.timeoutMs`
  // overrides this for individual calls (slice 85).
  //
  // Slice 106 (R6 #41): pre-slice an undefined timeout meant
  // the broker awaited `proc.exited` forever on a wedged
  // worker (closed pipes but never exited, or never closed
  // pipes either). The broker would park the in-flight chain
  // indefinitely, blocking every subsequent call. Now there's
  // always a defensive ceiling unless the operator explicitly
  // opts out with 0.
  timeoutMs?: number;
  // Grace window between SIGTERM and SIGKILL for timeout +
  // abort paths (slice 113, R6 P1). Pre-slice the broker sent
  // SIGTERM and waited on proc.exited indefinitely — a worker
  // that trapped SIGTERM (`trap "" TERM`) held the broker
  // hostage until some other defense (drain cap, proc.exited
  // resolution) fired. Now an unresponsive worker gets SIGKILL
  // after this window. Default `DEFAULT_TIMEOUT_GRACE_MS` (5s)
  // matches the bash handler's grace.
  timeoutGraceMs?: number;
  // Maximum bytes to accept from the worker's stdout / stderr
  // before the drain truncates and the worker is killed (slice
  // 102, R6 #21). Pre-slice the drain used `new Response(stream)
  // .text()` with NO byte cap — a worker emitting a gigabyte of
  // stdout would OOM the BROKER process, inverting §13.7's
  // isolation premise ("worker isolation means worker faults
  // don't kill the main process"). Defaults: 16 MiB stdout (the
  // worker NDJSON response carries the tool's full output and
  // can be large for grep/find), 4 MiB stderr (debug noise and
  // crash trace, smaller than stdout). The drain replaces
  // truncated content with a `<truncated at N bytes>` suffix so
  // operators see the cause in the BrokerResponse.
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  sandboxRunner?: SandboxRunner;
  // Test seam. Defaults to Bun.spawn wrapper.
  spawn?: SpawnFn;
  // Telemetry sink (slice 84). When set, the broker emits
  // `worker.crashed` events on the three post-spawn detection
  // paths (no response, invalid JSON, missing fields). Absent ⇒
  // crashes are still surfaced via the BrokerResponse `error`
  // field (operators see the call fail) but no metric stream
  // captures the rate. Production wiring binds an OTEL-bound
  // sink via bootstrap; tests pass a recording sink to assert
  // emission shape.
  telemetry?: TelemetrySink;
  // Test seam — current-time fn. Same shape as the engine's
  // `now`; lets tests pin `elapsedMs` deterministically.
  now?: () => number;
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

// §13.7 isolation budget (slice 102, R6 #21). 16 MiB / 4 MiB are
// well above any legitimate single-call response size (a grep
// over ~50k files lands well under 16 MiB), well below "memory
// pressure on the broker host" thresholds for the typical 8-16 GB
// machine the agent runs on. Operators with unusual workloads
// (large-LLM-output piping) can raise via `maxStdoutBytes`.
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;

// Defensive timeout floor (slice 106, R6 #41). Matches the
// production wiring's explicit value (bootstrap.ts sets 60_000
// when constructing the spawn broker); making it the default
// here means a broker constructed without an explicit timeout
// — test fixture, programmatic caller that forgot — still has a
// ceiling. A wedged worker (closed pipes but never exited, or
// pipes never closed) used to park the broker's in-flight chain
// indefinitely, blocking every subsequent call; now the floor
// kicks in even on the "forgot to set timeout" path.
//
// Callers who genuinely want no timeout pass `timeoutMs: 0`
// explicitly (test escape valve). 60 s is well above any
// legitimate single tool call (typical bash invocation is
// sub-second; longest realistic shape is a multi-file grep at
// ~10 s) and well below "operator notices the hang" UX
// thresholds.
export const DEFAULT_TIMEOUT_MS = 60_000;

// SIGTERM → SIGKILL grace (slice 113, R6 P1). When the timeout
// or abort fires, the broker sends SIGTERM and waits this many
// ms for the worker to clean up; if the worker hasn't exited by
// then, SIGKILL escalates. Pre-slice the broker sent SIGTERM
// and waited on proc.exited indefinitely — a worker that
// trapped SIGTERM (e.g., `trap "" TERM`) held the broker
// hostage until the underlying drain caps / proc.exited
// timeout fired through some other path. 5 s matches the bash
// handler's grace (slice 38 onwards) so both layers use the
// same window.
const DEFAULT_TIMEOUT_GRACE_MS = 5_000;

// Drain a worker stream with a byte cap. Reads chunks until the
// stream ends OR the byte counter reaches `cap`; on cap, cancels
// the reader (releasing the worker's pipe) and appends a
// `<truncated at N bytes>` suffix to the returned text so the
// truncation is visible in the BrokerResponse.
//
// Cancelling the reader is what closes the §13.7 isolation gap:
// without it, the worker could keep writing indefinitely until the
// OS pipe buffer filled, then back-pressure the worker but leave
// the broker holding a reference to whatever bytes the worker
// already emitted. The cancel signals "we're done reading"; the
// worker's write returns EPIPE on the next chunk and (depending on
// the handler) either exits or surfaces the error in the response
// line that follows the cap. Either way the broker stops growing.
const drainBounded = async (
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const remaining = cap - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader already closed by the stream's natural end is fine.
    }
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel on some platforms.
    }
  }
  // Concatenate + decode. TextDecoder with `stream: true` would let
  // us decode chunk-by-chunk above; we defer to a single decode
  // here because the chunks are bounded by `cap` and the simpler
  // shape avoids the partial-codepoint edge case where a truncated
  // tail lands mid-character.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  return {
    text: truncated ? `${text}\n<truncated at ${cap} bytes>` : text,
    truncated,
  };
};

export const createSpawnBroker = (options: CreateSpawnBrokerOptions): Broker => {
  const command = options.command;
  const baseArgs: readonly string[] = options.args ?? [];
  const cwd = options.cwd ?? process.cwd();
  // Default env scrubs credentials from the parent env before
  // handing them to the worker (slice 105, R6 #44). Without
  // this, `Bun.spawn` with no `env` option inherits the parent's
  // full env — including every secret (API keys, vault tokens,
  // AWS creds) that the operator's shell exported. The worker
  // would see them raw before the bash handler's per-call
  // scrubEnv ever fires; a compromised worker could exfil them
  // via stderr / stdout / sandbox-escape. Explicit env from
  // the caller bypasses this default (operators who know what
  // they're doing stay in control).
  const env = options.env ?? scrubEnv(process.env);
  const timeoutMs = options.timeoutMs;
  const timeoutGraceMs = options.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const sandboxRunner = options.sandboxRunner;
  const spawn = options.spawn ?? defaultSpawn;
  const telemetry = options.telemetry;
  const now = options.now ?? (() => Date.now());

  // Fire-and-forget telemetry emit. Defensive try/catch around the
  // sink — slice 70's contract says sinks MUST NOT throw, but bugs
  // happen and a broken sink shouldn't crash the broker (which
  // would also break harness-level error reporting).
  const emitCrash = (event: WorkerCrashEvent): void => {
    if (telemetry === undefined) return;
    try {
      telemetry.emit(event);
    } catch {
      // Telemetry is observability, not critical path.
    }
  };

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

    const spawnStart = now();
    const innerArgv: readonly string[] = [command, ...baseArgs];

    // Signal handler set up BEFORE spawn (slice 107, R6 #38).
    // Pre-slice the listener was attached AFTER the await on
    // `proc.stdin.end()` — an abort firing during the
    // sandbox-wrap / spawn / stdin-write window was lost
    // because no listener was present, and a listener
    // registered AFTER the event has already fired is never
    // invoked. The caller's cancellation silently no-op'd
    // until the outer timeout fired.
    //
    // Fix: hoist `proc` to undefined, set up the listener
    // closure to call `proc.kill('SIGTERM')` ONLY when proc is
    // defined, attach BEFORE any spawn/await. After the spawn
    // resolves, an extra `signalAborted` check catches the
    // (theoretical) race where abort fired during the sync
    // spawn — JS is single-threaded so this can't actually
    // happen, but the check keeps the contract explicit and
    // guards against a future refactor that turns spawn async.
    let signalAborted = false;
    let signalListener: (() => void) | null = null;
    let proc: SpawnedProcess | undefined = undefined;
    // SIGTERM → SIGKILL escalation timer (slice 113, R6 P1).
    // First-arm-wins guard — if both abort and timeout want to
    // escalate, the first arming captures the grace window;
    // subsequent calls silently no-op. Same pattern as the
    // bash handler's slice 108 fix.
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
    const escalateToSigkill = (): void => {
      if (killEscalationTimer !== undefined) return;
      killEscalationTimer = setTimeout(() => {
        try {
          if (proc !== undefined) proc.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, timeoutGraceMs);
    };
    const signal = callOptions?.signal;
    if (signal !== undefined) {
      signalListener = (): void => {
        signalAborted = true;
        // proc may be undefined if abort races with the spawn
        // call (during the await on stdin.end). The post-spawn
        // signalAborted check below handles that case.
        if (proc !== undefined) {
          try {
            proc.kill('SIGTERM');
          } catch {
            // already exited
          }
          // Arm SIGKILL grace — a worker trapping SIGTERM
          // would otherwise hold the broker on proc.exited
          // indefinitely.
          escalateToSigkill();
        }
      };
      signal.addEventListener('abort', signalListener, { once: true });
    }

    let wrappedArgv: readonly string[] = innerArgv;
    if (sandboxRunner !== undefined && request.sandboxProfile !== null) {
      try {
        wrappedArgv = sandboxRunner({
          profile: request.sandboxProfile,
          cwd,
          innerArgv,
        });
      } catch (e) {
        if (signal !== undefined && signalListener !== null) {
          signal.removeEventListener('abort', signalListener);
        }
        return {
          ok: false,
          stdout: '',
          stderr: '',
          error: `sandbox wrap failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    try {
      // env is always set after slice 105 — the factory defaulted
      // to scrubEnv(process.env) at construction. Pass through
      // unconditionally so a downstream Bun.spawn doesn't fall
      // back to inheriting the parent env.
      const spawnOpts: SpawnFnOptions = { cwd, env };
      proc = spawn(wrappedArgv, spawnOpts);
    } catch (e) {
      if (signal !== undefined && signalListener !== null) {
        signal.removeEventListener('abort', signalListener);
      }
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Post-spawn abort check (slice 107, R6 #38). If the abort
    // fired during the sync spawn path, the listener already
    // ran but proc was undefined at that moment — the kill
    // call was a no-op. Catch the race here and kill the now-
    // valid proc before any downstream await parks the call.
    if (signalAborted) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // already exited
      }
      await proc.exited.catch(() => 0);
      if (signal !== undefined && signalListener !== null) {
        signal.removeEventListener('abort', signalListener);
      }
      return { ok: false, stdout: '', stderr: '', error: 'aborted' };
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
      if (signal !== undefined && signalListener !== null) {
        signal.removeEventListener('abort', signalListener);
      }
      // If abort fired during the write, the listener already
      // killed proc; surface the canonical aborted shape
      // instead of `stdin write failed` so the caller sees
      // the cancellation cause, not a downstream symptom.
      if (signalAborted) {
        return { ok: false, stdout: '', stderr: '', error: 'aborted' };
      }
      return {
        ok: false,
        stdout: '',
        stderr: '',
        error: `stdin write failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Per-call timeoutMs (slice 85) overrides the broker-
    // construction default when present. `0` is the explicit
    // "disable for this call" value (the > 0 guard below skips
    // arming the timer). `undefined` falls back to the broker
    // default, which in turn falls back to `DEFAULT_TIMEOUT_MS`
    // (slice 106) — `??` short-circuits on undefined but NOT
    // on 0, so an explicit `timeoutMs: 0` at either layer still
    // disables the timer.
    const effectiveTimeoutMs = callOptions?.timeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (effectiveTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          // proc is non-undefined here (we already returned
          // above on spawn failures). The narrowing isn't
          // visible to TS inside the setTimeout closure
          // because of how flow analysis works across async
          // boundaries, so a runtime `if` keeps the call safe.
          //
          // Explicit `'SIGTERM'` (was `proc.kill()` default-
          // signal) makes the intent loud — slice 113's
          // escalation path follows up with SIGKILL.
          if (proc !== undefined) {
            proc.kill('SIGTERM');
          }
        } catch {
          // ignore
        }
        // SIGTERM → SIGKILL grace (slice 113, R6 P1). A worker
        // that traps SIGTERM stops responding to the soft kill
        // but the hard SIGKILL after the grace window forces
        // termination. Same first-arm-wins guard the bash
        // handler uses (slice 108).
        escalateToSigkill();
      }, effectiveTimeoutMs);
    }

    // Bounded drain (slice 102, R6 #21). The previous `new
    // Response(stream).text()` had no byte cap — a worker emitting
    // unbounded stdout OOM'd the broker. `drainBounded` caps each
    // stream and cancels the reader when the limit is hit, which
    // releases the worker's pipe and lets the natural exit path
    // proceed. The truncation marker lands in the returned text
    // so operators see the cause in the BrokerResponse.
    const stdoutP =
      proc.stdout !== null && proc.stdout !== undefined
        ? drainBounded(proc.stdout, maxStdoutBytes)
        : Promise.resolve({ text: '', truncated: false });
    const stderrP =
      proc.stderr !== null && proc.stderr !== undefined
        ? drainBounded(proc.stderr, maxStderrBytes)
        : Promise.resolve({ text: '', truncated: false });

    let exitCode: number;
    let stdoutText = '';
    let stderrText = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    try {
      const [out, err, code] = await Promise.all([stdoutP, stderrP, proc.exited]);
      stdoutText = out.text;
      stderrText = err.text;
      stdoutTruncated = out.truncated;
      stderrTruncated = err.truncated;
      exitCode = code;
    } catch (e) {
      if (timer !== null) clearTimeout(timer);
      if (killEscalationTimer !== undefined) clearTimeout(killEscalationTimer);
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
    if (killEscalationTimer !== undefined) clearTimeout(killEscalationTimer);
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
        error: `timeout after ${effectiveTimeoutMs}ms`,
      };
    }

    // Stream truncation surfaces (slice 102, R6 #21). When the
    // drain hit its cap, the canonical response line was likely
    // chopped or the worker is producing pathological output.
    // Short-circuit with a specific error so the caller doesn't
    // misread an invalid-JSON parse as a worker bug. The
    // truncated text + truncation marker are still in stdout/
    // stderr for forensic inspection.
    if (stdoutTruncated) {
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        error: `worker stdout exceeded ${maxStdoutBytes} bytes (truncated; response line likely lost)`,
      };
    }
    if (stderrTruncated) {
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        error: `worker stderr exceeded ${maxStderrBytes} bytes (truncated)`,
      };
    }

    // Extract the last non-empty line of stdout as the response.
    // Noisy stdout (debug prints) is allowed before the response
    // line, but the LAST line is the contract.
    //
    // Slice 84: the three branches below are the "post-spawn
    // crash" detection surface. Each emits a `worker.crashed`
    // telemetry event with its specific cause so operators can
    // discriminate handler bugs (missing_fields) from corrupt
    // writes (invalid_response) from hard crashes (no_response).
    const lines = stdoutText.split('\n').filter((l) => l.length > 0);
    const elapsedMs = now() - spawnStart;
    if (lines.length === 0) {
      emitCrash({
        kind: 'worker.crashed',
        ts: now(),
        cause: 'no_response',
        exitCode,
        stderr: stderrText,
        elapsedMs,
        toolName: request.toolName,
        sandboxProfile: request.sandboxProfile,
      });
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
      // Slice 104 (R6 #42): worker → broker response line is
      // attacker-controlled (a compromised worker emits whatever
      // it wants). `safeJsonParse` strips proto-pollution keys
      // via reviver so downstream code holding the BrokerResponse
      // doesn't inherit poisoned prototypes via spread/merge.
      parsed = safeJsonParse(lastLine);
    } catch (e) {
      emitCrash({
        kind: 'worker.crashed',
        ts: now(),
        cause: 'invalid_response',
        exitCode,
        stderr: stderrText,
        elapsedMs,
        toolName: request.toolName,
        sandboxProfile: request.sandboxProfile,
      });
      return {
        ok: false,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        error: `invalid response: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (!isBrokerResponse(parsed)) {
      emitCrash({
        kind: 'worker.crashed',
        ts: now(),
        cause: 'missing_fields',
        exitCode,
        stderr: stderrText,
        elapsedMs,
        toolName: request.toolName,
        sandboxProfile: request.sandboxProfile,
      });
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
