// Outcome aggregator per PERMISSION_ENGINE.md §6.3.2's calibration
// plan. Reads the signals attached to an approval seq and produces
// the binary outcome label + the composite numeric score the
// calibration script feeds into logistic regression.
//
// Composite policy: max-wins. The most damning signal anchors
// the composite — `checkpoint_reverted` (weight 0.9) dominates
// a co-occurring `tool_error` (weight 0.3) because the operator's
// explicit `--undo` carries the strongest "harmful" evidence
// the system can observe. Summing would dilute the strong signal
// across many weak ones; the spec's binary label (`harmful | harmless`)
// fits the threshold model better than a continuous sum.
//
// Threshold: `composite >= COMPOSITE_HARMFUL_THRESHOLD` (default
// 0.5) maps to `harmful`. Calibration will tune this alongside
// per-kind weights — the threshold itself is one of the
// parameters logistic regression derives.

import type { DB } from '../storage/db.ts';
import {
  listOutcomeSignalsByApproval,
  type OutcomeSignalRow,
} from '../storage/repos/outcome-signals.ts';
import { COMPOSITE_HARMFUL_THRESHOLD } from './codes.ts';

export type OutcomeLabel = 'harmful' | 'harmless';

export interface OutcomeAggregate {
  outcome: OutcomeLabel;
  // [0, 1]. 0 when no signals observed.
  composite: number;
  // Every signal that contributed. Useful for forensics and
  // calibration sweeps that want per-kind subscores instead of
  // just the composite.
  signals: OutcomeSignalRow[];
}

export const computeOutcomeForApproval = (db: DB, approval_seq: number): OutcomeAggregate => {
  const signals = listOutcomeSignalsByApproval(db, approval_seq);
  if (signals.length === 0) {
    // No signals = no evidence of harm. Calibration script
    // reading this label treats absence as `harmless` per the
    // null-hypothesis convention.
    return { outcome: 'harmless', composite: 0, signals: [] };
  }
  const composite = signals.reduce((m, s) => Math.max(m, s.signal_weight), 0);
  const outcome: OutcomeLabel = composite >= COMPOSITE_HARMFUL_THRESHOLD ? 'harmful' : 'harmless';
  return { outcome, composite, signals };
};

// Bulk variant for calibration scripts that materialize triples
// over a time window. Returns one aggregate per approval_seq
// supplied — preserves input order so the caller can join 1:1
// against its own (seq, score, decision) extract.
export const computeOutcomesBatch = (
  db: DB,
  approval_seqs: readonly number[],
): OutcomeAggregate[] => approval_seqs.map((seq) => computeOutcomeForApproval(db, seq));
