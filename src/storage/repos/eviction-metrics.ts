// Read-only aggregators over eviction_events (EVICTION §11).
//
// Each metric the spec declares maps to one SQL query against the
// existing eviction_events table. No new producers — this module is
// a forensic surface for `/memory metrics` and the future recap
// `eviction.*` lines. Implements the 7 metrics that the memory
// substrate alone can produce; 3 deferred (cascade.dependents_orphaned
// needs loop frio re-evaluation semantics; roi.bottom_decile_residency
// needs Memory ROI tracking which isn't shipped; decay.misfire needs
// the decay subsystem from §8).
//
// Window-aware: each function accepts a `windowMs` parameter (the
// look-back window) and a `nowMs` reference. Operators / dashboards
// pick windows per consumer:
//
//   - `/memory metrics` (operator-driven): default 30d look-back
//   - recap weekly: 7d look-back
//   - alerts: tight (24h) windows for spike detection
//
// All queries filter to substrate='memory' so this module's outputs
// are memory-only. Other substrates will own their own metrics
// modules when they ship.

import type { DB } from '../db.ts';
import type { EvictionMotivo } from './eviction-events.ts';

// ─── eviction.rate_by_motivo ─────────────────────────────────────────

export interface MotivoCount {
  motivo: EvictionMotivo;
  count: number;
}

// Distribution of motivos for `applied` rows over the window. The
// spec threshold flags `low_roi > 40%` as miscalibrated priors; the
// raw counts are returned and the caller derives the percentage
// (so the same query feeds dashboards that want absolute counts AND
// review tools that want ratios). Ordering: count DESC so the
// dominant motivo is first.
export const rateByMotivo = (db: DB, nowMs: number, windowMs: number): MotivoCount[] => {
  const sinceMs = nowMs - windowMs;
  return db
    .query<MotivoCount, [number]>(
      `SELECT motivo, COUNT(*) AS count
         FROM eviction_events
        WHERE substrate = 'memory'
          AND outcome = 'applied'
          AND recorded_at >= ?
        GROUP BY motivo
        ORDER BY count DESC, motivo ASC`,
    )
    .all(sinceMs);
};

// ─── eviction.restore_rate ───────────────────────────────────────────

export interface RestoreRate {
  // Count of evictions in the window.
  evictedCount: number;
  // Count of restores (evicted → active) in the window. Note that
  // the restore may target an eviction OUTSIDE the window — the
  // metric is over restore events, not over the originating
  // eviction events. Operators reading "restore_rate" intuit
  // "what fraction of recent activity was restoration?" — this
  // matches that mental model.
  restoredCount: number;
  // Ratio (restoredCount / evictedCount); 0 when no evictions.
  ratio: number;
}

// % of evictions that came back via restore within the window. Spec
// threshold: > 20% ⇒ gate de eviction muito agressivo. Numerator is
// the count of `evicted → active` applied transitions; denominator
// is the count of `*→evicted` applied transitions, both within
// `windowMs`.
export const restoreRate = (db: DB, nowMs: number, windowMs: number): RestoreRate => {
  const sinceMs = nowMs - windowMs;
  const evicted = db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n
         FROM eviction_events
        WHERE substrate = 'memory'
          AND outcome = 'applied'
          AND to_state = 'evicted'
          AND recorded_at >= ?`,
    )
    .get(sinceMs);
  const restored = db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n
         FROM eviction_events
        WHERE substrate = 'memory'
          AND outcome = 'applied'
          AND from_state = 'evicted'
          AND to_state = 'active'
          AND recorded_at >= ?`,
    )
    .get(sinceMs);
  const evictedCount = evicted?.n ?? 0;
  const restoredCount = restored?.n ?? 0;
  return {
    evictedCount,
    restoredCount,
    ratio: evictedCount > 0 ? restoredCount / evictedCount : 0,
  };
};

// ─── eviction.purge_irreversible_count ───────────────────────────────

// Count of `*→purged` rows that did NOT go through `evicted` first.
// Spec §4.1's "* → purged (skip evicted)" path with motivo
// `user_purge` or `security`. Spec threshold: > 0 without
// security/user_purge ⇒ bypass detectado (a programming bug; the
// retention window was skipped without the documented motivo).
//
// Returns the count + a breakdown by motivo so consumers can flag
// "anything outside {user_purge, security}" as the bypass class.
export interface PurgeIrreversible {
  totalCount: number;
  breakdown: { motivo: EvictionMotivo; count: number }[];
}

