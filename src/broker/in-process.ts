// In-process broker — PERMISSION_ENGINE.md §13.7 first
// implementation. Degenerate case: the broker runs in the main
// process and delegates execution to a caller-supplied `exec`
// function. No process separation AND no sandbox wrap — the
// production caller (`bootstrap.ts:constructBroker` in
// `mode === 'in-process'`) passes `bashHandler.execute`, which
// `Bun.spawn`s `bash -s` directly with scrubEnv only. The
// previous wording here ("the supplied exec handles that, per
// the existing sandbox-runner") was aspirational and factually
// wrong against the live wire-up; sandbox wrap only happens in
// the `'spawn'` broker mode (which closes `maybeWrapSandboxArgv`
// over the worker spawn). Operators wanting enforcement must
// set brokerMode to 'spawn' explicitly AND run from a source
// checkout (compiled binaries can't address the worker.ts
// path — bootstrap.ts:1532 surfaces this as a hard error rather
// than silently degrading to in-process).
//
// Why ship this first: the security upgrade from the spec
// (line 928, "CLI main não tem exec privilege") requires
// running the broker in a SEPARATE process — that's substantial
// IPC + worker-script plumbing. Shipping the CONTRACT first
// (Broker interface + types) and a degenerate in-process impl
// lets the engine harness integrate against the abstraction
// BEFORE the multi-process plumbing lands. Each piece becomes
// independently reviewable + testable.
//
// FIFO serialization: concurrent `execute` calls queue and run
// one at a time. The main process is single-threaded JS, so
// "concurrent" here means "another `execute` is in-flight via
// async/await". Serializing keeps state-machine + telemetry
// reasoning straightforward — a tool that emits side effects
// (audit row, telemetry event) lands before the next call
// observes that state. A future separate-process broker MAY
// parallelize across workers; callers shouldn't rely on order.
//
// Failure handling: the supplied `exec` MUST return a
// BrokerResponse — it must NOT throw. The in-process broker
// wraps the call in try/catch defensively + maps unexpected
// throws to `{ok: false, error: "exec threw: ..."}`. Production
// `exec` implementations (wraps around the sandbox runner) are
// expected to handle their own error paths.
//
// Slice 121 (R5) hardenings:
//   - `exec` snapshotted at construction (caller can't swap it
//     post-construction via mutable options reference)
//   - close() aborts a master signal so in-flight calls that
//     honor signals wind down promptly (vs hanging on natural
//     completion)
//   - per-call `timeoutMs` enforced (was silently ignored,
//     asymmetric with spawn broker)
//   - error-message extraction defended against throwing getters
//   - request.args scrubbed of proto-pollution keys at broker
//     boundary (defense in depth for downstream handlers using
//     `Object.assign({}, args)`)
//
// Close+execute invariant: an execute() call that passes the sync
// `if (closed)` check WILL run its exec to completion (or to its
// own timeout/abort) — close() does NOT retroactively cancel a
// scheduled-but-not-yet-running call. JS single-threaded
// semantics close the apparent "sync-check then async-chain" race
// because both branches execute in one synchronous block. close()
// is therefore guaranteed not to leave callers wondering "did my
// call run?": every call that returned past the closed-check did
// run. close() may still wait on the in-flight exec; the master
// signal abort gives signal-honoring execs a way to bail early.

import { scrubProtoPollution } from './safe-json.ts';
import type { Broker, BrokerCallOptions, BrokerRequest, BrokerResponse } from './types.ts';

export interface CreateInProcessBrokerOptions {
  // The actual tool exec function. Receives a fully-validated
  // BrokerRequest plus per-call options (slice 83: signal for
  // cancellation). Returns the response. Slice 78 doesn't define
  // WHAT this function looks like — that's the harness wire-up's
  // concern. Tests pass capturing / scripted implementations.
  // Implementations that ignore the options parameter remain valid
  // (TypeScript allows fewer-arg functions).
  exec: (request: BrokerRequest, options?: BrokerCallOptions) => Promise<BrokerResponse>;
}

// Compose AbortSignals into a linked controller + disposer.
// Returned signal aborts when ANY source aborts. Returns the
// first aborted source unchanged when one is already aborted
// at link time (no listener attached, dispose is a no-op).
// Single-source case returns that source directly (no allocation).
//
// Slice 125 (R2 P1): pre-slice linkSignals only returned the
// signal — listeners on caller-signal AND master-signal stayed
// attached forever when neither fired (long-lived broker, never-
// aborting caller signal, exec returns naturally). One extra
// listener accumulated PER call indefinitely. Now the call site
// invokes `dispose()` in its finally block; non-firing listeners
// are explicitly removed.
interface LinkedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

const linkSignals = (...sources: readonly (AbortSignal | undefined)[]): LinkedSignal => {
  const real = sources.filter((s): s is AbortSignal => s !== undefined);
  const noop = (): void => {
    // empty
  };
  if (real.length === 0) {
    return { signal: new AbortController().signal, dispose: noop };
  }
  const alreadyAborted = real.find((s) => s.aborted);
  if (alreadyAborted !== undefined) {
    return { signal: alreadyAborted, dispose: noop };
  }
  if (real.length === 1) {
    return { signal: real[0] as AbortSignal, dispose: noop };
  }
  const ctrl = new AbortController();
  const listeners: Array<{ source: AbortSignal; fn: () => void }> = [];
  for (const s of real) {
    const onAbort = (): void => ctrl.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    listeners.push({ source: s, fn: onAbort });
  }
  const dispose = (): void => {
    for (const { source, fn } of listeners) {
      source.removeEventListener('abort', fn);
    }
  };
  return { signal: ctrl.signal, dispose };
};

