// applyProposal — orchestrator for governance proposal approvals
// (MEMORY.md §11.3, Phase 2 / S8 / T8.3).
//
// The slash command (`/memory governance approve <id>`) and any
// future programmatic approval surface go through this function.
// It is the single place where "operator decided yes" meets the
// memory state machine.
//
// ────────────────────────────────────────────────────────────────────
// CONTRACT
//
// applyProposal NEVER mutates memory without:
//
//   1. Proposal exists AND is pending.
//   2. Confidence is null OR confidence >= threshold.
//   3. Every snapshot in `source_memory_snapshots` still matches the
//      current `hashMemoryContent(serializeMemoryFile(file))` of the
//      memory it references (staleness gate).
//   4. The kind is supported by the apply path (S8 V1: quarantine,
//      restore — single-memory only).
//   5. The (from, to, motivo) tuple admitted by isLegalTransition.
//
// On any pre-flight failure (1-4), the proposal is decided as
// 'rejected' with a `system:*` decidedBy and a structured reason.
// On step-5 failure (transition refused by the state machine), the
// proposal is decided as 'rejected' with `decidedBy='system:state_
// change'` — the underlying memory drifted out of an apply-eligible
// state since the proposal was raised. Distinct from `system:stale_
// evidence` (content drift) per the "drift wins over state_change"
// ordering documented in TODO S8.3.
//
// On success (5 passes for every transition), the proposal is
// decided as 'applied' with the operator-supplied decidedBy.
//
// ────────────────────────────────────────────────────────────────────
// ACTOR + MOTIVO + TRIGGER CONVENTIONS
//
// Operator approval IS the user action that fires the transition,
// so `actor: 'user'` is passed to `transitionMemoryState`. This
// keeps the audit attribution consistent with `/memory quarantine`
// and `/memory restore` slash flows.
//
// Default `motivo` per kind:
//   - quarantine → 'conflict' (catches both verify_failed and
//     conflict_detected detector verdicts; the spec admits
//     'conflict' or 'low_roi' on active→quarantined)
//   - restore    → 'shift' (quarantined/evicted→active admits 'any',
//     and 'shift' carries "situation changed; memory may apply
//     again" semantic)
//
// Default `trigger` derived from `proposed_by`:
//   - 'subagent:verify-semantic'         → 'verify_failed'
//   - 'subagent:verify-conflict'         → 'conflict_detected'
//   - 'detector:user_override_repeated'  → 'user_override_repeated'
//   - anything else                      → 'operator_driven'
//
// Detectors that want to override either field can include them in
// `target_payload.motivo` / `target_payload.trigger`. The apply
// path picks operator overrides first, then derives.
//
// The `OPERATOR_DRIVEN_EVIDENCE_MARKER` is always set on the
// eviction_events evidence payload — the apply path is itself an
// operator-driven transition (the operator approved the proposal).
// The original detector evidence survives in
// `memory_governance_proposals.evidence` for forensic JOINs; the
// eviction_events row carries trace fields (`proposal_id`,
// `proposed_by`) so an operator can trace back without two queries.

import { readFileSync } from 'node:fs';
import type { HookChainResult, HookEventPayload } from '../hooks/types.ts';
import type { DB } from '../storage/db.ts';
import {
  type EvictionMotivo,
  MOTIVOS,
  OPERATOR_DRIVEN_EVIDENCE_MARKER,
  OPERATOR_DRIVEN_TRIGGER,
} from '../storage/repos/eviction-events.ts';
import {
  DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD,
  type DecideProposalInput,
  type MemoryGovernanceProposalRow,
  type MemoryGovernanceProposalStatus,
  decideProposal,
  getProposalById,
} from '../storage/repos/memory-governance.ts';
import { hashMemoryContent } from '../storage/repos/memory-provenance.ts';
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.ts';
import type { MemoryRegistry } from './registry.ts';
import { findLatestTombstone } from './tombstones.ts';
import { transitionMemoryState } from './transitions.ts';
import type { MemoryFile, MemoryScope, MemoryState } from './types.ts';

