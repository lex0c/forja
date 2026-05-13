// §7.3 sealing scheduler — bridges the decision flow + wall clock
// to the SealStore primitive from slice 54.
//
// Three trigger paths fire a seal:
//   - `tick()`: called by the audit sink after every emit (slice 56);
//     increments a decision counter, fires a seal when the counter
//     crosses `intervalDecisions`.
//   - Wall-clock timer: fires every `intervalSeconds` (when > 0),
//     seals the latest chain row, restarts itself.
//   - `sealNow()`: manual trigger. Used by SessionEnd / SIGTERM
//     final-seal handlers and the `agent permission seal-now` CLI
//     verb in slice 58.
//
// All paths converge on `sealLatestInternal`: query the latest
// `approvals_log` row for this install, build a `SealEntry`, hand
// off to `store.append`. The scheduler tracks `lastSealedSeq` so a
// time-driven seal on an unchanged chain is a no-op (no point
// sealing the same hash twice).
//
// Failure: `store.append` returning ok:false invokes
// `onSealFailed(reason)`. The scheduler does NOT enforce
// degrade/refuse — that wiring is the bootstrap's job (slice 57),
// driven by the policy's `[seal] on_failure` knob.
//
// Test seams: `now`, `setTimer`, `clearTimer` mirror the watcher's
// pattern from slice 52. Production callers leave them undefined.

import type { DB } from '../storage/db.ts';
import { getLastApprovalsLogByInstall } from '../storage/repos/approvals-log.ts';
import type { SealEntry, SealStore } from './sealing.ts';

export type SealNowResult = { ok: true; sealed: SealEntry | null } | { ok: false; reason: string };

export interface SealingScheduler {
  // Notify the scheduler that ONE audit decision was just emitted.
  // Fire-and-forget — failures route through `onSealFailed`.
  tick(): void;
  // Manual seal trigger. Returns a structured result so the CLI
  // verb / SessionEnd handler can render the outcome accurately:
  //   - { ok: true, sealed: entry }  — sealed a new entry
  //   - { ok: true, sealed: null }   — nothing to seal (chain empty
  //                                    or already sealed at this seq)
  //   - { ok: false, reason }        — store.append rejected
  sealNow(): SealNowResult;
  // Cancel the wall-clock timer + mark closed. Subsequent `tick()`
  // is a no-op; `sealNow()` returns ok:false. Idempotent.
  close(): void;
}

export interface CreateSealingSchedulerOptions {
  store: SealStore;
  db: DB;
  installId: string;
  // Default 100. Set to 0 to disable decision-driven sealing — the
  // wall-clock timer becomes the only automatic trigger.
  intervalDecisions?: number;
  // Default 3600 (1 hour). Set to 0 to disable time-driven sealing
  // — `tick()` becomes the only automatic trigger.
  intervalSeconds?: number;
  // Called when `store.append` returns ok:false. The scheduler does
  // NOT translate this into a state-machine transition; the caller
  // (bootstrap, per `[seal] on_failure`) maps it to degrade/refuse.
  onSealFailed?: (reason: string) => void;
  // Test seams. Production callers leave undefined.
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type SealLatestOutcome =
  | { kind: 'sealed'; entry: SealEntry }
  | { kind: 'noop' }
  | { kind: 'failed'; reason: string };

export const createSealingScheduler = (opts: CreateSealingSchedulerOptions): SealingScheduler => {
  const intervalDecisions = opts.intervalDecisions ?? 100;
  const intervalSeconds = opts.intervalSeconds ?? 3600;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let decisionCounter = 0;
  // Slice 128 (R4 P0-Race-1): seed lastSealedSeq from the existing
  // seal store. Pre-slice it initialized to 0 in memory; two
  // parallel `forja` processes on the same install both fire tick
  // at the same chain head and both append the SAME `seq=N hash=H`
  // line to the worm/git/tsa file → duplicate seal entries. Seeded
  // from store.list() max-seq, the second process sees its own
  // last-sealed already matches the chain head → noop.
  //
  // store.list() can throw (corrupted file); on failure we fall
  // back to 0 and accept the duplicate-on-first-tick risk. The
  // alternative (refuse to construct the scheduler) would break
  // the audit pipeline entirely on a single bad seal file —
  // overcorrection.
  let lastSealedSeq = 0;
  try {
    const existing = opts.store.list();
    let maxSeq = 0;
    for (const e of existing) {
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    lastSealedSeq = maxSeq;
  } catch {
    // Defensive fallback. The store will surface the corruption
    // again on the first append; that path already produces a
    // failure event the operator can act on.
  }
  let timerHandle: unknown = null;
  let closed = false;

  const sealLatestInternal = (): SealLatestOutcome => {
    const row = getLastApprovalsLogByInstall(opts.db, opts.installId);
    if (row === null) return { kind: 'noop' };
    if (row.seq === lastSealedSeq) return { kind: 'noop' };
    const entry: SealEntry = { seq: row.seq, ts: now(), hash: row.this_hash };
    const result = opts.store.append(entry);
    if (result.ok) {
      lastSealedSeq = row.seq;
      return { kind: 'sealed', entry };
    }
    return { kind: 'failed', reason: result.reason };
  };

  const scheduleTimer = (): void => {
    if (closed) return;
    if (intervalSeconds <= 0) return;
    timerHandle = setTimer(() => {
      timerHandle = null;
      const outcome = sealLatestInternal();
      if (outcome.kind === 'failed') {
        opts.onSealFailed?.(outcome.reason);
      }
      // Time-driven seals reset the decision counter — the next
      // `intervalDecisions` window starts fresh, so a slow stream
      // of decisions doesn't accidentally fire a back-to-back seal
      // right after the timer.
      decisionCounter = 0;
      scheduleTimer();
    }, intervalSeconds * 1000);
  };

  // No initial seal: empty chain has nothing to seal, and a
  // non-empty chain at scheduler-creation time was either already
  // sealed by a previous session or hasn't reached its first
  // interval yet. Either way, wait for the first trigger.
  scheduleTimer();

  return {
    tick: (): void => {
      if (closed) return;
      decisionCounter++;
      if (intervalDecisions <= 0) return;
      if (decisionCounter < intervalDecisions) return;
      const outcome = sealLatestInternal();
      if (outcome.kind === 'failed') {
        opts.onSealFailed?.(outcome.reason);
      }
      decisionCounter = 0;
    },
    sealNow: (): SealNowResult => {
      if (closed) return { ok: false, reason: 'scheduler closed' };
      const outcome = sealLatestInternal();
      if (outcome.kind === 'sealed') {
        decisionCounter = 0;
        return { ok: true, sealed: outcome.entry };
      }
      if (outcome.kind === 'noop') {
        return { ok: true, sealed: null };
      }
      // outcome.kind === 'failed'
      opts.onSealFailed?.(outcome.reason);
      return { ok: false, reason: outcome.reason };
    },
    close: (): void => {
      closed = true;
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
    },
  };
};