export const purgeIrreversibleCount = (
  db: DB,
  nowMs: number,
  windowMs: number,
): PurgeIrreversible => {
  const sinceMs = nowMs - windowMs;
  const rows = db
    .query<{ motivo: EvictionMotivo; n: number }, [number]>(
      `SELECT motivo, COUNT(*) AS n
         FROM eviction_events
        WHERE substrate = 'memory'
          AND outcome = 'applied'
          AND to_state = 'purged'
          AND from_state != 'evicted'
          AND recorded_at >= ?
        GROUP BY motivo
        ORDER BY n DESC`,
    )
    .all(sinceMs);
  const totalCount = rows.reduce((sum, r) => sum + r.n, 0);
  return {
    totalCount,
    breakdown: rows.map((r) => ({ motivo: r.motivo, count: r.n })),
  };
};

// ─── quarantine.dwell_time + quarantine.escape_rate ──────────────────

export interface QuarantineStats {
  // Number of quarantined memories that exited (either restored or
  // evicted/invalidated/purged). The window applies to the EXIT
  // event timestamp — quarantined-then-still-in-quarantine memories
  // don't count.
  exitedCount: number;
  // Of the exited, how many came back to active.
  escapedToActiveCount: number;
  // Avg dwell time in quarantine (in ms), computed as
  // exit.recorded_at - enter.recorded_at over the same memory.
  // null when no exited memories in window.
  avgDwellMs: number | null;
  // Escape rate = escapedToActive / exitedCount; 0 when no exits.
  escapeRate: number;
}

// Combined metric — quarantine.dwell_time + quarantine.escape_rate
// share the same join structure. Spec thresholds:
//   - dwell_time > 30d ⇒ loop frio não está re-avaliando
//   - escape_rate < 5% ⇒ quarentena vira purgatório
//
// SQL approach: per-(scope, name) pair, find the most-recent
// `*→quarantined` applied event AND the most-recent `quarantined→*`
// applied event (where the exit is more recent). Avg of the diff.
// Same-chain bypasses (where the eviction event has the same
// (actor, trigger) as the quarantine event) DON'T count — they
// represent a single decision pipeline, not a real dwell period.
export const quarantineStats = (db: DB, nowMs: number, windowMs: number): QuarantineStats => {
  const sinceMs = nowMs - windowMs;
  // Self-join to pair each quarantine enter with its earliest
  // subsequent exit. We pick the EARLIEST exit (not most-recent)
  // because the dwell period ends the moment quarantine ends.
  const rows = db
    .query<{ enter_at: number; exit_at: number; exit_to_state: string }, [number]>(
      `SELECT enter.recorded_at AS enter_at,
              exit.recorded_at  AS exit_at,
              exit.to_state     AS exit_to_state
         FROM eviction_events enter
         JOIN eviction_events exit
           ON  enter.substrate = exit.substrate
           AND enter.object_id = exit.object_id
           AND exit.from_state = 'quarantined'
           AND exit.outcome = 'applied'
           AND exit.recorded_at > enter.recorded_at
           AND NOT (exit.actor = enter.actor AND exit.trigger = enter.trigger)
        WHERE enter.substrate = 'memory'
          AND enter.outcome = 'applied'
          AND enter.to_state = 'quarantined'
          AND exit.recorded_at >= ?
          AND exit.recorded_at = (
            SELECT MIN(e2.recorded_at)
              FROM eviction_events e2
             WHERE e2.substrate = enter.substrate
               AND e2.object_id = enter.object_id
               AND e2.from_state = 'quarantined'
               AND e2.outcome = 'applied'
               AND e2.recorded_at > enter.recorded_at
               AND NOT (e2.actor = enter.actor AND e2.trigger = enter.trigger)
          )`,
    )
    .all(sinceMs);

  const exitedCount = rows.length;
  if (exitedCount === 0) {
    return { exitedCount: 0, escapedToActiveCount: 0, avgDwellMs: null, escapeRate: 0 };
  }
  let totalDwell = 0;
  let escaped = 0;
  for (const r of rows) {
    totalDwell += r.exit_at - r.enter_at;
    if (r.exit_to_state === 'active') escaped++;
  }
  return {
    exitedCount,
    escapedToActiveCount: escaped,
    avgDwellMs: totalDwell / exitedCount,
    escapeRate: escaped / exitedCount,
  };
};