// Kinds the apply path actually executes. Other kinds in the schema
// (demote, merge, consolidate, expire) are accepted at the
// substrate so future detectors can persist them, but applying
// them needs new file-mutation primitives that aren't part of S8 V1.
const SUPPORTED_KINDS = new Set(['quarantine', 'restore']);

export interface ApplyProposalInput {
  db: DB;
  registry: MemoryRegistry;
  proposalId: string;
  // 'operator:<id>' for slash-driven approvals. Used as the
  // `decided_by` value on the governance proposal row when the
  // transition succeeds.
  decidedBy: string;
  // Optional explanation surfaced in the audit row + reply. Operator
  // surfaces (`/memory governance approve`) leave it undefined;
  // programmatic callers may pass context.
  decidedReason?: string | null;
  // Session + cwd attribution for the resulting eviction_events
  // row. Bootstrap callers thread these from the active session.
  sessionId?: string | null;
  cwd?: string | null;
  // Optional Eviction hook chain (memory.transitions wires this from
  // the harness). Forwarded into transitionMemoryState so the same
  // hook gate enforced by operator-driven /memory quarantine fires
  // on governance-driven transitions too.
  fireHook?: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  // Override the confidence threshold for testing or per-detector
  // tuning. Defaults to DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD (0.7).
  // A confidence of `null` (operator proposals, deterministic
  // detectors) ALWAYS bypasses the gate.
  confidenceThreshold?: number;
  // Test-only clock override. Production uses Date.now().
  now?: () => number;
}

export interface TransitionRecord {
  scope: MemoryScope;
  name: string;
  fromState: MemoryState;
  toState: MemoryState;
  evictionEventId: string;
}

export interface DriftedSnapshot {
  scope: MemoryScope;
  name: string;
  snapshotHash: string;
  // null when the current body couldn't be read (missing, malformed,
  // unknown). The string form preserves the reason for forensics.
  currentHash: string | null;
  reason: string;
}

export type ApplyRejectionReason =
  | 'low_confidence'
  | 'stale_evidence'
  | 'unimplemented_kind'
  | 'multi_memory_unsupported'
  | 'invalid_target_key'
  | 'state_change'
  | 'illegal_transition'
  | 'blocked_by_protection'
  | 'blocked_by_hook'
  | 'invalid_evidence'
  | 'io_error'
  | 'audit_drift';

// Set on `applied` outcomes when the post-transition `decideProposal`
// UPDATE raced with another actor (TTL sweep, concurrent operator
// decision, etc.) and could not stamp our `decidedBy` / `decidedAt`
// onto the row. The memory transition recorded in `transitions` DID
// happen (it landed before this race could fire); the audit chain
// just no longer attributes the row's terminal state to this apply.
// AUDIT DRIFT is also emitted to stderr — operators can reconcile by
// joining `transitions[].evictionEventId` with the proposal row.
export interface GovernanceRowDrift {
  // What the row reads NOW (after the race winner committed).
  currentStatus: MemoryGovernanceProposalStatus;
  decidedBy: string | null;
}

export type ApplyProposalResult =
  | {
      outcome: 'applied';
      transitions: TransitionRecord[];
      governanceDrift?: GovernanceRowDrift;
    }
  | { outcome: 'not_found'; proposalId: string }
  | {
      outcome: 'already_decided';
      currentStatus: MemoryGovernanceProposalStatus;
      decidedBy: string | null;
    }
  | {
      outcome: 'rejected';
      reason: ApplyRejectionReason;
      message: string;
      details?: Record<string, unknown>;
    };

// ─── helpers ──────────────────────────────────────────────────────────

const VALID_MOTIVOS: ReadonlySet<EvictionMotivo> = new Set(MOTIVOS);

// trigger override accepts any kebab-case-ish identifier. The
// underlying column has no CHECK (writer-layer discipline per
// EVICTION.md §10.1 — the canonical trigger vocabulary grows
// independently per detector), so validation here prevents a
// malicious / buggy detector from poisoning the audit trail with
// ANSI escapes, control chars, or oversize strings.
const TRIGGER_OVERRIDE_RE = /^[A-Za-z0-9_-]{1,64}$/;

