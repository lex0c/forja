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
const buildL1AliasAction = (actionSignature: string): string | null => {
  const parsed = parseActionSignature(actionSignature);
  if (parsed === null || parsed.level !== 'L1') return null;
  return JSON.stringify({ target: parsed.to });
};

// Build the structured `motivo` for the proposed policy — operator
// reads this via `/agent policy list` to understand why the proposal
// landed.
const buildProposalMotivo = (stats: PosteriorStats): string =>
  `loop_frio:accumulation:ci_low=${stats.ciLow.toFixed(3)},n=${stats.n}`;

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

    // Duplicate guard: don't re-propose when a non-terminal policy
    // already exists at this scope. Operator promotes/invalidates
    // existing entries explicitly.
    const existing = findExistingPolicy(db, t.actionSignature, t.scopeKind, t.scopeId);
    if (existing !== null) {
      rejected.push({
        kind: 'duplicate_proposed',
        actionSignature: t.actionSignature,
        scopeKind: t.scopeKind,
        scopeId: t.scopeId,
        existingPolicyId: existing.id,
      });
      continue;
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
      rejected.push({
        kind: 'no_observations',
        actionSignature: t.actionSignature,
        scopeKind: t.scopeKind,
        scopeId: t.scopeId,
      });
      continue;
    }

    // §5.3 gate has 4 AND conditions. Three of them (ci_low, n,
    // distribution_stable) are computed here. The 4th —
    // "noContradictionWithSuperior" — needs a cross-scope check
    // ("is there an active policy with the SAME action_signature
    // but DIFFERENT action_json at a more-specific scope that
    // would always win the resolver?"). Implementation requires
    // the operator's full scope chain to walk; loop frio runs
    // OFFLINE (no current session/repo/user context per analysis).
    // Deferred to 3.5+ when dispatch consultation lands the chain.
    // Today we pass through (caller-declared no contradiction);
    // promotion can still be reverted via /agent policy invalidate.
    if (!passesPromotionGate({ ciLow: stats.ciLow, n: stats.n, distributionStable })) {
      const reasons: string[] = [];
      if (stats.ciLow <= 0.7) reasons.push(`ci_low=${stats.ciLow.toFixed(3)} <= 0.7`);
      if (stats.n < 10) reasons.push(`n=${stats.n} < 10`);
      if (!distributionStable) reasons.push('scope unstable (§7.3)');
      rejected.push({
        kind: 'gate_refused',
        actionSignature: t.actionSignature,
        scopeKind: t.scopeKind,
        scopeId: t.scopeId,
        stats,
        reason: reasons.join('; '),
      });
      continue;
    }

    const actionJson = buildL1AliasAction(t.actionSignature);
    if (actionJson === null) {
      // levelOf approved the prefix; parseActionSignature refused
      // the field content (alphabet violation). Surface as a
      // distinct discriminator so callers can spot emitter bugs.
      rejected.push({
        kind: 'malformed_signature',
        actionSignature: t.actionSignature,
        scopeKind: t.scopeKind,
        scopeId: t.scopeId,
      });
      continue;
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

    proposed.push({
      kind: 'proposed',
      actionSignature: t.actionSignature,
      scopeKind: t.scopeKind,
      scopeId: t.scopeId,
      policy,
      stats,
    });
  }

  return { proposed, rejected, considered: triggered.length };
};
