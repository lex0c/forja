// Adaptation scope resolver (FEEDBACK_ADAPTATION §6).
//
// At decision time (tool dispatch, future slice 3.5), the resolver
// walks the operator's scope chain from most-specific to most-general
// and returns the first ACTIVE policy for the requested
// action_signature. Spec §6.1: "Resolução em decision time: percorre
// de session pra global, primeira match vence."
//
// Order (most-specific → most-general):
//
//   session  → repo  → user  → language  → global
//
// Each level is queried independently; cross-scope JOIN would let a
// repo policy be partially overridden by global, which spec §6.1
// explicitly forbids ("Policy é declarada em um único escopo. Não
// há 'policy global com override per-repo' — duplica e fica em
// escopo independente.").
//
// What this slice (3.3) ships: the resolver. No callers wire it yet
// — slice 3.5 (L1 alias dispatch) is the first consumer.

import type { DB } from '../storage/db.ts';
import type { ScopeKind } from '../storage/repos/outcomes.ts';
import type { Policy, PolicyState } from '../storage/repos/policies.ts';

// Operator's scope chain at decision time. All five levels MUST be
// resolvable upstream (the harness has access to session id, repo
// path / hash, user id, language id, global config). The resolver
// takes them as a single shape to avoid threading 5 separate args
// through every consumer.
export interface ScopeChain {
  // The operator's current session id.
  session: string;
  // Per-working-directory scope. Typically a hash of the repo
  // root path (FNV / SHA-256 short prefix) so policies cache by
  // identity rather than full path. The resolver doesn't compute
  // — caller provides.
  repo: string;
  // Per-user scope. Hostname + login or a stable user id.
  user: string;
  // Per-language scope. Detected from the repo's primary language
  // (workspace adapter / fingerprint detector — slice 3.x).
  language: string;
  // Global scope is implicit ('global' literal as scope_id per
  // spec §6 — shipped defaults). Caller doesn't pass it.
}

// Result discriminant. `found` carries the winning policy and the
// scope where it was matched (so the caller can log/audit the
// match level). `none` means no active policy exists at any
// level for this action_signature — caller falls back to the
// shipped default behavior.
export type ScopeResolution =
  | { kind: 'found'; policy: Policy; matchedScope: ScopeKind }
  | { kind: 'none' };

// Resolve the active policy for `actionSignature` against the
// operator's scope chain. Returns the first match walking
// most-specific → most-general. `desiredStates` defaults to
// ['active']; callers that also want shadow-mode policies
// (logged-but-not-applied per §7.3) pass ['active', 'shadow'].
export const resolveActivePolicy = (
  db: DB,
  actionSignature: string,
  chain: ScopeChain,
  desiredStates: PolicyState[] = ['active'],
): ScopeResolution => {
  const levels: { kind: ScopeKind; id: string }[] = [
    { kind: 'session', id: chain.session },
    { kind: 'repo', id: chain.repo },
    { kind: 'user', id: chain.user },
    { kind: 'language', id: chain.language },
    { kind: 'global', id: 'global' },
  ];

  // Build a WHERE state IN (?, ?, ...) clause sized to the input.
  // Spec §6.1 says "primeira match vence" — order by recorded_at
  // DESC so when multiple rows exist at the same scope level (e.g.,
  // operator manually edited a policy after the loop frio proposed
  // one), the most recent wins.
  const stateList = desiredStates.map(() => '?').join(', ');
  const sql = `SELECT id, parent_id, scope_kind, scope_id, action_signature,
                  action_json, state, ci_low, ci_high, n, motivo, diff_json, recorded_at
             FROM policies
            WHERE action_signature = ? AND scope_kind = ? AND scope_id = ?
              AND state IN (${stateList})
            ORDER BY recorded_at DESC, rowid DESC
            LIMIT 1`;

  for (const level of levels) {
    const row = db.query(sql).get(actionSignature, level.kind, level.id, ...desiredStates) as {
      id: string;
      parent_id: string | null;
      scope_kind: ScopeKind;
      scope_id: string;
      action_signature: string;
      action_json: string;
      state: PolicyState;
      ci_low: number | null;
      ci_high: number | null;
      n: number;
      motivo: string | null;
      diff_json: string | null;
      recorded_at: number;
    } | null;
    if (row !== null) {
      const policy: Policy = {
        id: row.id,
        parentId: row.parent_id,
        scopeKind: row.scope_kind,
        scopeId: row.scope_id,
        actionSignature: row.action_signature,
        actionJson: row.action_json,
        state: row.state,
        ciLow: row.ci_low,
        ciHigh: row.ci_high,
        n: row.n,
        motivo: row.motivo,
        diffJson: row.diff_json,
        recordedAt: row.recorded_at,
      };
      return { kind: 'found', policy, matchedScope: level.kind };
    }
  }
  return { kind: 'none' };
};