// motivoForKind / triggerForProposal return either a validated value
// OR an `error` so the apply path can map an invalid override to a
// proposal rejection rather than letting `transitionMemoryState`
// fail later with a less informative message.
type ResolvedMotivo = { ok: true; value: EvictionMotivo } | { ok: false; reason: string };
type ResolvedTrigger = { ok: true; value: string } | { ok: false; reason: string };

const motivoForKind = (
  kind: MemoryGovernanceProposalRow['kind'],
  override: unknown,
): ResolvedMotivo => {
  if (override !== undefined && override !== null) {
    if (typeof override !== 'string') {
      return {
        ok: false,
        reason: `target_payload.motivo must be a string (got ${typeof override})`,
      };
    }
    if (!VALID_MOTIVOS.has(override as EvictionMotivo)) {
      return {
        ok: false,
        reason: `target_payload.motivo '${override}' is not one of: ${[...MOTIVOS].join(', ')}`,
      };
    }
    return { ok: true, value: override as EvictionMotivo };
  }
  if (kind === 'quarantine') return { ok: true, value: 'conflict' };
  if (kind === 'restore') return { ok: true, value: 'shift' };
  // Unsupported kinds short-circuit before reaching this helper.
  // Defensive default mirrors quarantine's choice.
  return { ok: true, value: 'conflict' };
};

const triggerForProposal = (proposedBy: string, override: unknown): ResolvedTrigger => {
  if (override !== undefined && override !== null) {
    if (typeof override !== 'string') {
      return {
        ok: false,
        reason: `target_payload.trigger must be a string (got ${typeof override})`,
      };
    }
    if (!TRIGGER_OVERRIDE_RE.test(override)) {
      return {
        ok: false,
        reason: `target_payload.trigger '${override}' must match ${TRIGGER_OVERRIDE_RE.source}`,
      };
    }
    return { ok: true, value: override };
  }
  // Map well-known proposed_by tags to the canonical detector triggers
  // (so `/memory audit --trigger verify_failed` surfaces approvals
  // driven by that detector). Other origins fall back to the
  // operator-driven trigger.
  if (proposedBy === 'subagent:verify-semantic') return { ok: true, value: 'verify_failed' };
  if (proposedBy === 'subagent:verify-conflict') return { ok: true, value: 'conflict_detected' };
  // S3.3 — verify-override is the LLM-judge variant that emits via
  // a subagent; the deterministic counter (detector:user_override_
  // repeated) is the future direct path for non-LLM detectors.
  // Both resolve to the same trigger value per spec §6.5.2.
  if (proposedBy === 'subagent:verify-override') {
    return { ok: true, value: 'user_override_repeated' };
  }
  if (proposedBy === 'detector:user_override_repeated') {
    return { ok: true, value: 'user_override_repeated' };
  }
  return { ok: true, value: OPERATOR_DRIVEN_TRIGGER };
};

const toStateForKind = (kind: MemoryGovernanceProposalRow['kind']): MemoryState => {
  if (kind === 'quarantine') return 'quarantined';
  if (kind === 'restore') return 'active';
  // Unsupported kinds short-circuit; defensive return mirrors the
  // most-common branch.
  return 'quarantined';
};

const buildEvidence = (proposal: MemoryGovernanceProposalRow): Record<string, unknown> => {
  // Mirror /memory quarantine's evidence shape so audit consumers
  // (slash list, /memory audit) treat governance-driven transitions
  // the same as direct operator commands. Carry trace fields back
  // to the originating proposal so a forensic query doesn't need a
  // separate JOIN.
  const detectorEvidence = proposal.evidence ?? {};
  return {
    [OPERATOR_DRIVEN_EVIDENCE_MARKER]: true,
    source: 'governance_apply',
    proposal_id: proposal.id,
    proposed_by: proposal.proposedBy,
    proposal_fingerprint: proposal.proposalFingerprint,
    // Spread last so a detector evidence field can't override the
    // trace markers above.
    detector_evidence: detectorEvidence,
  };
};

