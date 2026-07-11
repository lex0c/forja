// OutcomeSink — write surface for outcome_signals (slice 131).
// Mirrors src/failures/sink.ts's shape so the patterns operators
// already know (createSqliteSink, createNoopSink) extend here.
//
// Distinct from FailureEventSink in two ways:
//
//   1. No hash chain. Outcome signals derive from already-chained
//      sources (approvals_log + failure_events); re-hashing here
//      would duplicate integrity without adding evidence. FK
//      CASCADE on approvals_log.seq keeps the link tight.
//
//   2. Per-kind default weights + TTL. The DEFAULT_SIGNAL_WEIGHTS
//      and DEFAULT_SIGNAL_TTL_DAYS maps from codes.ts apply when
//      the caller doesn't override. Callers can override per-row
//      for calibration sweeps (`signal_weight: 0.7`) or extended
//      retention (`ttl_days: 1095`).

import { generateUlid } from '../permissions/ulid.ts';
import type { DB } from '../storage/db.ts';
import { withImmediateTransaction } from '../storage/db.ts';
import { getApprovalsLogBySeq } from '../storage/repos/approvals-log.ts';
import {
  type AppendOutcomeSignalInput,
  appendOutcomeSignal,
  type OutcomeSignalRow,
} from '../storage/repos/outcome-signals.ts';
import {
  DEFAULT_SIGNAL_TTL_DAYS,
  DEFAULT_SIGNAL_WEIGHTS,
  isOutcomeSignalKind,
  type OutcomeSignalKind,
} from './codes.ts';
import { scrubOutcomePayload } from './scrub.ts';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface EmitOutcomeSignalInput {
  approval_seq: number;
  signal_kind: OutcomeSignalKind;
  // Override the per-kind default weight. [0, 1]. Calibration
  // sweeps use this to reweight after regression; normal emit
  // sites leave undefined.
  signal_weight?: number;
  // When the signal was observed (ms). Defaults to nowFn() at
  // emit time. Test seam.
  observed_at?: number;
  // Signal-specific context. Scrubbed via the same regex set as
  // failure_events payloads.
  payload?: Record<string, unknown> | null;
  // Override TTL in days. Defaults to per-kind table.
  ttl_days?: number;
}

export interface EmittedOutcomeRow {
  id: string;
  approval_seq: number;
}

export interface OutcomeSink {
  emit(input: EmitOutcomeSignalInput): EmittedOutcomeRow;
}

const NOOP_ROW: EmittedOutcomeRow = { id: '', approval_seq: 0 };

export const createNoopOutcomeSink = (): OutcomeSink => ({
  emit: () => NOOP_ROW,
});

const validateInput = (input: EmitOutcomeSignalInput): void => {
  if (!isOutcomeSignalKind(input.signal_kind)) {
    throw new Error(
      `outcome_signals: signal_kind '${String(input.signal_kind)}' is not registered (expected one of: tool_error, failure_event, checkpoint_reverted, session_aborted)`,
    );
  }
  if (!Number.isInteger(input.approval_seq) || input.approval_seq <= 0) {
    throw new Error(
      `outcome_signals: approval_seq must be a positive integer (got ${String(input.approval_seq)})`,
    );
  }
  if (input.signal_weight !== undefined) {
    const w = input.signal_weight;
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`outcome_signals: signal_weight must be in [0, 1] (got ${String(w)})`);
    }
  }
  if (input.ttl_days !== undefined) {
    const d = input.ttl_days;
    if (!Number.isInteger(d) || d <= 0) {
      throw new Error(`outcome_signals: ttl_days must be a positive integer (got ${String(d)})`);
    }
  }
};

export const createSqliteOutcomeSink = (options: {
  db: DB;
  // Test seam — pin the wall-clock read. Production never sets.
  now?: () => number;
}): OutcomeSink => {
  const { db } = options;
  const nowFn = options.now ?? (() => Date.now());

  const emit = (input: EmitOutcomeSignalInput): EmittedOutcomeRow => {
    validateInput(input);
    const now = nowFn();

    // Use a single transaction so the FK probe + insert atomically
    // observe approvals_log. Without IMMEDIATE, a concurrent
    // approvals_log writer could squeeze between our SELECT and
    // INSERT, but the FK is enforced at INSERT time anyway —
    // IMMEDIATE protects only the FK-existence read. The cost
    // is one writer-lock hop per emit; outcome signals are
    // typically once-per-event, not hot-path.
    return withImmediateTransaction(db, (): EmittedOutcomeRow => {
      // Slice 131 fixup #1: approval-existence check + read of
      // `install_id` from the approvals_log row in a single
      // lookup. install_id is denormalized into outcome_signals
      // so signals survive slice 35's chain rotation
      // (`DELETE FROM approvals_log WHERE install_id = ?`); the
      // FK CASCADE that the prior migration declared would have
      // wiped the calibration data at rotation time. The
      // existence check stays — `approval_seq` must point at a
      // real row at INSERT time even if the FK is no longer
      // enforced at the DB layer.
      const approvalRow = getApprovalsLogBySeq(db, input.approval_seq);
      if (approvalRow === null) {
        throw new Error(
          `outcome_signals: approval_seq ${input.approval_seq} does not exist in approvals_log`,
        );
      }

      const observed_at = input.observed_at ?? now;
      const signal_weight = input.signal_weight ?? DEFAULT_SIGNAL_WEIGHTS[input.signal_kind];
      const ttl_days = input.ttl_days ?? DEFAULT_SIGNAL_TTL_DAYS[input.signal_kind];
      const ttl_expires_at = now + ttl_days * MS_PER_DAY;
      const { json: payload_json } = scrubOutcomePayload(input.payload);
      const id = generateUlid({ now: () => now });

      const row: AppendOutcomeSignalInput = {
        id,
        approval_seq: input.approval_seq,
        install_id: approvalRow.install_id,
        signal_kind: input.signal_kind,
        signal_weight,
        payload_json,
        observed_at,
        detected_at: now,
        ttl_expires_at,
      };
      appendOutcomeSignal(db, row);
      return { id, approval_seq: input.approval_seq };
    });
  };

  return { emit };
};

export type { OutcomeSignalRow };