// ─── protection.cooldown_blocks ──────────────────────────────────────

export interface ProtectionBlocks {
  totalCount: number;
  byProtection: { protection: string; count: number }[];
}

// Count of `blocked_by_protection` rows over the window, broken
// down by protection name. Spec threshold: spike ⇒ trigger ruim ou
// cooldown mal calibrado. Useful for operators tuning protection
// thresholds (e.g., 72h cooldown might be too long for a fast-
// iteration repo).
export const protectionBlocks = (db: DB, nowMs: number, windowMs: number): ProtectionBlocks => {
  const sinceMs = nowMs - windowMs;
  const rows = db
    .query<{ blocked_by: string | null; n: number }, [number]>(
      `SELECT blocked_by, COUNT(*) AS n
         FROM eviction_events
        WHERE substrate = 'memory'
          AND outcome = 'blocked_by_protection'
          AND recorded_at >= ?
        GROUP BY blocked_by
        ORDER BY n DESC`,
    )
    .all(sinceMs);
  const totalCount = rows.reduce((sum, r) => sum + r.n, 0);
  return {
    totalCount,
    byProtection: rows.map((r) => ({ protection: r.blocked_by ?? 'unknown', count: r.n })),
  };
};

// ─── hook.eviction_blocks ────────────────────────────────────────────

export interface HookBlocks {
  totalCount: number;
  // Top blocking hooks by frequency. `blocked_by` carries the
  // hook spec ref (`layer:sourcePath#entryIndex`).
  byHook: { blockedBy: string; count: number }[];
}

// Count of `blocked_by_hook` rows over the window, broken down by
// which hook chain entry blocked. Spec threshold: persistente ⇒
// revisar matcher (the operator's hook is firing too often).
export const hookEvictionBlocks = (db: DB, nowMs: number, windowMs: number): HookBlocks => {
  const sinceMs = nowMs - windowMs;
  const rows = db
    .query<{ blocked_by: string | null; n: number }, [number]>(
      `SELECT blocked_by, COUNT(*) AS n
         FROM eviction_events
        WHERE substrate = 'memory'
          AND outcome = 'blocked_by_hook'
          AND recorded_at >= ?
        GROUP BY blocked_by
        ORDER BY n DESC`,
    )
    .all(sinceMs);
  const totalCount = rows.reduce((sum, r) => sum + r.n, 0);
  return {
    totalCount,
    byHook: rows.map((r) => ({ blockedBy: r.blocked_by ?? 'unknown', count: r.n })),
  };
};

// ─── combined snapshot for /memory metrics surface ───────────────────

export interface EvictionMetricsSnapshot {
  // Look-back window in ms (echoes input for self-describing
  // output).
  windowMs: number;
  rateByMotivo: MotivoCount[];
  restoreRate: RestoreRate;
  purgeIrreversible: PurgeIrreversible;
  quarantine: QuarantineStats;
  protectionBlocks: ProtectionBlocks;
  hookBlocks: HookBlocks;
}

// Compute every metric in one pass for the /memory metrics slash.
// Sharing the (db, nowMs, windowMs) tuple keeps callers from
// drifting on definitions of "the window" between metrics — every
// number on the slash output reflects the same lookback.
export const evictionMetricsSnapshot = (
  db: DB,
  nowMs: number,
  windowMs: number,
): EvictionMetricsSnapshot => ({
  windowMs,
  rateByMotivo: rateByMotivo(db, nowMs, windowMs),
  restoreRate: restoreRate(db, nowMs, windowMs),
  purgeIrreversible: purgeIrreversibleCount(db, nowMs, windowMs),
  quarantine: quarantineStats(db, nowMs, windowMs),
  protectionBlocks: protectionBlocks(db, nowMs, windowMs),
  hookBlocks: hookEvictionBlocks(db, nowMs, windowMs),
});