const rejectProposal = (
  db: DB,
  proposalId: string,
  decidedBy: string,
  decidedReason: string,
  nowMs: number | undefined,
): boolean => {
  const input: DecideProposalInput = {
    status: 'rejected',
    decidedBy,
    decidedReason,
    ...(nowMs !== undefined ? { decidedAt: nowMs } : {}),
  };
  // Returns true when the UPDATE landed; false when the row was
  // concurrently decided / expired / no longer pending. Callers MUST
  // check the return — silently returning `outcome: 'rejected'` when
  // another writer already set status='applied' would misrepresent
  // persisted state.
  return decideProposal(db, proposalId, input);
};

// Stamp `applied` on the proposal row and produce the apply-path
// success result, honoring concurrent decisions. `decideProposal`
// returns false when the row is no longer pending — TTL expiry, a
// racing reject, or a parallel apply path. The memory transition
// recorded in `transitions` already landed (this helper runs AFTER
// `transitionMemoryState` returned 'applied'); we cannot undo it.
//
// On race: re-read the row to capture who/what won, emit AUDIT DRIFT
// to stderr with the proposal id + memory key so operators can
// reconcile, and surface the actual row state via `governanceDrift`
// on the result. Callers that ignore drift see backward-compatible
// `outcome: 'applied'` plus transitions; callers that surface drift
// (slash commands, /memory governance audit) can flag the apply as
// having an unattributed governance row.
const settleApplied = (
  db: DB,
  proposalId: string,
  decidedBy: string,
  decidedReason: string | undefined,
  nowMs: number,
  transitions: TransitionRecord[],
  proposalKindLabel: string,
): ApplyProposalResult => {
  const input: DecideProposalInput = {
    status: 'applied',
    decidedBy,
    ...(decidedReason !== undefined ? { decidedReason } : {}),
    decidedAt: nowMs,
  };
  const persisted = decideProposal(db, proposalId, input);
  if (persisted) {
    return { outcome: 'applied', transitions };
  }
  const latest = getProposalById(db, proposalId);
  const targetSummary =
    transitions.length > 0
      ? transitions.map((t) => `${t.scope}/${t.name} ${t.fromState}→${t.toState}`).join(', ')
      : '<no transitions>';
  process.stderr.write(
    `memory: AUDIT DRIFT: proposal ${proposalId} (${proposalKindLabel}): ${targetSummary} landed but post-apply decideProposal raced — row now status=${latest?.status ?? '<missing>'} decided_by=${latest?.decidedBy ?? '<null>'}; manual reconciliation may be needed (join transitions[].evictionEventId with the proposal row)\n`,
  );
  if (latest === null) {
    // Row vanished entirely. Shouldn't happen for governance proposals
    // (no DELETE surface) but surface a sentinel rather than silently
    // claiming clean apply.
    return {
      outcome: 'applied',
      transitions,
      governanceDrift: { currentStatus: 'expired', decidedBy: null },
    };
  }
  return {
    outcome: 'applied',
    transitions,
    governanceDrift: { currentStatus: latest.status, decidedBy: latest.decidedBy },
  };
};

// Build an apply-path rejection result, honoring concurrent decisions:
// if `rejectProposal` returns false (status already terminal), re-load
// and surface `already_decided` with the actual current state instead
// of pretending we rejected.
const concludeRejection = (
  db: DB,
  proposalId: string,
  decidedBy: string,
  decidedReason: string,
  nowMs: number,
  reason: ApplyRejectionReason,
  message: string,
  details?: Record<string, unknown>,
): ApplyProposalResult => {
  const persisted = rejectProposal(db, proposalId, decidedBy, decidedReason, nowMs);
  if (persisted) {
    return {
      outcome: 'rejected',
      reason,
      message,
      ...(details !== undefined ? { details } : {}),
    };
  }
  const latest = getProposalById(db, proposalId);
  if (latest === null) {
    // Row vanished entirely — shouldn't happen for governance proposals
    // (no DELETE surface in V1) but surface a clear signal rather than
    // silently asserting the rejection landed.
    return { outcome: 'not_found', proposalId };
  }
  return {
    outcome: 'already_decided',
    currentStatus: latest.status,
    decidedBy: latest.decidedBy,
  };
};

