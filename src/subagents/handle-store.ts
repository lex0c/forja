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

// Detailed shape for `task_list` consumers (the model via the
// `task_list` tool, plus the `/subagents` operator slash).
// Carries the running/settled status, the spawn metadata, and
// a summary of the settled envelope when applicable. The full
// envelope is intentionally NOT exposed — it can be 100+ KiB of
// child output, and a list operation should be cheap. The model
// follows up with `task_await(id)` when it wants the body.
export interface SubagentHandleSummary {
  id: string;
  name: string;
  spawnedAt: number;
  status: 'running' | 'settled';
  // Settled-envelope kind discriminator (review fix Q3).
  // Present iff status === 'settled'. Lets the model triage
  // settled handles WITHOUT a follow-up `task_await` —
  // `'ran'` means the child produced an outcome (a `settled`
  // summary block follows); the other three kinds are
  // refusals (no summary block, since refusals carry
  // structured metadata that's not the child outcome shape).
  // Without this discriminator, settled-without-summary was
  // ambiguous — model couldn't tell "ran with no summary"
  // from "refused"; with it, the surface is unambiguous.
  kind?: 'ran' | 'unknown_subagent' | 'depth_exceeded' | 'budget_exhausted';
  // Present iff status is 'settled' and the envelope's `kind`
  // is `'ran'` (the only kind that carries a child outcome).
  // Other kinds — `unknown_subagent`, `depth_exceeded`,
  // `budget_exhausted` — surface as a tool error from
  // `task_await`; readers of this list see them as `settled`
  // with `kind` discriminating, but no `settled` summary
  // block since the refusal payload doesn't fit the
  // child-outcome shape.
  settled?: {
    childStatus: 'done' | 'interrupted' | 'exhausted' | 'error';
    reason: string;
    costUsd: number;
    steps: number;
    durationMs: number;
    // Child session id. Null for the cancelled-before-dispatch
    // path (no child session was ever created) and for the
    // resumed_session synthesized envelope. Lets audit consumers
    // join back to the child's full session.
    childSessionId: string | null;
    // Cancel attribution (D217). Only present when this row was
    // explicitly cancelled by one of the harness paths.
    cancelSource?: 'model' | 'cap_watchdog' | 'parent_drain';
  };
}

// Tagged outcome from `await(id, ...)`. The harness translates
// these into tool results (or tool errors) at the task_await
// layer; the store stays agnostic of the wire format.
export type AwaitOutcome =
  | { kind: 'done'; result: SpawnSubagentResult }
  | { kind: 'unknown' }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

// Tagged outcome from `cancel(id, reason)`. `unknown` distinguishes
// "you typed an id we never saw" from `already_settled` ("the
// child already returned"); the model can recover differently
// (look up its prior tool calls vs. just call task_await for
// the cached result).
export type CancelOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: 'unknown' | 'already_settled' };

// Why the cancel happened. Required at every cancel call site
// so the settled handle's audit row distinguishes operator-
// driven cancellation from harness-driven one. Persisted into
// `subagent_handles.settled_payload.reason` as
// `cancelled_${reason}`, e.g. `cancelled_model` /
// `cancelled_cap_watchdog` / `cancelled_parent_drain`.
//
//   - `model`: the assistant emitted a `task_cancel` tool_use
//     for this specific handle.
//   - `cap_watchdog`: the cost-progress watchdog observed a
//     cumulative spend cross `maxCostUsd` mid-flight and
//     called `cancelAll` to tear down every active handle
//     (spec ORCHESTRATION.md §3.5). Distinguishing this from
//     a model-driven cancel is the audit signal operators
//     need to triage "why did my run die?" — the cap was
//     exceeded, not the model giving up.
//   - `parent_drain`: the harness's outer finally is shutting
//     down (run end, signal abort, wall-clock timeout) and is
//     terminating any still-active handle. Symmetric to the
//     `resumed_session` envelope on the prior side of a
//     parent crash: both mean "parent went away," but
//     `parent_drain` happens within a single run while
//     `resumed_session` happens after a crash.
export type CancelReason = 'model' | 'cap_watchdog' | 'parent_drain';

