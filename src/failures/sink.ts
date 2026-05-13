// FailureEventSink — the write surface for failure_events
// (spec FAILURE_MODES.md §19, AUDIT.md §1).
//
// Mirrors src/permissions/audit.ts's AuditSink shape so the
// patterns operators already know (createSqliteSink, createNoopSink,
// verifyChain) apply to failures too. Differences from AuditSink:
//
//   1. Chain is per-SESSION (AUDIT.md §4.2 explicit:
//      `prev = SHA256(session_id)`), not per-INSTALL. Independent
//      chain per session means corruption in one session doesn't
//      cascade to others.
//
//   2. ID is a ULID (TEXT PK), not autoinc seq. Globally unique by
//      construction; safe across DB copies / install rebuilds.
//
//   3. No `install_id` column — the per-session chain makes forge
//      cross-install a misattribution problem, not a tamper-the-
//      chain vector. Future ALTER if multi-install DB sharing
//      becomes load-bearing.
//
// Pre-session failures (bootstrap-tier, before any session_id
// exists) use the sentinel `BOOTSTRAP_SESSION_ID = 'bootstrap'`
// from codes.ts. The chain rules apply identically — first
// bootstrap event has `prev = SHA256('bootstrap')`; subsequent
// events chain from there. Across restarts the bootstrap chain
// extends incrementally (rare in practice; most installs have
// 0-2 bootstrap events ever).

import { sha256Hex } from '../permissions/canonical.ts';
import { canonicalize } from '../permissions/canonical.ts';
import { generateUlid } from '../permissions/ulid.ts';
import type { DB } from '../storage/db.ts';
import { withImmediateTransaction } from '../storage/db.ts';
import {
  type AppendFailureEventInput,
  type FailureEventRow,
  PERSISTED_COLUMNS,
  appendFailureEvent,
  getLastFailureEventBySession,
  listFailureEventsBySession,
} from '../storage/repos/failure-events.ts';
import {
  BOOTSTRAP_SESSION_ID,
  type FailureClass,
  isFailureCode,
  isRecoveryAction,
} from './codes.ts';
import { scrubFailurePayload } from './scrub.ts';

const TS_FUTURE_SKEW_MS = 60 * 60 * 1000;

export interface EmitFailureEventInput {
  code: string;
  classe: FailureClass;
  recovery_action: string;
  user_visible: boolean;
  // Defaults to BOOTSTRAP_SESSION_ID when omitted. Real session
  // emit sites should always supply their session_id explicitly
  // to keep the bootstrap chain reserved for pre-session events.
  session_id?: string;
  step_id?: string | null;
  payload?: Record<string, unknown> | null;
  // Test seam. Production never sets this — `validateInput`
  // enforces the same future-skew + integer constraints the
  // chain depends on. The `id` test seam from earlier slice 130
  // drafts was REMOVED in fixup #3: the public type must never
  // let a caller dictate the ULID, because the verifyChain
  // tiebreak orders by `(created_at, id)` and a caller-chosen
  // id could reorder the walk against insertion order.
  // Production callers leave this undefined; tests that need
  // deterministic timestamps pin a value.
  created_at?: number;
}

export interface EmittedFailureRow {
  id: string;
  this_chain_hash: string;
}

export type VerifyFailureChainResult =
  | { ok: true; rows: number }
  | {
      ok: false;
      brokenAt: string; // the failing row's id
      reason: 'prev_chain_hash_mismatch' | 'this_chain_hash_mismatch';
      expected: string;
      actual: string;
    };

export interface FailureEventSink {
  emit(input: EmitFailureEventInput): EmittedFailureRow;
  verifyChain(session_id: string): VerifyFailureChainResult;
}

const NOOP_ROW: EmittedFailureRow = { id: '', this_chain_hash: '' };

export const createNoopFailureSink = (): FailureEventSink => ({
  emit: () => NOOP_ROW,
  verifyChain: () => ({ ok: true, rows: 0 }),
});

// Genesis hash for a fresh session's chain. AUDIT.md §4.2:
// `prev_chain_hash_for_session.first_row = SHA256(session_id)`.
// Stable per session_id — replays produce identical genesis.
const computeSessionGenesisHash = (session_id: string): string => sha256Hex(session_id);

// Build the canonical-hash payload from a row's persisted columns
// MINUS `this_chain_hash` (output can't be its own input). The
// canonicalize helper sorts keys lexicographically, so column
// order in the input object is purely aesthetic; both emit and
// verifyChain must build the same shape from the same source.
const HASH_INPUT_COLUMNS = PERSISTED_COLUMNS.filter((c) => c !== 'this_chain_hash');

const buildHashPayload = (
  row: Omit<FailureEventRow, 'this_chain_hash'>,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const col of HASH_INPUT_COLUMNS) {
    payload[col] = (row as unknown as Record<string, unknown>)[col];
  }
  return payload;
};

const validateInput = (input: EmitFailureEventInput, now: number): void => {
  if (!isFailureCode(input.code)) {
    throw new Error(
      `failure_events: code '${input.code}' is not registered in CODE_VOCABULARY (see src/failures/codes.ts; new codes require an explicit entry + emit site)`,
    );
  }
  if (!isRecoveryAction(input.recovery_action)) {
    throw new Error(
      `failure_events: recovery_action '${input.recovery_action}' is not recognized (expected one of: fatal, ignored, degraded, pending_repair, retried_Nx, fallback_to_X)`,
    );
  }
  if (input.created_at !== undefined) {
    const ts = input.created_at;
    if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) {
      throw new Error(
        `failure_events: created_at must be a non-negative finite integer (got ${String(ts)})`,
      );
    }
    if (ts > now + TS_FUTURE_SKEW_MS) {
      throw new Error(
        `failure_events: created_at is more than ${TS_FUTURE_SKEW_MS}ms ahead of wall clock (got ${ts}, now ${now}) — suspected forgery`,
      );
    }
  }
};