// ─── public API ───────────────────────────────────────────────────────

export const applyProposal = async (input: ApplyProposalInput): Promise<ApplyProposalResult> => {
  const { db, registry, proposalId } = input;
  const nowMs = input.now !== undefined ? input.now() : Date.now();

  // (1) Existence + status gate.
  const proposal = getProposalById(db, proposalId);
  if (proposal === null) {
    return { outcome: 'not_found', proposalId };
  }
  if (proposal.status !== 'pending') {
    return {
      outcome: 'already_decided',
      currentStatus: proposal.status,
      decidedBy: proposal.decidedBy,
    };
  }

  // (2) Confidence gate. Detectors that supply null bypass the gate
  // (operator-driven proposals + deterministic counters).
  const threshold = input.confidenceThreshold ?? DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD;
  if (proposal.confidence !== null && proposal.confidence < threshold) {
    const reasonMsg = `confidence ${proposal.confidence.toFixed(2)} below threshold ${threshold.toFixed(2)}`;
    return concludeRejection(
      db,
      proposalId,
      'system:low_confidence',
      reasonMsg,
      nowMs,
      'low_confidence',
      reasonMsg,
      { confidence: proposal.confidence, threshold },
    );
  }

  // (3) Kind support gate. demote / merge / consolidate / expire are
  // accepted at the substrate so future detectors can land them
  // (avoids a migration when those detectors ship), but the apply
  // path doesn't execute them in S8 V1.
  if (!SUPPORTED_KINDS.has(proposal.kind)) {
    const reasonMsg = `kind '${proposal.kind}' is not supported by the apply path`;
    return concludeRejection(
      db,
      proposalId,
      'system:unimplemented_kind',
      reasonMsg,
      nowMs,
      'unimplemented_kind',
      reasonMsg,
      { kind: proposal.kind, supported: [...SUPPORTED_KINDS] },
    );
  }

  // (4) Single-memory gate with a multi-memory carve-out for
  // `quarantine + target_key` (MEMORY.md §11.3 gate-list).
  // Pair detectors (S13's verify-conflict is the canonical caller)
  // emit `sourceMemoryKeys = [winner, loser]` so the operator sees
  // both bodies on `/memory governance show`, but only the loser
  // (designated via `target_payload.target_key`) transitions on
  // approve. Restore + every other multi-memory shape still bounces
  // here.
  const targetPayload = proposal.targetPayload ?? {};
  const targetKeyRaw = targetPayload.target_key;
  const isMultiQuarantineWithTargetKey =
    proposal.kind === 'quarantine' &&
    proposal.sourceMemoryKeys.length > 1 &&
    targetKeyRaw !== null &&
    typeof targetKeyRaw === 'object' &&
    !Array.isArray(targetKeyRaw);
  if (proposal.sourceMemoryKeys.length !== 1 && !isMultiQuarantineWithTargetKey) {
    const reasonMsg = `kind '${proposal.kind}' requires exactly one source memory (got ${proposal.sourceMemoryKeys.length})`;
    return concludeRejection(
      db,
      proposalId,
      'system:multi_memory_unsupported',
      reasonMsg,
      nowMs,
      'multi_memory_unsupported',
      reasonMsg,
      { kind: proposal.kind, count: proposal.sourceMemoryKeys.length },
    );
  }
  // (4b) Validate the multi-memory carve-out: target_key shape +
  // bijection against source_memory_keys. A malformed target_key OR
  // one that names a memory not in the source list is a contract
  // violation — the proposal can't be applied because we don't know
  // which memory should transition.
  let targetKey: { scope: MemoryScope; name: string } | null = null;
  if (isMultiQuarantineWithTargetKey) {
    const tk = targetKeyRaw as { scope?: unknown; name?: unknown };
    const scope = typeof tk.scope === 'string' ? tk.scope : '';
    const name = typeof tk.name === 'string' ? tk.name : '';
    const matched = proposal.sourceMemoryKeys.find((k) => k.scope === scope && k.name === name);
    if (matched === undefined) {
      const reasonMsg = `target_payload.target_key {scope:${JSON.stringify(scope)}, name:${JSON.stringify(name)}} does not match any source_memory_keys entry`;
      return concludeRejection(
        db,
        proposalId,
        'system:invalid_target_key',
        reasonMsg,
        nowMs,
        'invalid_target_key',
        reasonMsg,
        { target_key: { scope, name }, source_keys: proposal.sourceMemoryKeys },
      );
    }
    targetKey = { scope: matched.scope, name: matched.name };
  }

  // (5) Staleness gate (drift wins over state_change per TODO S8.3).
  // Hash every referenced memory's current body and compare to the
  // snapshot captured at proposal creation. Any mismatch — or any
  // unreadable memory — rejects the proposal.
  //
  // We use `peek` (NOT `read`) so the staleness check doesn't emit
  // `memory_events action=read` + `memory_provenance` rows for what
  // is purely an internal verification step — the model never sees
  // these bytes.
  //
  // For `restore` proposals the source body may live in
  // `.tombstones/` rather than the scope root (evicted memory is
  // moved on `active → evicted`). We fall back to the latest
  // tombstone in that case so restore approvals don't always trip
  // the staleness gate. Quarantine / restore-from-quarantine paths
  // still hit the scope root via `peek` first.
  const isRestoreFromTombstone = proposal.kind === 'restore';
  const drifted: DriftedSnapshot[] = [];
  const currentFiles = new Map<string, MemoryFile>();
  for (const snap of proposal.sourceMemorySnapshots) {
    let currentFile: MemoryFile | undefined;
    const peek = registry.peek(snap.name, { scope: snap.scope });
    if (peek.kind === 'present') {
      currentFile = peek.file;
    } else if (isRestoreFromTombstone) {
      const tomb = findLatestTombstone(registry.roots, snap.scope, snap.name);
      if (tomb !== null) {
        try {
          currentFile = parseMemoryFile(readFileSync(tomb.path, 'utf-8'));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          drifted.push({
            scope: snap.scope,
            name: snap.name,
            snapshotHash: snap.contentHash,
            currentHash: null,
            reason: `tombstone read failed: ${reason}`,
          });
          continue;
        }
      }
    }
    if (currentFile === undefined) {
      drifted.push({
        scope: snap.scope,
        name: snap.name,
        snapshotHash: snap.contentHash,
        currentHash: null,
        reason: `current body unreadable (peek=${peek.kind}${isRestoreFromTombstone ? ', no tombstone' : ''})`,
      });
      continue;
    }
    let currentHash: string;
    try {
      currentHash = hashMemoryContent(serializeMemoryFile(currentFile));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      drifted.push({
        scope: snap.scope,
        name: snap.name,
        snapshotHash: snap.contentHash,
        currentHash: null,
        reason: `hash compute failed: ${reason}`,
      });
      continue;
    }
    if (currentHash !== snap.contentHash) {
      drifted.push({
        scope: snap.scope,
        name: snap.name,
        snapshotHash: snap.contentHash,
        currentHash,
        reason: 'content_hash drifted since proposal',
      });
      continue;
    }
    currentFiles.set(`${snap.scope}/${snap.name}`, currentFile);
  }
  if (drifted.length > 0) {
    // Summarize the drifted memories in the decision reason so
    // operators see the list without joining tables.
    const summary = drifted
      .map((d) => {
        const fromHash = d.snapshotHash.slice(0, 8);
        const toHash = d.currentHash === null ? '<unreadable>' : d.currentHash.slice(0, 8);
        return `${d.scope}/${d.name} (${fromHash} → ${toHash})`;
      })
      .join('; ');
    const reasonMsg = `source memory drifted since proposal: ${summary}`;
    return concludeRejection(
      db,
      proposalId,
      'system:stale_evidence',
      reasonMsg,
      nowMs,
      'stale_evidence',
      reasonMsg,
      { drifted },
    );
  }

  // (6) Execute the kind. Single-memory path for quarantine
  // (without target_key) / restore in S8 V1. The multi-memory
  // quarantine-with-target_key carve-out lands the SAME transition
  // shape — only the chosen `sourceKey` differs. Merge / consolidate
  // will land alongside future apply primitives.
  const sourceKey =
    targetKey !== null
      ? proposal.sourceMemoryKeys.find(
          (k) => k.scope === targetKey.scope && k.name === targetKey.name,
        )
      : proposal.sourceMemoryKeys[0];
  if (sourceKey === undefined) {
    // Length-1 OR target_key bijection invariant verified above;
    // defensive bail.
    return {
      outcome: 'rejected',
      reason: 'multi_memory_unsupported',
      message: 'source memory key missing despite gate checks',
    };
  }
  const target = targetPayload;
  const motivoResult = motivoForKind(proposal.kind, target.motivo);
  if (!motivoResult.ok) {
    return concludeRejection(
      db,
      proposalId,
      'system:invalid_evidence',
      motivoResult.reason,
      nowMs,
      'invalid_evidence',
      motivoResult.reason,
    );
  }
  const triggerResult = triggerForProposal(proposal.proposedBy, target.trigger);
  if (!triggerResult.ok) {
    return concludeRejection(
      db,
      proposalId,
      'system:invalid_evidence',
      triggerResult.reason,
      nowMs,
      'invalid_evidence',
      triggerResult.reason,
    );
  }
  const motivo = motivoResult.value;
  const trigger = triggerResult.value;
  const toState = toStateForKind(proposal.kind);
  const evidence = buildEvidence(proposal);

  const transitionResult = await transitionMemoryState({
    db,
    registry,
    roots: registry.roots,
    scope: sourceKey.scope,
    name: sourceKey.name,
    toState,
    motivo,
    trigger,
    actor: 'user',
    evidence,
    sessionId: input.sessionId ?? null,
    cwd: input.cwd ?? null,
    ...(input.fireHook !== undefined ? { fireHook: input.fireHook } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  // (7) Map transition outcome → governance decision.
  if (transitionResult.kind === 'applied') {
    if (transitionResult.fromState === transitionResult.toState) {
      // Same-state pseudo-transition (transitionMemoryState records
      // outcome=trigger_fired_no_action). The memory was already in
      // the target state — the proposal is moot. Mark it as state_change
      // so the operator sees why nothing happened (and a re-proposal
      // requires a fresh evidence essence to bypass dedup).
      const reasonMsg = `memory ${sourceKey.scope}/${sourceKey.name} already in state '${transitionResult.fromState}' — proposal moot`;
      return concludeRejection(
        db,
        proposalId,
        'system:state_change',
        reasonMsg,
        nowMs,
        'state_change',
        reasonMsg,
        {
          fromState: transitionResult.fromState,
          toState: transitionResult.toState,
        },
      );
    }
    return settleApplied(
      db,
      proposalId,
      input.decidedBy,
      input.decidedReason ?? undefined,
      nowMs,
      [
        {
          scope: sourceKey.scope,
          name: sourceKey.name,
          fromState: transitionResult.fromState,
          toState: transitionResult.toState,
          evictionEventId: transitionResult.evictionEventId,
        },
      ],
      `${proposal.kind} of ${sourceKey.scope}/${sourceKey.name}`,
    );
  }

  // Non-applied paths — proposal rejected with a reason that
  // mirrors the transition kind. The memory state on disk did NOT
  // change (or, for audit_drift, changed without the audit pair
  // landing — caller surface needs to escalate that case).
  if (transitionResult.kind === 'unknown') {
    const reasonMsg = `memory ${sourceKey.scope}/${sourceKey.name} not found at apply time`;
    return concludeRejection(
      db,
      proposalId,
      'system:state_change',
      reasonMsg,
      nowMs,
      'state_change',
      reasonMsg,
      { scope: sourceKey.scope, name: sourceKey.name },
    );
  }
  if (transitionResult.kind === 'illegal_transition') {
    const reasonMsg = `state machine refused ${transitionResult.fromState} → ${transitionResult.toState}: ${transitionResult.reason}`;
    return concludeRejection(
      db,
      proposalId,
      'system:state_change',
      reasonMsg,
      nowMs,
      'illegal_transition',
      reasonMsg,
      {
        fromState: transitionResult.fromState,
        toState: transitionResult.toState,
      },
    );
  }
  if (transitionResult.kind === 'blocked_by_protection') {
    const reasonMsg = `transition blocked by protection '${transitionResult.protection}': ${transitionResult.reason}`;
    return concludeRejection(
      db,
      proposalId,
      'system:state_change',
      reasonMsg,
      nowMs,
      'blocked_by_protection',
      reasonMsg,
      { protection: transitionResult.protection },
    );
  }
  if (transitionResult.kind === 'blocked_by_hook') {
    const reasonMsg = `transition blocked by hook '${transitionResult.blockedBy}': ${transitionResult.reason ?? 'no reason'}`;
    return concludeRejection(
      db,
      proposalId,
      'system:hook_blocked',
      reasonMsg,
      nowMs,
      'blocked_by_hook',
      reasonMsg,
      {
        blockedBy: transitionResult.blockedBy,
        hookReason: transitionResult.reason,
      },
    );
  }
  if (transitionResult.kind === 'invalid_evidence') {
    const reasonMsg = `evidence validation failed: ${transitionResult.reason}`;
    return concludeRejection(
      db,
      proposalId,
      'system:invalid_evidence',
      reasonMsg,
      nowMs,
      'invalid_evidence',
      reasonMsg,
      { fromState: transitionResult.fromState, toState: transitionResult.toState },
    );
  }
  if (transitionResult.kind === 'io_error') {
    const reasonMsg = `io error during apply: ${transitionResult.reason}`;
    // io_error rejection LEAVES the proposal pending so a retry
    // doesn't require operator re-approval. The substrate's UPDATE
    // skips the row if status moved (e.g., a parallel boot expired
    // it). This branch returns without touching governance state.
    return {
      outcome: 'rejected',
      reason: 'io_error',
      message: reasonMsg,
    };
  }
  // audit_drift: the transition completed ON DISK (frontmatter state
  // already mutated, body already in tombstone if applicable) but the
  // eviction_events INSERT failed. Earlier shape left the proposal
  // pending hoping a retry would land — but a retry HITS the staleness
  // gate (the frontmatter rewrite changed the canonical bytes), so it
  // auto-rejects forever as `system:stale_evidence`. The result was a
  // permanent dead row that operators could never decide.
  //
  // Correct posture: the memory IS in the target state, so the
  // proposal IS applied from the operator's perspective. Mark applied
  // with a decidedReason flagging the missing audit row, AND emit an
  // AUDIT DRIFT stderr alert with the proposal id so operations can
  // reconcile the missing eviction_events row manually if needed.
  process.stderr.write(
    `memory: AUDIT DRIFT: proposal ${proposalId} (${proposal.kind} of ${sourceKey.scope}/${sourceKey.name}): on-disk transition ${transitionResult.fromState} → ${transitionResult.toState} completed but eviction_events row did NOT land; manual reconciliation may be needed (${transitionResult.reason})\n`,
  );
  return settleApplied(
    db,
    proposalId,
    input.decidedBy,
    `audit_drift: transition completed on disk; eviction_events row missing — manual reconciliation may be needed (${transitionResult.reason})`,
    nowMs,
    [
      {
        scope: sourceKey.scope,
        name: sourceKey.name,
        fromState: transitionResult.fromState,
        toState: transitionResult.toState,
        // Synthesize a sentinel id since the eviction_events row
        // failed to write. Callers that grep this prefix can spot
        // audit-drift transitions vs successful ones.
        evictionEventId: `audit-drift:${proposalId}`,
      },
    ],
    `${proposal.kind} of ${sourceKey.scope}/${sourceKey.name}`,
  );
};
