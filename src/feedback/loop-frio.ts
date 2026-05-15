// Loop frio orchestrator (FEEDBACK_ADAPTATION §3.2).
//
// Runs the per-trigger adaptation pipeline:
//
//   1. Find triggered (action_signature, scope) tuples — those with
//      ≥ N new outcomes since `sinceMs`.
//   2. For each tuple at level L1 (alias) — other levels deferred:
//      load outcomes, fit Beta posterior against the prior.
//   3. Apply the promotion gate (§5.3): ci_low > 0.7 AND n >= 10
//      AND distribution_stable.
//   4. Skip when an active policy already exists at this scope with
//      the same action_signature (avoid duplicate proposals — operator
//      decides when to invalidate the active one).
//   5. Propose the policy (state='proposed'); operator promotes via
//      `/agent policy promote`.
//
// What this slice ships:
//   - L1 alias proposer only. L2 flag would need per-tool flag
//     detection that doesn't ship today; L3 recipe / L4 strategy
//     need their own evidence pipelines.
//   - Distribution stable assumed true. Spec §7.3 detector is a
//     future slice; until then, the gate doesn't shadow-mode
//     policies based on shift.
//   - No persistence of "última análise" timestamp. Caller passes
//     `sinceMs`; same-signature reruns produce idempotent results
//     (existing `proposed` policy short-circuits re-proposal).
//
// Out of scope for this slice (declared in spec, deferred):
//   - L2/L3/L4 proposers.
//   - Distribution shift detector.
//   - Cross-scope promotion (e.g., 9/10 in repo X → user-scope
//     promotion). Per §6.2: explicitly NOT auto.

import type { DB } from '../storage/db.ts';
import { levelOf, parseActionSignature } from '../storage/repos/action-signature.ts';
import {
  type OutcomeResult,
  type ScopeKind,
  listOutcomesByActionSignature,
} from '../storage/repos/outcomes.ts';
import {
  type Policy,
  type PolicyState,
  createPolicy,
  listPoliciesByActionSignature,
} from '../storage/repos/policies.ts';
import { findAccumulatedSignatures } from './accumulation.ts';
import { type PosteriorStats, passesPromotionGate, posteriorFromOutcomes } from './bayesian.ts';
import { getPriorForSignature } from './priors.ts';

export interface LoopFrioInput {
  db: DB;
  // Window for the accumulation trigger. Defaults to 0 (all-time).
  sinceMs?: number;
  // Sample threshold per (signature, scope). Default 10 per §3.2.
  minN?: number;
  // Distribution stability flag from §7.3 detector. Until the detector
  // ships, callers pass `true`. When false, the gate refuses all
  // proposals — spec §7.3 says "sessão em scope unstable não promove
  // policies novas".
  distributionStable?: boolean;
  // Optional scope filter — when set, only process this scope's
  // accumulated signatures. Useful for session-end runs.
  scopeKind?: ScopeKind;
  scopeId?: string;
  // Wall-clock source for the recorded_at field. Defaults to Date.now.
  now?: () => number;
}

// Per-signature result of running the loop frio. The runner returns
// an array of these so callers can audit / surface the outcome of
// each evaluation (proposed, skipped-by-gate, skipped-by-duplicate,
// etc.).
export type SignatureResult =
  | {
      kind: 'proposed';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
      policy: Policy;
      stats: PosteriorStats;
    }
  | {
      kind: 'gate_refused';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
      stats: PosteriorStats;
      reason: string;
    }
  | {
      kind: 'duplicate_proposed';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
      existingPolicyId: string;
    }
  | {
      kind: 'level_not_implemented';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
      level: string;
    }
  | {
      // Signature parses to a known prefix (e.g., 'alias:') but
      // the field content doesn't satisfy the validator — uppercase,
      // embedded spaces, etc. Distinct from level_not_implemented
      // because the level IS supported; the signature shape is
      // broken at the source emitter.
      kind: 'malformed_signature';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
    }
  | {
      // L1 alias where from === to (e.g., alias:sed:sed). The
      // resulting policy would be a no-op rewrite. The bash-aliases
      // table carries self-aliases for telemetry purposes (per-bin
      // tally without an adaptation pair); operator-visible
      // proposals would just clutter `/agent policy list`. Filter
      // at the proposer.
      kind: 'self_alias_no_op';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
    }
  | {
      kind: 'no_observations';
      actionSignature: string;
      scopeKind: ScopeKind;
      scopeId: string;
    };

