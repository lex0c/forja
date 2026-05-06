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

import type { DB } from '../storage/db.ts';
import {
  insertSubagentHandle,
  listSubagentHandlesByParent,
  settleSubagentHandle,
  updateSubagentHandleChildSession,
} from '../storage/repos/subagent-handles.ts';
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
  // Snapshot of EVERY handle this store knows about, including
  // ones rehydrated from a prior run (resume path). Use this
  // for audit listings; do NOT use it as a "subagents in
  // flight" operator readout — rehydrated handles are
  // status='settled' (resumed_session), and any UI that wants
  // "currently active" should call `inFlightCount()` (a cheap
  // counter that filters by status) or filter `list()` by
  // ignoring handles whose `spawnedAt` predates the store's
  // construction time. We don't filter at this layer because
  // both flavors are useful — the audit consumer wants every
  // row, the UI wants only live ones.
  list(): SubagentHandle[];
  // Number of records whose status is still 'running'. Bounded
  // above by the configured cap. Always reflects only the
  // current run's in-flight spawns: rehydrated handles enter
  // the records map already as 'settled'.
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
  // Optional persistence binding. When set, the store mirrors
  // every handle lifecycle event into the `subagent_handles`
  // table:
  //   - spawn → INSERT row (status='running')
  //   - dispatch settles with a child session id → UPDATE row
  //     with `child_session_id`
  //   - settle → UPDATE row to status='settled' + payload JSON
  // On construction the store ALSO loads any existing rows for
  // the given parent_session_id and rehydrates them: settled
  // rows return their cached envelope on `awaitHandle`; running
  // rows (parent crashed mid-spawn) are mass-converted to
  // `interrupted/reason=resumed_session` so a resumed run sees
  // a coherent envelope instead of `unknown_handle`. Production
  // callers pass this; tests use the in-memory variant by
  // omitting it.
  persistTo?: { db: DB; parentSessionId: string };
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

// Envelope payload mirroring `SpawnSubagentResult` shape, used
// when settling a row in the DB. The forward direction
// (`envelopeToJson`) is safe by construction — a real envelope
// is always shape-correct at the source. The reverse direction
// is defensive: rehydrating from JSON could see (a) a
// shape-corrupt payload from storage rot, (b) a payload written
// by an OLDER version of the schema, or (c) a payload normally
// written by `settleSubagentHandle` whose source kind is
// `unknown_subagent` / `depth_exceeded` (legal envelope shapes
// that survive round-trip and must be discriminated).
const envelopeToJson = (env: SpawnSubagentResult): Record<string, unknown> =>
  env as unknown as Record<string, unknown>;

const isStringArray = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((v) => typeof v === 'string');

const validateRanStatus = (s: unknown): 'done' | 'interrupted' | 'exhausted' | 'error' => {
  if (s === 'done' || s === 'interrupted' || s === 'exhausted' || s === 'error') return s;
  return 'error';
};

const envelopeFromJson = (raw: Record<string, unknown>): SpawnSubagentResult => {
  // Discriminate on `kind`. Each branch validates only the
  // fields downstream callers will read; missing/wrong-typed
  // ones default to safe values rather than letting the cast
  // smuggle `undefined` past the type system. Spec
  // ORCHESTRATION.md §3 leaves the wire shape opaque so the
  // safe defaults below are not observable to the model — they
  // only protect downstream tools (task_await) from crashing
  // on storage corruption or version skew.
  if (raw.kind === 'unknown_subagent' && typeof raw.requested === 'string') {
    return {
      kind: 'unknown_subagent',
      requested: raw.requested,
      available: isStringArray(raw.available) ? raw.available : [],
    };
  }
  if (
    raw.kind === 'depth_exceeded' &&
    typeof raw.requested === 'string' &&
    typeof raw.depth === 'number' &&
    typeof raw.maxDepth === 'number'
  ) {
    return {
      kind: 'depth_exceeded',
      requested: raw.requested,
      depth: raw.depth,
      maxDepth: raw.maxDepth,
    };
  }
  // Everything else falls into `kind: 'ran'`. Unknown kinds
  // are treated as a corrupt "ran" row with status='error' —
  // task_await maps that to `subagent.run_failed` which is the
  // safest tool-error shape we can show the model.
  const auditFailureRaw = raw.auditFailure;
  return {
    kind: 'ran',
    output: typeof raw.output === 'string' ? raw.output : '',
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    status: validateRanStatus(raw.status),
    reason: typeof raw.reason === 'string' ? raw.reason : 'corrupt_envelope',
    costUsd: typeof raw.costUsd === 'number' ? raw.costUsd : 0,
    steps: typeof raw.steps === 'number' ? raw.steps : 0,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    ...(typeof auditFailureRaw === 'object' &&
    auditFailureRaw !== null &&
    !Array.isArray(auditFailureRaw) &&
    typeof (auditFailureRaw as { code?: unknown }).code === 'string' &&
    typeof (auditFailureRaw as { message?: unknown }).message === 'string'
      ? {
          auditFailure: {
            code: (auditFailureRaw as { code: string }).code,
            message: (auditFailureRaw as { message: string }).message,
          },
        }
      : {}),
  };
};

