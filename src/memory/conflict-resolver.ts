// Deterministic winner/loser resolver for conflict pairs (T13.5).
//
// The verify-conflict subagent decides WHETHER two memories conflict;
// this module decides WHICH ONE survives. The split is load-bearing:
// the subagent's verdict is non-deterministic (LLM-judge), so feeding
// it the additional decision "who wins" would multiply the non-
// determinism into the lifecycle. Instead the subagent stays at
// "they conflict, here's the shared concept", and the resolver
// applies a deterministic tiebreak chain to pick the loser that gets
// quarantined.
//
// ────────────────────────────────────────────────────────────────────
// TIEBREAK CHAIN (first decisive tier wins; later tiers run only on
// ties)
//
// 1. Provenance tier — `user_explicit > inferred > imported`.
//    The operator's deliberate authorship outranks model-proposed
//    memories. `inferred` is a confirmed write but still came from
//    the model's read of conversation; `imported` is the weakest
//    (came from a foreign source via promotion / sync).
//
// 2. Recency — more recent mtime wins. The newer memory typically
//    reflects more up-to-date repo state; the older one is the
//    candidate for quarantine. Resolver consumes `mtimeMs` so the
//    caller decides what "recent" means (filesystem mtime is the
//    natural choice; the dispatcher uses statSync).
//
// 3. Scope specificity — `project_local > user > project_shared`.
//    The MOST specific scope wins: a project_local override usually
//    reflects an intentional per-developer override; user-global
//    memories are deliberate cross-project habits; project_shared
//    is team-wide baseline. Loser at this tier is typically the
//    coarser scope.
//
// 4. Body length — longer wins. A more detailed body is more
//    likely the "canonical" definition; a terse body is more
//    likely a paraphrase.
//
// 5. Lexicographic name tiebreak (ascending) — `a` wins when
//    `a.name < b.name`. Deterministic fallback so the resolver
//    never returns "either side is fine"; downstream audit needs
//    a single decision.
//
// The chain is intentionally NOT operator-tunable in V1. Tunability
// invites policy drift between operators on the same project; a
// single canonical resolver lets the audit trail be reproducible
// across machines. If a future need for operator-controlled
// resolution surfaces (e.g., "always prefer project_shared in this
// repo"), it lands as an explicit policy section, not a runtime
// flag — and gets tested against the existing resolver chain so a
// regression in the default behavior shows up loud.

import type { MemoryScope, MemorySource } from './types.ts';

export interface ConflictCandidate {
  scope: MemoryScope;
  name: string;
  source: MemorySource;
  // Epoch ms of the file's last modification. Caller usually pulls
  // from `statSync(path).mtimeMs`. A missing mtime (programmatic
  // caller without a real file) collapses to `0` and immediately
  // loses the recency tier — explicit choice over silently picking
  // a default.
  mtimeMs: number;
  // Raw body text. Length is used as a tiebreak only when every
  // earlier tier ties; the value isn't compared lexicographically.
  body: string;
}

export interface ConflictResolution {
  winner: ConflictCandidate;
  loser: ConflictCandidate;
  // Which tier decided the call. Carried into the governance
  // proposal's evidence payload so an operator reading the audit
  // can see WHY the resolver picked this loser without re-running
  // the chain mentally.
  tier: 'provenance' | 'recency' | 'scope' | 'body_length' | 'lexicographic';
}

// Lower number = higher rank. Compared numerically so `>` semantics
// stay readable at the call site.
const PROVENANCE_RANK: Record<MemorySource, number> = {
  user_explicit: 0,
  inferred: 1,
  imported: 2,
};

// project_local outranks user outranks project_shared. Same comment
// on the numeric mapping as PROVENANCE_RANK.
const SCOPE_SPECIFICITY_RANK: Record<MemoryScope, number> = {
  project_local: 0,
  user: 1,
  project_shared: 2,
};

export const resolveConflictWinner = (
  a: ConflictCandidate,
  b: ConflictCandidate,
): ConflictResolution => {
  // (1) provenance
  const provA = PROVENANCE_RANK[a.source];
  const provB = PROVENANCE_RANK[b.source];
  if (provA !== provB) {
    return provA < provB
      ? { winner: a, loser: b, tier: 'provenance' }
      : { winner: b, loser: a, tier: 'provenance' };
  }

  // (2) recency — newer wins.
  if (a.mtimeMs !== b.mtimeMs) {
    return a.mtimeMs > b.mtimeMs
      ? { winner: a, loser: b, tier: 'recency' }
      : { winner: b, loser: a, tier: 'recency' };
  }

  // (3) scope specificity
  const scopeA = SCOPE_SPECIFICITY_RANK[a.scope];
  const scopeB = SCOPE_SPECIFICITY_RANK[b.scope];
  if (scopeA !== scopeB) {
    return scopeA < scopeB
      ? { winner: a, loser: b, tier: 'scope' }
      : { winner: b, loser: a, tier: 'scope' };
  }

  // (4) body length — longer wins.
  if (a.body.length !== b.body.length) {
    return a.body.length > b.body.length
      ? { winner: a, loser: b, tier: 'body_length' }
      : { winner: b, loser: a, tier: 'body_length' };
  }

  // (5) lexicographic — `a.name <= b.name` ⇒ a wins. The `<=`
  // (not `<`) collapses identical names into "a wins by argument
  // order" — same-name pairs SHOULDN'T reach the resolver (the
  // pair selector skips same-key pairs upstream), but the resolver
  // doesn't trust that input shape and refuses to return an
  // ambiguous outcome.
  return a.name <= b.name
    ? { winner: a, loser: b, tier: 'lexicographic' }
    : { winner: b, loser: a, tier: 'lexicographic' };
};