export interface LoopFrioResult {
  // Signatures that passed the gate and produced a proposed policy.
  proposed: Extract<SignatureResult, { kind: 'proposed' }>[];
  // Signatures evaluated but rejected (gate refused, duplicate, etc.).
  rejected: Exclude<SignatureResult, { kind: 'proposed' }>[];
  // Total signatures considered.
  considered: number;
}

// Check whether an active or proposed policy ALREADY exists for the
// (action_signature, scope) tuple. If yes, we don't re-propose —
// operator action is required to invalidate the existing one before
// loop frio can offer a fresh proposal.
const findExistingPolicy = (
  db: DB,
  actionSignature: string,
  scopeKind: ScopeKind,
  scopeId: string,
): Policy | null => {
  const all = listPoliciesByActionSignature(db, actionSignature, scopeKind, scopeId);
  // Return the most-recent non-terminal policy — terminal
  // `invalidated` rows don't block new proposals (spec §4.2:
  // re-promotion starts from `proposed` novo, com nova evidence).
  const blocking: PolicyState[] = ['proposed', 'active', 'shadow', 'quarantined'];
  for (const p of all) {
    if (blocking.includes(p.state)) return p;
  }
  return null;
};

// Parse the alias L1 action signature into the target binary. The
// signature shape is `alias:<from>:<to>`; the proposer's action JSON
// is `{target: to}` — operator-readable, dispatcher-consumable.
//
// Goes through `parseActionSignature` (the alphabet-validating
// parser) rather than a manual split so a malformed signature that
// somehow landed in outcomes (uppercase, embedded spaces, etc.)
// falls through to the level_not_implemented / malformed branch
// instead of stamping a broken `target` into a policy row.
//
// Returns a discriminated result so the caller can distinguish
// "malformed signature" from "self-alias (no-op proposal)" cleanly.
type BuildAliasResult =
  | { kind: 'ok'; actionJson: string }
  | { kind: 'malformed' }
  | { kind: 'self_alias' };

const buildL1AliasAction = (actionSignature: string): BuildAliasResult => {
  const parsed = parseActionSignature(actionSignature);
  if (parsed === null || parsed.level !== 'L1') return { kind: 'malformed' };
  if (parsed.from === parsed.to) return { kind: 'self_alias' };
  return { kind: 'ok', actionJson: JSON.stringify({ target: parsed.to }) };
};

// Build the structured `motivo` for the proposed policy — operator
// reads this via `/agent policy list` to understand why the proposal
// landed.
const buildProposalMotivo = (stats: PosteriorStats): string =>
  `loop_frio:accumulation:ci_low=${stats.ciLow.toFixed(3)},n=${stats.n}`;

// Scope precedence per spec §6.1 — most-specific first. The resolver
// walks this order at dispatch time; the contradiction check below
// uses it to determine which scopes are "more specific" than the
// proposal's scope.
const SCOPE_PRECEDENCE: ScopeKind[] = ['session', 'repo', 'user', 'language', 'global'];

interface SuperiorContradiction {
  superiorScope: ScopeKind;
  superiorPolicyId: string;
}