const resumedSessionEnvelope = (now: number, spawnedAt: number): SpawnSubagentResult => ({
  kind: 'ran',
  output: '',
  sessionId: '',
  status: 'interrupted',
  reason: 'resumed_session',
  costUsd: 0,
  steps: 0,
  durationMs: now - spawnedAt,
});

export const createSubagentHandleStore = (
  options: CreateSubagentHandleStoreOptions,
): SubagentHandleStore => {
  const { spawnFn, cap } = options;
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const now = options.now ?? ((): number => Date.now());
  const persistTo = options.persistTo;
  const records = new Map<string, SubagentRecord>();

  // Rehydrate existing rows. A fresh session has zero rows; a
  // resumed session inherits whatever the previous run left
  // behind. Each row is processed individually:
  //   - status='settled': replay the cached envelope (parsed
  //     defensively in `envelopeFromJson`).
  //   - status='running': synthesize `resumed_session` with a
  //     PER-ROW `durationMs = now - row.spawnedAt`, then settle
  //     that row with the synthesized envelope. Settle is
  //     write-once at the repo layer, so a sibling subprocess
  //     that finishes after this constructor cannot overwrite
  //     the resumed envelope.
  // Listing inside the same constructor (vs. mass-update
  // followed by list) keeps `durationMs` correct per row — a
  // mass UPDATE would have to embed a single envelope and any
  // single envelope picks one duration.
  //
  // **Concurrency assumption**: only ONE process at a time may
  // hold a session id open. Spec
  // `STATE_MACHINE.md §105` and `ORCHESTRATION.md §11`
  // mandate a per-cwd lockfile (`.agent/lock`) that enforces
  // this. The mass-settle here is destructive: every running
  // row owned by `parentSessionId` is converted to
  // `resumed_session`. If two parent processes simultaneously
  // construct stores against the same `parentSessionId` (which
  // the lockfile is supposed to prevent), each would settle
  // the other's in-flight handles. The lockfile is the
  // load-bearing invariant; this constructor TRUSTS it.
  // FAILURE_MODES.md §200 documents the lockfile-detection
  // path. If a programmatic caller bypasses it, the corruption
  // surface is bounded to whichever handles the second store
  // sees as 'running' — the first store's settle calls then
  // become no-ops (write-once), so each parent ends up with a
  // coherent self-view, just one parent's view is wrong about
  // who got there first.
  if (persistTo !== undefined) {
    const rows = listSubagentHandlesByParent(persistTo.db, persistTo.parentSessionId);
    const tNow = now();
    for (const row of rows) {
      let cached: SpawnSubagentResult;
      if (row.status === 'settled' && row.settledPayload !== null) {
        cached = envelopeFromJson(row.settledPayload);
      } else {
        // Running row → synthesize per-row resumed_session and
        // commit to DB. settleSubagentHandle is write-once: if
        // some other writer races us here (a stray subprocess
        // settling after the parent crashed), the loser keeps
        // its rehydrated payload from the winner — same record
        // the resumed run will surface either way, since both
        // settle paths agree on the wire shape via the JSON
        // round-trip.
        cached = resumedSessionEnvelope(tNow, row.spawnedAt);
        settleSubagentHandle(persistTo.db, row.handleId, envelopeToJson(cached));
        // Re-read the persisted payload — if a competing
        // settle won the race, we want the SURVIVING envelope
        // in memory so awaitHandle returns what audit will
        // show. Cheap (single-row read on the same DB
        // connection that just attempted the write).
        const refreshed = listSubagentHandlesByParent(persistTo.db, persistTo.parentSessionId).find(
          (r) => r.handleId === row.handleId,
        );
        if (refreshed !== undefined && refreshed.settledPayload !== null) {
          cached = envelopeFromJson(refreshed.settledPayload);
        }
      }
      const handle: SubagentHandle = {
        id: row.handleId,
        name: row.name,
        spawnedAt: row.spawnedAt,
      };
      const controller = new AbortController();
      const record: SubagentRecord = {
        handle,
        promise: Promise.resolve(cached),
        controller,
        status: 'settled',
        settledResult: cached,
      };
      records.set(row.handleId, record);
    }
  }

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

    // Persist the handle row BEFORE the IIFE schedules — a
    // crash between issuance and dispatch leaves a recoverable
    // 'running' row that resume converts to interrupted. The
    // INSERT runs synchronously (bun:sqlite is sync); failure
    // here means the DB is unhealthy and we want to surface
    // it now rather than after a spawn already burned tokens.
    if (persistTo !== undefined) {
      insertSubagentHandle(persistTo.db, {
        handleId: id,
        parentSessionId: persistTo.parentSessionId,
        name: args.name,
        spawnedAt,
      });
    }

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
      // Persist the linkage + final envelope. We bind
      // child_session_id BEFORE settling so a concurrent reader
      // sees the map intact even if the settle write fails for
      // some reason (it shouldn't — the row was just inserted —
      // but ordering is cheap and the contract is "row is
      // either fully settled or recoverable as running"). Empty
      // sessionId (cancelled-before-dispatch and spawn-failed
      // paths) is left null in the column.
      if (persistTo !== undefined) {
        if (result.kind === 'ran' && result.sessionId.length > 0) {
          updateSubagentHandleChildSession(persistTo.db, id, result.sessionId);
        }
        settleSubagentHandle(persistTo.db, id, envelopeToJson(result));
      }
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
