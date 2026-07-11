// Accumulation trigger (FEEDBACK_ADAPTATION §3.2).
//
// "≥ N outcomes novos pra mesma `action_signature` desde última
// análise (N default 10)" — the loop frio runs when this gate
// passes for some (action_signature, scope) tuple. This module
// implements the read query.
//
// "Última análise" tracking: today we use a simple `sinceMs`
// parameter — caller picks the window. A future slice can persist
// per-signature last-analysis timestamps in a new table so
// reruns don't re-process the same outcomes; for now the runner
// passes a wide enough window that re-promotion is idempotent
// (the resolver picks the most-recent active policy regardless).

import type { DB } from '../storage/db.ts';
import type { ScopeKind } from '../storage/repos/outcomes.ts';

export interface TriggeredSignature {
  actionSignature: string;
  scopeKind: ScopeKind;
  scopeId: string;
  // Count of outcomes for the (signature, scope) tuple since `sinceMs`.
  count: number;
}

// Default sample size per §3.2 — operators can override per-call.
export const DEFAULT_ACCUMULATION_N = 10;

// Find (action_signature, scope) tuples with at least `minN` outcomes
// recorded since `sinceMs`. Returns rows ordered by count descending
// so a downstream limit hits the hottest signatures first.
export const findAccumulatedSignatures = (
  db: DB,
  opts: {
    sinceMs?: number;
    minN?: number;
    scopeKind?: ScopeKind;
    scopeId?: string;
  } = {},
): TriggeredSignature[] => {
  const sinceMs = opts.sinceMs ?? 0;
  const minN = opts.minN ?? DEFAULT_ACCUMULATION_N;

  // Optional scope filter — useful when the runner targets a single
  // scope (e.g., session-end loop frio for the just-finished session).
  if (opts.scopeKind !== undefined && opts.scopeId !== undefined) {
    const rows = db
      .query<TriggeredSignature, [number, ScopeKind, string, number]>(
        `SELECT action_signature AS actionSignature,
                scope_kind       AS scopeKind,
                scope_id         AS scopeId,
                COUNT(*)         AS count
           FROM outcomes
          WHERE recorded_at > ?
            AND scope_kind = ? AND scope_id = ?
          GROUP BY action_signature, scope_kind, scope_id
         HAVING count >= ?
          ORDER BY count DESC, actionSignature ASC`,
      )
      .all(sinceMs, opts.scopeKind, opts.scopeId, minN);
    return rows;
  }

  const rows = db
    .query<TriggeredSignature, [number, number]>(
      `SELECT action_signature AS actionSignature,
              scope_kind       AS scopeKind,
              scope_id         AS scopeId,
              COUNT(*)         AS count
         FROM outcomes
        WHERE recorded_at > ?
        GROUP BY action_signature, scope_kind, scope_id
       HAVING count >= ?
        ORDER BY count DESC, actionSignature ASC`,
    )
    .all(sinceMs, minN);
  return rows;
};