// §5.3 gate condition 4: "Não contradiz policy ativa em tier
// superior." Tier superior = more-specific scope per the resolver
// precedence. The check: for a proposal at (scope_kind, signature,
// action_json), is there an active policy at any MORE-SPECIFIC
// scope_kind with the SAME signature but a DIFFERENT action_json?
//
// If yes, the proposal can never apply at dispatch (the higher
// scope always wins resolution) AND the operator would see two
// policies disagreeing in `/agent policy list`. Refuse via gate.
//
// Important: SAME action_json at higher tier does NOT trip this
// check — the proposal is redundant (subsumed), not contradicting.
// Operator might want a backup policy at broader scope; the
// resolver harmlessly never reaches it.
//
// Cheap: one indexed query (idx_policies_action_scope_state). No
// scope_id filter — we don't have the operator's chain at loop
// frio time; ANY session-scope row with a different action_json
// for this signature counts as superior contradiction (even if
// it's another operator's session).
const findSuperiorContradiction = (
  db: DB,
  signature: string,
  proposedScope: ScopeKind,
  proposedActionJson: string,
): SuperiorContradiction | null => {
  const proposedIndex = SCOPE_PRECEDENCE.indexOf(proposedScope);
  // session-scope proposals have no more-specific tier; return null.
  if (proposedIndex <= 0) return null;
  const moreSpecific = SCOPE_PRECEDENCE.slice(0, proposedIndex);
  const placeholders = moreSpecific.map(() => '?').join(', ');
  const row = db
    .query(
      `SELECT id, scope_kind
         FROM policies
        WHERE action_signature = ?
          AND state = 'active'
          AND scope_kind IN (${placeholders})
          AND action_json != ?
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(signature, ...moreSpecific, proposedActionJson) as {
    id: string;
    scope_kind: ScopeKind;
  } | null;
  if (row === null) return null;
  return { superiorScope: row.scope_kind, superiorPolicyId: row.id };
};

export const runLoopFrio = (input: LoopFrioInput): LoopFrioResult => {
  const { db } = input;
  const distributionStable = input.distributionStable ?? true;
  const nowMs = input.now?.() ?? Date.now();

  const triggered = findAccumulatedSignatures(db, {
    ...(input.sinceMs !== undefined ? { sinceMs: input.sinceMs } : {}),
    ...(input.minN !== undefined ? { minN: input.minN } : {}),
    ...(input.scopeKind !== undefined ? { scopeKind: input.scopeKind } : {}),
    ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
  });

  const proposed: Extract<SignatureResult, { kind: 'proposed' }>[] = [];
  const rejected: Exclude<SignatureResult, { kind: 'proposed' }>[] = [];

  for (const t of triggered) {
    const level = levelOf(t.actionSignature);
    if (level !== 'L1') {
      // L2/L3/L4 proposers are future slices; surface skip.
      rejected.push({
        kind: 'level_not_implemented',
        actionSignature: t.actionSignature,
        scopeKind: t.scopeKind,
        scopeId: t.scopeId,
        level: level ?? 'unknown',
      });
      continue;
    }

    // Transactional bracket per-tuple (3.6e). The duplicate guard
    // + insert sequence is atomic — two concurrent runLoopFrio
    // invocations can't both see "no existing policy" and both
    // insert. BEGIN IMMEDIATE acquires SQLite's RESERVED lock so
    // a second writer blocks until the first commits; when it
    // proceeds, the duplicate guard SEES the just-inserted row
    // and skips. Reads outside the transaction (outcome listing,
    // contradiction check) are still racy but their staleness
    // doesn't produce wrong DB state — only wrong tally.
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = processTriggeredTuple(db, t, distributionStable, nowMs);
      if (result.kind === 'proposed') {
        proposed.push(result);
      } else {
        rejected.push(result);
      }
      db.exec('COMMIT');
      committed = true;
    } finally {
      if (!committed) db.exec('ROLLBACK');
    }
  }

  return { proposed, rejected, considered: triggered.length };
};

// Per-tuple logic extracted from the runLoopFrio loop so the
// transactional bracket can wrap it cleanly. Returns the result
// the runner should push to either proposed or rejected.
const processTriggeredTuple = (
  db: DB,
  t: { actionSignature: string; scopeKind: ScopeKind; scopeId: string },
  distributionStable: boolean,
  nowMs: number,
): SignatureResult => {
  // Duplicate guard: don't re-propose when a non-terminal policy
  // already exists at this scope. Operator promotes/invalidates
  // existing entries explicitly. Inside the transaction so a
  // concurrent writer's just-committed row is visible here.
  const existing = findExistingPolicy(db, t.actionSignature, t.scopeKind, t.scopeId);
  if (existing !== null) {
    return {
      kind: 'duplicate_proposed',
      actionSignature: t.actionSignature,
      scopeKind: t.scopeKind,
      scopeId: t.scopeId,
      existingPolicyId: existing.id,
    };
  }

  // Load every outcome for this (signature, scope) — the
  // aggregator wants the full history, not just the window. The
  // accumulation trigger uses the window to DECIDE WHEN to run;
  // the posterior uses ALL evidence the substrate has.
  const outcomes = listOutcomesByActionSignature(db, t.actionSignature, t.scopeKind, t.scopeId);
  const results: OutcomeResult[] = outcomes.map((o) => o.result);
  const prior = getPriorForSignature(t.actionSignature);
  const stats = posteriorFromOutcomes(prior, results);
  if (stats === null) {
    return {
      kind: 'no_observations',
      actionSignature: t.actionSignature,
      scopeKind: t.scopeKind,
      scopeId: t.scopeId,
    };
  }

  // Build the action_json early so the contradiction check has
  // it. Per §5.3 the contradiction is between (signature,
  // action_json) pairs across scopes.
  const aliasResult = buildL1AliasAction(t.actionSignature);
  if (aliasResult.kind === 'malformed') {
    return {
      kind: 'malformed_signature',
      actionSignature: t.actionSignature,
      scopeKind: t.scopeKind,
      scopeId: t.scopeId,
    };
  }
  if (aliasResult.kind === 'self_alias') {
    return {
      kind: 'self_alias_no_op',
      actionSignature: t.actionSignature,
      scopeKind: t.scopeKind,
      scopeId: t.scopeId,
    };
  }
  const actionJson = aliasResult.actionJson;

  // §5.3 gate: 4 AND conditions (ci_low > 0.7, n >= 10,
  // distribution_stable, noContradictionWithSuperior).
  const contradiction = findSuperiorContradiction(db, t.actionSignature, t.scopeKind, actionJson);
  const noContradiction = contradiction === null;
  if (
    !passesPromotionGate({
      ciLow: stats.ciLow,
      n: stats.n,
      distributionStable,
      noContradictionWithSuperior: noContradiction,
    })
  ) {
    const reasons: string[] = [];
    if (stats.ciLow <= 0.7) reasons.push(`ci_low=${stats.ciLow.toFixed(3)} <= 0.7`);
    if (stats.n < 10) reasons.push(`n=${stats.n} < 10`);
    if (!distributionStable) reasons.push('scope unstable (§7.3)');
    if (contradiction !== null) {
      reasons.push(
        `contradicts active superior policy ${contradiction.superiorPolicyId} at scope ${contradiction.superiorScope}`,
      );
    }
    return {
      kind: 'gate_refused',
      actionSignature: t.actionSignature,
      scopeKind: t.scopeKind,
      scopeId: t.scopeId,
      stats,
      reason: reasons.join('; '),
    };
  }

  const policy = createPolicy(db, {
    scopeKind: t.scopeKind,
    scopeId: t.scopeId,
    actionSignature: t.actionSignature,
    actionJson,
    state: 'proposed',
    ciLow: stats.ciLow,
    ciHigh: stats.ciHigh,
    n: stats.n,
    motivo: buildProposalMotivo(stats),
    recordedAt: nowMs,
  });

  return {
    kind: 'proposed',
    actionSignature: t.actionSignature,
    scopeKind: t.scopeKind,
    scopeId: t.scopeId,
    policy,
    stats,
  };
};
