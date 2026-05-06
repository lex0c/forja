// Run-scoped registry of in-flight asynchronous subagent spawns
// (`task_async` / `task_await` / `task_cancel` — spec
// docs/spec/ORCHESTRATION.md §3). The store is the surface that
// lets the model overlap several `task_async` calls in one turn,
// pick up their outputs in a later turn via `task_await`, and
// optionally pre-empt a misbehaving child with `task_cancel`.
//
// The store sits between the harness's spawn closure (which
// already knows how to call `runSubagent`) and the three async
// subagent tools. Lifecycle:
//
//   1. The harness constructs ONE store at run start, after
//      sessionId resolves. It hands the store a `spawnFn` that
//      accepts (args, perHandleSignal) — that lets the store
//      wire each spawn to a per-handle AbortController without
//      knowing how the parent assembles its own signal.
//   2. `task_async` calls `store.spawn(args)`: the store creates
//      a handle, registers it under a new id, and immediately
//      returns the handle. The underlying work begins as soon
//      as a slot is free in the bounded-concurrency semaphore.
//   3. `task_await(id)` blocks the caller (the model's tool
//      flow) on the corresponding record's promise, optionally
//      with a timeout and the harness's run signal as cancel.
//      Repeat awaits on a settled handle short-circuit through
//      the cached envelope — idempotent by construction.
//   4. `task_cancel(id)` aborts the per-handle controller.
//      Idempotent on unknown / settled handles (returns
//      `cancelled: false` with a reason).
//   5. The harness's outer finally calls `store.drain()` so a
//      hard parent abort still tears every running spawn down
//      before SQLite closes.
//
// Cap semantics (spec §3.3): the store accepts the spawn call
// IMMEDIATELY (handle created right away) but the underlying
// `spawnFn` invocation is queued behind a counted-slot
// semaphore. Excedeu cap ⇒ "spawn aguarda slot livre, não
// rejeita". A cancel that lands while a record is still queued
// causes the record to skip `spawnFn` entirely and resolve as
// `cancelled_before_dispatch` — no child session row is
// created.

import type { SpawnSubagentArgs, SpawnSubagentResult } from '../tools/types.ts';

// Shape exposed to the model. The id is opaque; the name and
// timestamp let the model's planning text refer to a specific
// spawn ("waiting on the explore handle from earlier") without
// having to re-derive from the prompt.
export interface SubagentHandle {
  id: string;
  name: string;
  spawnedAt: number;
}

// Tagged outcome from `await(id, ...)`. The harness translates
// these into tool results (or tool errors) at the task_await
// layer; the store stays agnostic of the wire format.
export type AwaitOutcome =
  | { kind: 'done'; result: SpawnSubagentResult }
  | { kind: 'unknown' }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

// Tagged outcome from `cancel(id)`. `unknown` distinguishes
// "you typed an id we never saw" from `already_settled` ("the
// child already returned"); the model can recover differently
// (look up its prior tool calls vs. just call task_await for
// the cached result).
export type CancelOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: 'unknown' | 'already_settled' };