export const createSqliteFailureSink = (options: {
  db: DB;
  // Test seam — pin the wall-clock read. Production never sets
  // this. Both `validateInput` (future-skew check) and the
  // bumped-ts ceiling read this; passing one source lets tests
  // craft chain-drift scenarios deterministically without
  // racing the system clock.
  now?: () => number;
}): FailureEventSink => {
  const { db } = options;
  const nowFn = options.now ?? (() => Date.now());

  const emit = (input: EmitFailureEventInput): EmittedFailureRow => {
    const now = nowFn();
    validateInput(input, now);

    const session_id = input.session_id ?? BOOTSTRAP_SESSION_ID;
    const { json: payload_json } = scrubFailurePayload(input.payload);

    // Slice 130 fixup #2: read-last + insert wrapped in a single
    // BEGIN IMMEDIATE transaction, mirroring approvals_log
    // (slice 127 R3 P0-A). Pre-fixup the read and write were
    // both in autocommit, so two parallel emits in the same
    // session could both observe `last = X`, both compute
    // `prev_chain_hash = X.this_chain_hash`, and race for the
    // UNIQUE on `this_chain_hash`. The loser's exception was
    // swallowed by the wire-site catch — silently dropping the
    // audit row reporting another failure (recursive observability
    // gap). IMMEDIATE acquires the writer lock at transaction
    // start; concurrent emits queue on busy_timeout=5000 (set in
    // openDb) and serialize cleanly.
    return withImmediateTransaction(db, (): EmittedFailureRow => {
      const last = getLastFailureEventBySession(db, session_id);
      const prev_chain_hash = last?.this_chain_hash ?? computeSessionGenesisHash(session_id);

      // Strict-monotonic created_at within a session. Same-ms
      // emits otherwise collide and the chain walk's
      // (created_at ASC, id ASC) ordering disagrees with insertion
      // order (ULID random suffix is non-deterministic at same
      // ms). Bumping by +1ms past the previous row preserves
      // insertion order without further serialization.
      //
      // Slice 130 fixup #4: BOUND the bumped value against the
      // same future-skew tolerance the input check uses. If a
      // prior row was timestamped near the skew cap (`now +
      // ~3.59M ms`), naively bumping puts THIS row past the cap
      // and forensic queries get poisoned. Refusing here makes
      // the drift loud — operator sees the chain is corrupt and
      // can audit the offending earlier rows. A future slice can
      // add a chain-break-accepted style recovery path mirroring
      // slice 127's `--accept-broken-chain` for approvals_log.
      const wallClock = input.created_at ?? now;
      const created_at = last !== null ? Math.max(wallClock, last.created_at + 1) : wallClock;
      if (created_at > now + TS_FUTURE_SKEW_MS) {
        throw new Error(
          `failure_events: chain timestamp drift in session '${session_id}' — bumped created_at ${created_at} exceeds now+${TS_FUTURE_SKEW_MS}ms (now=${now}). A previous row carried a future-stamped created_at; subsequent emits refuse until the chain is rotated.`,
        );
      }

      // Slice 130 fixup #3: id is ALWAYS generated server-side.
      // The public `EmitFailureEventInput` no longer exposes an
      // `id` slot — closes the ULID-ordering-forgery vector
      // where a caller could dictate the verifyChain tiebreak.
      const id = generateUlid({ now: () => created_at });

      const rowWithoutThisHash: Omit<FailureEventRow, 'this_chain_hash'> = {
        id,
        session_id,
        step_id: input.step_id ?? null,
        code: input.code,
        classe: input.classe,
        recovery_action: input.recovery_action,
        user_visible: input.user_visible ? 1 : 0,
        payload_json,
        created_at,
        prev_chain_hash,
      };

      const this_chain_hash = sha256Hex(canonicalize(buildHashPayload(rowWithoutThisHash)));

      const full: AppendFailureEventInput = { ...rowWithoutThisHash, this_chain_hash };
      appendFailureEvent(db, full);

      return { id, this_chain_hash };
    });
  };

  const verifyChain = (session_id: string): VerifyFailureChainResult => {
    const rows = listFailureEventsBySession(db, session_id);
    let expectedPrev = computeSessionGenesisHash(session_id);
    for (const row of rows) {
      if (row.prev_chain_hash !== expectedPrev) {
        return {
          ok: false,
          brokenAt: row.id,
          reason: 'prev_chain_hash_mismatch',
          expected: expectedPrev,
          actual: row.prev_chain_hash,
        };
      }
      // buildHashPayload iterates HASH_INPUT_COLUMNS which excludes
      // `this_chain_hash`, so passing the full row is safe — the
      // output column never reaches canonicalize.
      const recomputed = sha256Hex(canonicalize(buildHashPayload(row)));
      if (row.this_chain_hash !== recomputed) {
        return {
          ok: false,
          brokenAt: row.id,
          reason: 'this_chain_hash_mismatch',
          expected: recomputed,
          actual: row.this_chain_hash,
        };
      }
      expectedPrev = row.this_chain_hash;
    }
    return { ok: true, rows: rows.length };
  };

  return { emit, verifyChain };
};