// Safe error-message extraction. `e.message` may be a getter
// that itself throws (rare but possible via `Object.defineProperty`
// or proxies); `String(e)` may call a throwing `Symbol.toPrimitive`
// or `toString`. Layered fallbacks ensure the broker's error path
// never propagates a SECONDARY throw from inside the mapping.
const safeErrorMessage = (e: unknown): string => {
  if (e instanceof Error) {
    try {
      const m = e.message;
      if (typeof m === 'string') return m;
    } catch {
      // fall through to String() coercion
    }
  }
  try {
    return String(e);
  } catch {
    return '<unrepresentable>';
  }
};

export const createInProcessBroker = (options: CreateInProcessBrokerOptions): Broker => {
  // Snapshot `exec` at construction. Once the broker exists, the
  // caller can't swap the function under us by mutating their
  // CreateInProcessBrokerOptions reference. (R5 P0)
  const exec = options.exec;

  // Single in-flight chain — serializes concurrent execute()
  // calls without needing a queue data structure. Each new call
  // chains its body onto the tail of the previous promise.
  let inFlight: Promise<void> = Promise.resolve();
  let closed = false;

  // Master abort controller for shutdown. close() aborts it so
  // in-flight execs that honor `callOptions.signal` wind down
  // promptly (vs close() blocking on natural completion of a
  // long-running call). The aborted reason carries 'broker
  // closing' so handlers can distinguish broker shutdown from
  // caller-initiated abort.
  const masterCtrl = new AbortController();

  return {
    execute: async (
      request: BrokerRequest,
      callOptions?: BrokerCallOptions,
    ): Promise<BrokerResponse> => {
      // Synchronous fast-reject when the broker is already closed —
      // no need to await the chain tail just to return an error.
      if (closed) {
        return {
          ok: false,
          stdout: '',
          stderr: '',
          error: 'broker closed',
        };
      }

      // Compose the effective abort signal: caller's + master.
      // If `timeoutMs > 0` is supplied, also link a timer that
      // aborts on expiry. timeoutMs = 0 disables the outer guard
      // (per BrokerCallOptions docs); undefined → no timer here
      // (the in-process broker has no construction-level default).
      //
      // Slice 125 (R2 P1): linkSignals returns a disposer that
      // unhooks listeners on non-aborting sources. Called in the
      // finally block below — pre-slice listeners accumulated on
      // long-lived signals when neither source fired.
      const baseLinked = linkSignals(callOptions?.signal, masterCtrl.signal);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timeoutCtrl: AbortController | undefined;
      let effectiveLinked = baseLinked;
      const tms = callOptions?.timeoutMs;
      if (tms !== undefined && Number.isFinite(tms) && tms > 0) {
        timeoutCtrl = new AbortController();
        effectiveLinked = linkSignals(baseLinked.signal, timeoutCtrl.signal);
        timeoutHandle = setTimeout(() => {
          timeoutCtrl?.abort(new Error(`broker timeout after ${tms}ms`));
        }, tms);
      }

      const effectiveCallOptions: BrokerCallOptions = {
        ...callOptions,
        signal: effectiveLinked.signal,
      };

      // Defense in depth: scrub proto-pollution keys from args
      // before passing to exec. The harness builds requests from
      // upstream sources (LLM tool-call JSON parsed by the SDK,
      // engine resolver output). An attacker landing
      // `args.__proto__: {...}` would pollute every handler that
      // does `Object.assign({}, args)`. Returns the same reference
      // when no scrubbing was needed — zero allocation common case.
      const scrubbedArgs = scrubProtoPollution(request.args) as Record<string, unknown>;
      const scrubbed: BrokerRequest =
        scrubbedArgs === request.args ? request : { ...request, args: scrubbedArgs };

      // Chain onto inFlight so calls serialize. We capture the
      // result via a deferred-result pattern: the chain runs
      // exec, stores the result in `result`, signals completion.
      // The outer Promise returns the stored result after the
      // chain advances.
      let result: BrokerResponse | undefined;
      const myTurn = inFlight.then(async () => {
        try {
          result = await exec(scrubbed, effectiveCallOptions);
        } catch (e) {
          result = {
            ok: false,
            stdout: '',
            stderr: '',
            error: `exec threw: ${safeErrorMessage(e)}`,
          };
        }
      });
      // Keep the chain link even if this call fails — the next
      // queued call should still proceed.
      inFlight = myTurn.catch(() => {
        // Suppress — error already mapped into `result`.
      });
      try {
        await myTurn;
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        // Slice 125 (R2 P1): unhook linkSignals listeners. When
        // sources didn't fire, the {once:true} attachment stays
        // until the source itself aborts (potentially forever
        // for a long-lived caller signal + never-closed broker).
        effectiveLinked.dispose();
        if (effectiveLinked !== baseLinked) baseLinked.dispose();
      }
      // result is always assigned by the time myTurn resolves: the
      // chain's only branches (early-close, exec success, exec
      // throw) all assign result before returning. Non-null
      // assertion is therefore safe; if it ever returned undefined
      // we'd have a logic bug elsewhere in this function.
      // biome-ignore lint/style/noNonNullAssertion: assigned in myTurn before await resolves
      return result!;
    },
    close: async (): Promise<void> => {
      // Set closed first so synchronously-pending execute() calls
      // see the close before they queue (sync fast-reject branch).
      // Then abort the master signal so in-flight calls that honor
      // signals wind down promptly. Then await inFlight to settle.
      // Idempotent: subsequent close() calls await the same
      // (already-settled) inFlight and re-abort the (already-
      // aborted) master signal as a no-op.
      closed = true;
      if (!masterCtrl.signal.aborted) {
        masterCtrl.abort(new Error('broker closing'));
      }
      await inFlight;
    },
  };
};