export interface SubagentHandleStore {
  spawn(args: SpawnSubagentArgs): SubagentHandle;
  awaitHandle(
    id: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AwaitOutcome>;
  cancel(id: string): CancelOutcome;
  // Snapshot of currently-known handles (running + settled).
  // Useful for tests and for a future "subagents in flight"
  // operator readout — the store never persists, this is the
  // only window into its state from outside.
  list(): SubagentHandle[];
  // Number of records whose status is still 'running'. Bounded
  // above by the configured cap.
  inFlightCount(): number;
  // Cancel all running records and await every record's
  // promise. Idempotent. Used by the harness's outer finally.
  drain(): Promise<void>;
}

export interface CreateSubagentHandleStoreOptions {
  // Maximum number of in-flight spawns. The store accepts more
  // than `cap` `spawn` calls but only dispatches `cap` of them
  // through `spawnFn` at any moment; the rest queue. Caller
  // (`runAgent`) is responsible for the clamp + cap constant.
  cap: number;
  // Spawner that knows how to call `runSubagent` with the run's
  // wired-up provider/db/registry/etc. Receives a per-handle
  // `signal` that the store flips on `cancel`. Failures throw
  // — the store's record promise propagates them so the
  // task_await tool surface can map onto a tool error.
  spawnFn: (args: SpawnSubagentArgs, signal: AbortSignal) => Promise<SpawnSubagentResult>;
  // Optional id factory for tests; production uses crypto.randomUUID.
  newId?: () => string;
  // Optional clock; production uses Date.now. Tests override to
  // fix `spawnedAt` so they can assert on a stable value.
  now?: () => number;
}

interface SubagentRecord {
  handle: SubagentHandle;
  promise: Promise<SpawnSubagentResult>;
  controller: AbortController;
  // Goes 'running' → 'settled' exactly once. `settledResult`
  // populates simultaneously with the transition so an `await`
  // call that lands AFTER the transition reads a consistent
  // pair without a race.
  status: 'running' | 'settled';
  settledResult: SpawnSubagentResult | null;
}

export const createSubagentHandleStore = (
  options: CreateSubagentHandleStoreOptions,
): SubagentHandleStore => {
  const { spawnFn, cap } = options;
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const now = options.now ?? ((): number => Date.now());
  const records = new Map<string, SubagentRecord>();

  // Slot semaphore. `inFlight` counts records currently inside
  // their `spawnFn` call; queued waiters resolve in FIFO order
  // when a slot frees. The waiters list holds plain resolvers
  // — promise creation lives at the call site (`acquireSlot`).
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const acquireSlot = (): Promise<void> => {
    if (inFlight < cap) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        inFlight += 1;
        resolve();
      });
    });
  };
  const releaseSlot = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };

  const cancelledBeforeDispatch = (spawnedAt: number): SpawnSubagentResult => ({
    kind: 'ran',
    output: '',
    sessionId: '',
    status: 'interrupted',
    reason: 'cancelled_before_dispatch',
    costUsd: 0,
    steps: 0,
    durationMs: now() - spawnedAt,
  });

  const synthesizeSpawnError = (e: unknown, spawnedAt: number): SpawnSubagentResult => ({
    kind: 'ran',
    output: '',
    sessionId: '',
    status: 'error',
    reason: 'spawn_failed',
    costUsd: 0,
    steps: 0,
    durationMs: now() - spawnedAt,
    auditFailure: {
      code: 'subagent.spawn_throw',
      message: e instanceof Error ? e.message : String(e),
    },
  });

  const spawn = (args: SpawnSubagentArgs): SubagentHandle => {
    const id = newId();
    const spawnedAt = now();
    const handle: SubagentHandle = { id, name: args.name, spawnedAt };
    const controller = new AbortController();

    // Construct the record FIRST with a placeholder promise; the
    // real promise (next block) closes over it so the spawn body
    // can flip its status synchronously with the result becoming
    // visible. Doing the flip INSIDE the async body — instead of
    // attaching a separate `.then` after the promise — eliminates
    // the race window between promise resolution and an external
    // `.then` observer that the previous design had: a `cancel()`
    // that landed AFTER the spawn settled but BEFORE the
    // post-promise `.then` ran could observe `status === 'running'`
    // and emit a misleading `cancelled: true`.
    //
    // `spawnFn` rejections are caught locally and synthesized
    // into an error envelope so `awaitHandle` consumers see one
    // shape on settle (`kind: 'done'` with a structured result)
    // — no try/catch on the consumer side.
    const record: SubagentRecord = {
      handle,
      // Placeholder, replaced below before the IIFE has a chance
      // to settle. TS-side cast keeps the field non-optional in
      // the record shape; the assignment lands synchronously
      // immediately after `promise` is constructed.
      promise: undefined as unknown as Promise<SpawnSubagentResult>,
      controller,
      status: 'running',
      settledResult: null,
    };

    const promise = (async (): Promise<SpawnSubagentResult> => {
      await acquireSlot();
      let result: SpawnSubagentResult;
      try {
        if (controller.signal.aborted) {
          result = cancelledBeforeDispatch(spawnedAt);
        } else {
          try {
            result = await spawnFn(args, controller.signal);
          } catch (e) {
            result = synthesizeSpawnError(e, spawnedAt);
          }
        }
      } finally {
        releaseSlot();
      }
      record.status = 'settled';
      record.settledResult = result;
      return result;
    })();

    record.promise = promise;
    records.set(id, record);

    return handle;
  };

  const awaitHandle = async (
    id: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AwaitOutcome> => {
    const record = records.get(id);
    if (record === undefined) return { kind: 'unknown' };
    // Fast path: settled before we even arrive.
    if (record.status === 'settled' && record.settledResult !== null) {
      return { kind: 'done', result: record.settledResult };
    }
    const timeoutMs = options?.timeoutMs;
    const externalSignal = options?.signal;
    if (externalSignal?.aborted === true) return { kind: 'aborted' };
    return await new Promise<AwaitOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: AwaitOutcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (externalSignal !== undefined) {
          externalSignal.removeEventListener('abort', onAbort);
        }
        resolve(outcome);
      };
      const onAbort = (): void => settle({ kind: 'aborted' });
      const timer =
        timeoutMs === undefined ? null : setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
      if (externalSignal !== undefined) {
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
      // The store's promise resolves with a structured envelope
      // in every case — `spawnFn` failures are caught and
      // synthesized inside the spawn body, so this promise
      // never rejects. A reject handler would be dead code; we
      // omit it so a future maintainer doesn't read the
      // existence of one as evidence the underlying promise can
      // throw.
      record.promise.then((r) => settle({ kind: 'done', result: r }));
    });
  };

  const cancel = (id: string): CancelOutcome => {
    const record = records.get(id);
    if (record === undefined) return { cancelled: false, reason: 'unknown' };
    if (record.status === 'settled') {
      return { cancelled: false, reason: 'already_settled' };
    }
    record.controller.abort();
    return { cancelled: true };
  };

  const list = (): SubagentHandle[] => Array.from(records.values()).map((r) => ({ ...r.handle }));

  const inFlightCount = (): number => {
    let n = 0;
    for (const r of records.values()) {
      if (r.status === 'running') n += 1;
    }
    return n;
  };

  const drain = async (): Promise<void> => {
    // Cancel every still-running record. The records' own
    // promises will settle (either via the cancelled-before-
    // dispatch synthesis or via spawnFn returning an
    // interrupted result). We await every record's promise via
    // `Promise.allSettled` so a single throwing promise doesn't
    // strand the others.
    for (const r of records.values()) {
      if (r.status === 'running') r.controller.abort();
    }
    await Promise.allSettled(Array.from(records.values()).map((r) => r.promise));
  };

  return { spawn, awaitHandle, cancel, list, inFlightCount, drain };
};