export interface SpawnOptions {
  // Pessimistic worst-case cost estimate for this spawn, in
  // USD. Used by the cost reservation tracker (spec
  // ORCHESTRATION.md §3.5). Source: definition.budget.maxCostUsd
  // looked up at the call site. REQUIRED so a programmatic
  // caller can't bypass the cap by omitting the estimate; pass
  // 0 only when the definition itself declares zero cost
  // (which the loader rejects in production — see
  // `subagents/load.ts`). Tests that don't model budget can
  // pass 0 to opt out without compromising the production
  // invariant.
  estimateCostUsd: number;
}

export interface SubagentHandleStore {
  spawn(args: SpawnSubagentArgs, options: SpawnOptions): SubagentHandle;
  awaitHandle(
    id: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<AwaitOutcome>;
  cancel(id: string, reason: CancelReason): CancelOutcome;
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
  // Detailed snapshot for `task_list` (model-facing) and
  // `/subagents` (operator-facing). Includes status and a
  // summary of settled `kind: 'ran'` envelopes. Same set of
  // records as `list()` — both rehydrated and current-run
  // handles — so the model that lost handle ids across a
  // compaction or a resume cycle can recover them.
  listDetailed(): SubagentHandleSummary[];
  // Number of records whose status is still 'running'. Bounded
  // above by the configured cap. Always reflects only the
  // current run's in-flight spawns: rehydrated handles enter
  // the records map already as 'settled'.
  inFlightCount(): number;
  // Number of records that have been spawned but have not yet
  // passed the slot semaphore (`acquireSlot`). Sum of
  // `inFlightCount` (dispatched but not settled) +
  // `queuedCount` (waiting for a slot) equals the total
  // unsettled work the model has issued. Used by the harness
  // to populate the `parallel_status.subagentsQueued` figure
  // — the operator's footer shows `subagents R+Q/cap` so a
  // burst of `task_async` calls beyond the cap is visible
  // rather than collapsing into a single `subagents N`
  // counter.
  queuedCount(): number;
  // Cancel all running records and await every record's
  // promise. Idempotent. Used by the harness's outer finally.
  // `reason` propagates to every cancelled record's audit row;
  // pass `'parent_drain'` from the outer finally so postmortem
  // queries can distinguish a graceful shutdown cancel from a
  // cap-watchdog kill.
  drain(reason: CancelReason): Promise<void>;
  // Cancel every running record without awaiting (synchronous).
  // Used by the cost-cap watchdog when the live total crosses
  // the run's cap mid-flight (spec ORCHESTRATION.md §3.5):
  // active children get the abort signal immediately so they
  // tear down gracefully via their next IPC interrupt boundary.
  // Idempotent; rows already settled are skipped. `reason`
  // tags every newly-cancelled record's audit row with the
  // source (almost always `'cap_watchdog'`).
  cancelAll(reason: CancelReason): void;
  // Record a live cost-update from the child via IPC. Called
  // by the harness's onChildEvent forwarder after a
  // `cost_update` HarnessEvent lands. `cumulative` is the
  // child's running self-cost (NOT a delta). The store stores
  // it on the matching record and the next
  // `getReservedChildCostUsd` reflects it. No-op on unknown
  // handles or already-settled records.
  recordLiveCost(handleId: string, cumulative: number): void;
  // Reservation against the run's cost cap, in USD. Returns
  // `sum(max(estimate, live))` over every running record. The
  // `max` keeps the floor pessimistic until the child reports
  // its first `cost_update`; once `live > estimate` the
  // reservation grows with the actual spend (covers the rare
  // case of a child overshooting its declared budget).
  // Drops to 0 once every handle is settled.
  //
  // Optional `excludeHandleId` filters out one specific record
  // — used by the dispatcher's pre-spawn cost gate. When the
  // store dispatches `spawnFn`, the record is ALREADY in the
  // map (its estimate already in this sum). The gate then
  // computes `spent + estimate` for the new spawn — without
  // exclusion, the same estimate is counted twice and async
  // spawns get false `subagent.budget_exhausted` at cap
  // boundaries (exactly when remaining budget == estimate).
  // Sync `task` doesn't pass through the store, so an
  // `undefined` argument is the safe no-op.
  getReservedChildCostUsd(excludeHandleId?: string): number;
  // Sum of `costUsd` from settled children's envelopes
  // (`SpawnSubagentResult.kind === 'ran'` branch only). Climbs
  // monotonically across the run as children settle. Used by
  // the same pre-spawn check.
  getSettledChildCostUsd(): number;
  // Latest live cost reported by the child via cost_update
  // for a specific handle. Returns 0 on unknown handles or
  // when no cost_update has landed yet. Used by the harness
  // to reconcile the terminal envelope's `costUsd` against
  // the live tracker — a watchdog-killed child reports
  // `costUsd: 0` in its terminal payload (the runtime hardcodes
  // it), but the live tracker has the actual mid-run spend
  // captured via IPC. Without this reconciliation,
  // `cumulativeChildCostUsd` would lose every kill-during-run
  // cost. Spec ORCHESTRATION.md §3.5.
  getLiveCostUsd(handleId: string): number;
  // Sum of cost from rehydrated settled rows captured at
  // store construction time. Zero on a fresh session;
  // non-zero only when the store rehydrates a resumed
  // session's prior handles. The harness adds this to
  // `priorCostUsd` so the resumed run's cap accounts for
  // child cost already spent in prior runs (the
  // `sessions.totalCostUsd` column is parent-self only).
  getRehydratedChildCostUsd(): number;
}

export interface CreateSubagentHandleStoreOptions {
  // Maximum number of in-flight spawns. The store accepts more
  // than `cap` `spawn` calls but only dispatches `cap` of them
  // through `spawnFn` at any moment; the rest queue. Caller
  // (`runAgent`) is responsible for the clamp + cap constant.
  cap: number;
  // Spawner that knows how to call `runSubagent` with the run's
  // wired-up provider/db/registry/etc. Receives a per-handle
  // `signal` that the store flips on `cancel`, and the
  // `handleId` so the spawnFn can route the child's
  // `cost_update` HarnessEvents back to `recordLiveCost`
  // (spec ORCHESTRATION.md §3.5 budget shared). Failures throw
  // — the store's record promise propagates them so the
  // task_await tool surface can map onto a tool error.
  spawnFn: (
    args: SpawnSubagentArgs,
    signal: AbortSignal,
    handleId: string,
  ) => Promise<SpawnSubagentResult>;
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
  // Optional state-change callback fired whenever the running
  // or queued counts shift: spawn (queue+1), slot acquisition
  // (queue-1, running+1), IIFE settle (running-1), cancel
  // (running-1 OR queue-1 depending on which side the cancel
  // landed). Production wires this to a `safeEmit` of
  // `parallel_status` so the TUI footer's `R+Q/cap` chip
  // updates without polling. Synchronous from the call site's
  // perspective; the callback MUST NOT throw (the store
  // doesn't try/catch around it — same contract as `spawnFn`,
  // where a throw is the harness's bug to surface, not the
  // store's to swallow).
  onStateChange?: () => void;
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
  // Pessimistic worst-case cost estimate captured at spawn
  // time. Used as the FLOOR of `getReservedChildCostUsd` while
  // status is 'running' — covers the window before the child's
  // first `cost_update` event lands. Once `liveCostUsd` exceeds
  // it (rare but possible if a child overspends its declared
  // budget), the reservation grows with `liveCostUsd` instead.
  // Once settled, the actual cost from `settledResult` flows
  // into `getSettledChildCostUsd` and this field stops
  // mattering.
  estimateCostUsd: number;
  // Latest cumulative self-cost the child reported via
  // `cost_update` HarnessEvent (spec ORCHESTRATION.md §3.5).
  // Default 0 (no reports yet); monotonically advances as the
  // child runs. The reservation tracker reads this as the
  // CURRENT real spend, replacing the pessimistic estimate
  // floor as data arrives. `recordLiveCost` is the only writer.
  liveCostUsd: number;
  // True iff `cancel` or `cancelAll` aborted this record. The
  // status field stays 'running' until the IIFE wakes and
  // settles the result, but the reservation contract requires
  // an immediate release. Read by `getReservedChildCostUsd`
  // (filters out cancelled rows so their reservation drops to
  // 0 the moment cancel lands) and by `recordLiveCost` (no-op
  // on cancelled rows so a `cost_update` already in flight on
  // the IPC pipe can't bump the reservation back up after
  // cancel). Single-write: only cancel-paths flip; never
  // un-flips.
  cancelled: boolean;
  // Why the cancel happened, set when `cancelled` flips. Read
  // by the IIFE on settle: when the spawnFn returns an
  // `interrupted` envelope (the runtime's response to the
  // abort signal), we stamp the `cancelSource` field on the
  // envelope so the persisted `settled_payload` tells
  // postmortem queries WHO cancelled, not just THAT it was
  // cancelled. The `reason` string stays as the documented
  // contract value (`cancelled` / `cancelled_before_dispatch`,
  // CONTRACTS.md §2.6.4.1); attribution is orthogonal.
  // `undefined` when the record has never been cancelled.
  cancelReason: CancelReason | undefined;
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
  if (
    raw.kind === 'budget_exhausted' &&
    typeof raw.requested === 'string' &&
    typeof raw.spent === 'number' &&
    typeof raw.estimate === 'number' &&
    typeof raw.projected === 'number' &&
    typeof raw.cap === 'number'
  ) {
    return {
      kind: 'budget_exhausted',
      requested: raw.requested,
      spent: raw.spent,
      estimate: raw.estimate,
      projected: raw.projected,
      cap: raw.cap,
    };
  }
  // Everything else falls into `kind: 'ran'`. Unknown kinds
  // are treated as a corrupt "ran" row with status='error' —
  // task_await maps that to `subagent.run_failed` which is the
  // safest tool-error shape we can show the model.
  const auditFailureRaw = raw.auditFailure;
  const worktreeRaw = raw.worktree;
  const worktreeErrorRaw = raw.worktreeError;
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
    // Worktree outcome (spec §11.2). Re-validated on rehydrate
    // so corrupted/legacy rows don't smuggle a partial shape
    // past the type system. Without this branch a resumed
    // `task_await` would lose the worktree diagnostics that
    // were persisted at settle time — `path`, `branch`,
    // `dirty`/`preserved`/`removed` flags — which is a regression
    // vs. the original (pre-resume) `task_await` for the same
    // handle. All five fields must validate together; a
    // partial shape is treated as missing rather than half-
    // restored.
    ...(typeof worktreeRaw === 'object' &&
    worktreeRaw !== null &&
    !Array.isArray(worktreeRaw) &&
    typeof (worktreeRaw as { path?: unknown }).path === 'string' &&
    typeof (worktreeRaw as { branch?: unknown }).branch === 'string' &&
    typeof (worktreeRaw as { dirty?: unknown }).dirty === 'boolean' &&
    typeof (worktreeRaw as { preserved?: unknown }).preserved === 'boolean' &&
    typeof (worktreeRaw as { removed?: unknown }).removed === 'boolean'
      ? {
          worktree: {
            path: (worktreeRaw as { path: string }).path,
            branch: (worktreeRaw as { branch: string }).branch,
            dirty: (worktreeRaw as { dirty: boolean }).dirty,
            preserved: (worktreeRaw as { preserved: boolean }).preserved,
            removed: (worktreeRaw as { removed: boolean }).removed,
          },
        }
      : {}),
    // Worktree creation error (status='error',
    // reason='worktree_create_failed' in the source envelope).
    // Re-validated like `auditFailure` since the shape is the
    // same. Persisted to keep the diagnostic on resume; without
    // this, the model's view of "the worktree branch never
    // started" turns into a generic error after resume.
    ...(typeof worktreeErrorRaw === 'object' &&
    worktreeErrorRaw !== null &&
    !Array.isArray(worktreeErrorRaw) &&
    typeof (worktreeErrorRaw as { code?: unknown }).code === 'string' &&
    typeof (worktreeErrorRaw as { message?: unknown }).message === 'string'
      ? {
          worktreeError: {
            code: (worktreeErrorRaw as { code: string }).code,
            message: (worktreeErrorRaw as { message: string }).message,
          },
        }
      : {}),
    // Cancel-source attribution (audit fix). Re-validated on
    // rehydrate so a corrupted enum value (older row predating
    // this field, or schema rot) doesn't smuggle an unknown
    // value through the type system. Absent → no attribution
    // (the store wasn't running this code when the row was
    // settled, or the cancel never happened).
    ...(raw.cancelSource === 'model' ||
    raw.cancelSource === 'cap_watchdog' ||
    raw.cancelSource === 'parent_drain'
      ? { cancelSource: raw.cancelSource }
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
  const onStateChange = options.onStateChange;
  const records = new Map<string, SubagentRecord>();
  // Number of records that have been spawned but have not yet
  // passed `acquireSlot`. Increment in spawn(); decrement
  // immediately after `acquireSlot` resolves AND on the
  // cancelled-before-dispatch path (which races to settle
  // before the slot ever acquires). The single source of truth
  // for the queue depth — exposed via `queuedCount()` and
  // emitted as part of `parallel_status` by the harness.
  let queued = 0;
  // Helper: invoke the optional state-change callback, swallowing
  // the case where it isn't wired. Production passes a
  // `safeEmit(parallel_status)`; tests omit it.
  const fireStateChange = (): void => {
    if (onStateChange !== undefined) onStateChange();
  };

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
  // Sum of cost from settled children rehydrated at construction
  // time. Captured one-shot here (rather than maintained in
  // records) so the harness can add it to `priorCostUsd` once
  // and the budget gate sees the resumed run's prior child
  // spend without conflating it with this run's cumulative.
  let rehydratedChildCostUsd = 0;

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
      // Charge the FINAL `cached` envelope (post-race reread when
      // applicable) against the rehydrated tracker. The
      // settled-first branch and the race-loser path both end
      // here with `cached` reflecting whichever envelope won the
      // settle write-once contract. Folding once at this single
      // site closes the bug where a child that settled with
      // costUsd > 0 just before the parent crashed was undercounted
      // — the resumed parent's priorCostUsd would have missed
      // that spend and `maxCostUsd` would silently admit extra
      // work.
      if (cached.kind === 'ran' && Number.isFinite(cached.costUsd)) {
        rehydratedChildCostUsd += cached.costUsd;
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
        // Rehydrated records carry no live reservation (they're
        // already settled). The actual cost flows into
        // `getSettledChildCostUsd` via `cached.costUsd`.
        estimateCostUsd: 0,
        liveCostUsd: 0,
        cancelled: false,
        cancelReason: undefined,
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

  // Cancel landed before the IIFE woke from `acquireSlot`. The
  // spawnFn never ran. The `reason` string stays as the
  // documented contract value (`cancelled_before_dispatch`,
  // CONTRACTS.md §2.6.4.1) so existing parsers don't break;
  // attribution lives in the orthogonal `cancelSource` field
  // (audit fix). When `cancelReason === undefined` (extremely
  // unlikely — the controller is owned by the store) we omit
  // the field rather than invent attribution we don't have.
  const cancelledBeforeDispatch = (
    spawnedAt: number,
    cancelReason: CancelReason | undefined,
  ): SpawnSubagentResult => ({
    kind: 'ran',
    output: '',
    sessionId: '',
    status: 'interrupted',
    reason: 'cancelled_before_dispatch',
    costUsd: 0,
    steps: 0,
    durationMs: now() - spawnedAt,
    ...(cancelReason !== undefined ? { cancelSource: cancelReason } : {}),
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

  const spawn = (args: SpawnSubagentArgs, options: SpawnOptions): SubagentHandle => {
    const id = newId();
    const spawnedAt = now();
    const handle: SubagentHandle = { id, name: args.name, spawnedAt };
    const controller = new AbortController();
    const estimateCostUsd =
      Number.isFinite(options.estimateCostUsd) && options.estimateCostUsd > 0
        ? options.estimateCostUsd
        : 0;

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
      estimateCostUsd,
      liveCostUsd: 0,
      cancelled: false,
      cancelReason: undefined,
    };

    // Track the new handle as queued. Decremented as soon as
    // `acquireSlot` resolves (or as soon as the
    // cancelled-before-dispatch path fires). Spawn always
    // increments — even when the cap has free slots, the IIFE
    // hasn't actually entered yet at the moment `spawn()`
    // returns to the caller.
    queued += 1;
    fireStateChange();
    const promise = (async (): Promise<SpawnSubagentResult> => {
      await acquireSlot();
      // Slot acquired (or cancelled-before-dispatch about to
      // fire). Either way, this record is no longer "queued"
      // — it's about to settle one way or another. Decrement
      // first so the operator's view of `R+Q` reflects the
      // transition before the IIFE runs.
      queued -= 1;
      fireStateChange();
      let result: SpawnSubagentResult;
      try {
        if (controller.signal.aborted) {
          result = cancelledBeforeDispatch(spawnedAt, record.cancelReason);
        } else {
          try {
            result = await spawnFn(args, controller.signal, id);
          } catch (e) {
            result = synthesizeSpawnError(e, spawnedAt);
          }
        }
      } finally {
        releaseSlot();
      }
      // Cancel-source attribution (audit fix). When the IIFE
      // was aborted by `cancel`/`cancelAll`/`drain`, the
      // spawnFn returned an envelope — but the runtime can't
      // know WHO cancelled. We do. Stamp the orthogonal
      // `cancelSource` field so the persisted `settled_payload`
      // distinguishes `model` / `cap_watchdog` /
      // `parent_drain` for postmortem queries, while keeping
      // the legacy `reason` string intact per CONTRACTS.md
      // §2.6.4.1.
      //
      // Status filter: stamp on every non-`done` envelope —
      //   - `interrupted`: child observed the abort cleanly
      //   - `exhausted`: child hit maxSteps before the abort
      //     propagated (plausible in long runs)
      //   - `error`: spawnFn threw (SQLITE_BUSY, IPC failure)
      //     between cancel and the runtime catching the abort
      //
      // `done` is excluded: the child finished naturally even
      // though `record.cancelled` may have flipped in the
      // microtask gap between `result = await spawnFn(...)`
      // and this block. Stamping there would be misleading
      // ("cancelled" but with `status: 'done'`).
      //
      // Skipped when `cancelReason === undefined` (the record
      // was never explicitly cancelled — runtime aborted for
      // some other reason, e.g. wall-clock at the child layer)
      // so we don't invent attribution we don't have.
      if (record.cancelReason !== undefined && result.kind === 'ran' && result.status !== 'done') {
        result = { ...result, cancelSource: record.cancelReason };
      }
      record.status = 'settled';
      record.settledResult = result;
      // Running count just dropped by one. Fire the state-
      // change callback so the harness re-emits
      // parallel_status with the fresh figures.
      fireStateChange();
      // Persist the linkage + final envelope. We bind
      // child_session_id BEFORE settling so a concurrent reader
      // sees the map intact even if the settle write fails for
      // some reason (it shouldn't — the row was just inserted —
      // but ordering is cheap and the contract is "row is
      // either fully settled or recoverable as running"). Empty
      // sessionId (cancelled-before-dispatch and spawn-failed
      // paths) is left null in the column.
      //
      // Both calls go through bun:sqlite, which can throw on
      // SQLITE_BUSY (concurrent checkpointing under WAL), FK
      // violations (parent session row dropped via cascade
      // mid-run), or schema mismatches after a future migration.
      // Without this catch, a transient throw here becomes an
      // unhandled rejection on the record's promise — node/Bun
      // crashes the process. The in-memory `settledResult`
      // is already correct above; the persistence failure is
      // worth a stderr warning so audit consumers know the row
      // may be stale or missing, but it MUST NOT take the
      // harness down.
      if (persistTo !== undefined) {
        try {
          if (result.kind === 'ran' && result.sessionId.length > 0) {
            updateSubagentHandleChildSession(persistTo.db, id, result.sessionId);
          }
          settleSubagentHandle(persistTo.db, id, envelopeToJson(result));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(
            `subagent handle ${id}: persist failed (${message}); audit row may be stale`,
          );
        }
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

  const cancel = (id: string, reason: CancelReason): CancelOutcome => {
    const record = records.get(id);
    if (record === undefined) return { cancelled: false, reason: 'unknown' };
    if (record.status === 'settled') {
      return { cancelled: false, reason: 'already_settled' };
    }
    // First-writer-wins on attribution. If a sibling cancel
    // path (`drain` or `cancelAll`) already flipped the record,
    // their `cancelReason` stands — re-stamping here would
    // break audit causality (drain set `parent_drain`; a late
    // model `task_cancel` would silently overwrite it to
    // `model`). Returning `{ cancelled: true }` keeps the call
    // idempotent from the caller's perspective: the handle is
    // cancelled either way; only the attribution differs.
    if (record.cancelled) return { cancelled: true };
    // Free the cost reservation IMMEDIATELY. Without this, a
    // queued spawn (waiting on `acquireSlot`) would hold its
    // pessimistic reservation until the IIFE wakes after a
    // sibling settled the slot — ms to seconds of false
    // contention against the cap. The hint string in
    // `task_async`'s error envelope ("cancel one to free its
    // reservation") promises this is immediate; making it
    // immediate at the source is what backs that promise.
    //
    // Setting `cancelled: true` (instead of zeroing
    // estimate/live) keeps the audit fields intact while the
    // reservation tracker filters cancelled rows. Also blocks
    // any in-flight `cost_update` on the IPC pipe from
    // re-incrementing `liveCostUsd` between cancel and IIFE
    // settle.
    record.cancelled = true;
    record.cancelReason = reason;
    record.controller.abort();
    return { cancelled: true };
  };

  const list = (): SubagentHandle[] => Array.from(records.values()).map((r) => ({ ...r.handle }));

  const listDetailed = (): SubagentHandleSummary[] => {
    const out: SubagentHandleSummary[] = [];
    for (const r of records.values()) {
      const base: SubagentHandleSummary = {
        id: r.handle.id,
        name: r.handle.name,
        spawnedAt: r.handle.spawnedAt,
        status: r.status,
      };
      // Settled rows: surface the `kind` discriminator AND
      // (for `kind: 'ran'`) the summary block. The other three
      // kinds (unknown_subagent, depth_exceeded,
      // budget_exhausted) don't carry a child outcome — just
      // refusal metadata that doesn't fit the summary shape —
      // so they get the discriminator without a summary block.
      // Defensive on `settledResult === null`: shouldn't happen
      // (status flips with settledResult atomically), but if a
      // future bug introduces the gap we surface 'ran' as the
      // safe fallback rather than guessing.
      if (r.status === 'settled' && r.settledResult !== null) {
        base.kind = r.settledResult.kind;
        if (r.settledResult.kind === 'ran') {
          const env = r.settledResult;
          base.settled = {
            childStatus: env.status,
            reason: env.reason,
            costUsd: env.costUsd,
            steps: env.steps,
            durationMs: env.durationMs,
            childSessionId: env.sessionId.length > 0 ? env.sessionId : null,
            ...(env.cancelSource !== undefined ? { cancelSource: env.cancelSource } : {}),
          };
        }
      }
      out.push(base);
    }
    return out;
  };

  const queuedCount = (): number => queued;

  const inFlightCount = (): number => {
    let n = 0;
    for (const r of records.values()) {
      if (r.status === 'running') n += 1;
    }
    return n;
  };

  const drain = async (reason: CancelReason): Promise<void> => {
    // Cancel every still-running record. The records' own
    // promises will settle (either via the cancelled-before-
    // dispatch synthesis or via spawnFn returning an
    // interrupted result). We await every record's promise via
    // `Promise.allSettled` so a single throwing promise doesn't
    // strand the others.
    //
    // `reason` flows to the per-record `cancelReason` so the
    // settled envelope carries `cancelSource: 'parent_drain'`
    // (typical caller). A record already cancelled by the model
    // (`'model'`) keeps its prior attribution — drain's
    // `cancelled` short-circuit means we don't re-stamp.
    for (const r of records.values()) {
      if (r.status === 'running' && !r.cancelled) {
        r.cancelled = true;
        r.cancelReason = reason;
        r.controller.abort();
      }
    }
    await Promise.allSettled(Array.from(records.values()).map((r) => r.promise));
  };

  const getReservedChildCostUsd = (excludeHandleId?: string): number => {
    let total = 0;
    for (const [id, r] of records.entries()) {
      // Caller-side exclude: the dispatcher's pre-spawn gate
      // skips its own handle here so its estimate isn't
      // counted both in `reserved` and in the gate's
      // `spent + estimate`.
      if (excludeHandleId !== undefined && id === excludeHandleId) continue;
      // Cancelled records contribute 0 — the cancel path
      // releases the reservation IMMEDIATELY (D204). Filtering
      // here (rather than zeroing estimate/live on cancel)
      // keeps the audit fields intact for diagnostics while
      // still freeing the cap.
      if (r.status === 'running' && !r.cancelled) {
        // Pessimistic floor (estimate) until the child reports;
        // once live > estimate, follow the actual spend.
        total += Math.max(r.estimateCostUsd, r.liveCostUsd);
      }
    }
    return total;
  };

  const recordLiveCost = (handleId: string, cumulative: number): void => {
    const record = records.get(handleId);
    if (record === undefined) return;
    if (record.status !== 'running') return;
    // No-op on cancelled records: a `cost_update` event already
    // in flight on the IPC pipe (sent by the child before the
    // abort signal landed) MUST NOT bump the reservation back
    // up after `cancel`/`cancelAll` flipped the flag. Without
    // this guard the watchdog's release would be silently
    // undone by a stale message.
    if (record.cancelled) return;
    if (!Number.isFinite(cumulative) || cumulative < 0) return;
    // Monotonic: a stale or out-of-order event from the child
    // (clock skew, retried stream) MUST NOT regress the
    // reservation. The downstream cap watchdog relies on
    // monotonic accumulation to avoid false-positive cap-cross
    // alarms when an old `cost_update` lands after a newer one.
    if (cumulative > record.liveCostUsd) record.liveCostUsd = cumulative;
  };

  const cancelAll = (reason: CancelReason): void => {
    for (const r of records.values()) {
      if (r.status === 'running' && !r.cancelled) {
        r.cancelled = true;
        r.cancelReason = reason;
        r.controller.abort();
      }
    }
  };

  const getSettledChildCostUsd = (): number => {
    let total = 0;
    for (const r of records.values()) {
      if (
        r.status === 'settled' &&
        r.settledResult !== null &&
        r.settledResult.kind === 'ran' &&
        Number.isFinite(r.settledResult.costUsd)
      ) {
        total += r.settledResult.costUsd;
      }
    }
    return total;
  };

  const getLiveCostUsd = (handleId: string): number => {
    const record = records.get(handleId);
    if (record === undefined) return 0;
    return record.liveCostUsd;
  };

  const getRehydratedChildCostUsd = (): number => rehydratedChildCostUsd;

  return {
    spawn,
    awaitHandle,
    cancel,
    list,
    listDetailed,
    inFlightCount,
    queuedCount,
    drain,
    cancelAll,
    recordLiveCost,
    getReservedChildCostUsd,
    getSettledChildCostUsd,
    getLiveCostUsd,
    getRehydratedChildCostUsd,
  };
};
