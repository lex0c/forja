// In-process broker — PERMISSION_ENGINE.md §13.7 first
// implementation. Degenerate case: the broker runs in the main
// process and delegates execution to a caller-supplied `exec`
// function. No process separation, no sandbox wrap of its own
// (the supplied exec handles that, per the existing
// sandbox-runner).
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

export const createInProcessBroker = (options: CreateInProcessBrokerOptions): Broker => {
  // Single in-flight chain — serializes concurrent execute()
  // calls without needing a queue data structure. Each new call
  // chains its body onto the tail of the previous promise.
  let inFlight: Promise<void> = Promise.resolve();
  let closed = false;

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
      // Chain onto inFlight so calls serialize. We capture the
      // result via a deferred-result pattern: the chain runs
      // exec, stores the result in `result`, signals completion.
      // The outer Promise returns the stored result after the
      // chain advances.
      let result: BrokerResponse;
      const myTurn = inFlight.then(async () => {
        try {
          result = await options.exec(request, callOptions);
        } catch (e) {
          result = {
            ok: false,
            stdout: '',
            stderr: '',
            error: `exec threw: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      });
      // Keep the chain link even if this call fails — the next
      // queued call should still proceed.
      inFlight = myTurn.catch(() => {
        // Suppress — error already mapped into `result`.
      });
      await myTurn;
      // result is always assigned by the time myTurn resolves
      // (the only async step is options.exec, whose throw is
      // caught above into a BrokerResponse).
      // biome-ignore lint/style/noNonNullAssertion: assigned in myTurn before await resolves
      return result!;
    },
    close: async (): Promise<void> => {
      // Wait for any in-flight call to finish before closing.
      // Idempotent: subsequent close() calls await the same
      // (already-settled) inFlight.
      closed = true;
      await inFlight;
    },
  };
};
