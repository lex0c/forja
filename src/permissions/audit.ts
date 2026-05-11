// Audit sink — appends every engine decision to `approvals_log` with
// a sha256 hash chain (PERMISSION_ENGINE.md §7). Two implementations:
//
//   - createNoopSink()   — for tests and the bypass path. Returns
//                          sentinel seq=0 / empty hash; verifyChain
//                          always ok. Lets engine code emit
//                          unconditionally without conditional
//                          plumbing.
//
//   - createSqliteSink() — production. Bound to an `install_id`
//                          identity at construction. Each emit
//                          reads the chain tip via
//                          `getLastApprovalsLogByInstall`, computes
//                          `this_hash = sha256(prev_hash ‖
//                          canonical_row)`, INSERTs the full row.
//                          `verifyChain` walks the chain in seq
//                          order, recomputes each `this_hash`, and
//                          stops at the first mismatch.
//
// Canonical row: every persisted column EXCEPT seq and this_hash,
// encoded via the canonical JSON encoder (RFC 8785 essentials, see
// `canonical.ts`). Two writers given the same logical row produce
// the same bytes; two readers given the same row produce the same
// hash on verify. Determinism is load-bearing — the spec §1.8
// requires "toda decisão é replay-able".
//
// Genesis: per spec §7.2, the first row's `prev_hash` is
// `"GENESIS:" ‖ sha256(install_id ‖ created_at_ms)`. Bound to the
// installation: a DB copied from another machine fails verify
// because the genesis can't be reproduced without the matching
// identity file.

import type { DB } from '../storage/db.ts';
import {
  type ApprovalLogConfidence,
  type ApprovalLogDecision,
  type ApprovalLogRow,
  PERSISTED_COLUMNS,
  appendApprovalsLog,
  getLastApprovalsLogByInstall,
  listApprovalsLogByInstall,
} from '../storage/repos/approvals-log.ts';
import { getLatestChainMeta } from '../storage/repos/chain-rotation.ts';
import type { TelemetryEvent } from '../telemetry/index.ts';
import { canonicalize, sha256Hex } from './canonical.ts';
import type { InstallIdentity } from './install_id.ts';

// One entry in the decision's reason chain. Stages are documented
// in PERMISSION_ENGINE.md §6: 'resolve' → 'static-rule' → 'risk-score'
// → 'classifier' → 'sandbox-plan' → 'approval-gate'. Earlier slices
// emit a subset; the field stays string so new stages don't require
// a schema bump.
export interface ReasonChainEntry {
  stage: string;
  // Optional context — origin layer in the hierarchy, the matched
  // rule literal, the section key, and any free-form note. All
  // optional so simple stages emit one-key entries.
  layer?: string;
  rule?: string;
  section?: string;
  note?: string;
}

export interface AuditEmitInput {
  session_id: string;
  tool_name: string;
  // Tool args before they reach the tool. Engine hashes this with
  // `sha256(canonicalize(args))` to produce `args_hash` — raw args
  // never persist in the audit row (PII / secret hygiene).
  args: unknown;
  decision: 'allow' | 'deny' | 'confirm';
  // Resolved policy hash from the engine — same value for every
  // row emitted under a given policy. The engine computes this
  // once at construction (`canonicalize(policy)` → sha256).
  policy_hash: string;
  reason_chain: readonly ReasonChainEntry[];

  // Optional fields — future slices populate.
  parent_approval_id?: string | null;
  capabilities?: readonly string[];
  score?: number;
  score_components?: Record<string, number>;
  confidence?: ApprovalLogConfidence;
  classifier_hash?: string | null;
  classifier_adjust?: number | null;
  sandbox_profile?: string | null;
  ttl_expires_at?: number | null;
  tool_version?: string;
  resolver_version?: string;
  // Test seam — pin the wall clock for deterministic chain hashes.
  ts?: number;
}

export interface EmittedRow {
  seq: number;
  this_hash: string;
}

export type VerifyResult =
  | {
      ok: true;
      rows: number;
      // Rotation metadata (§7.2). Present for every result so the
      // caller can render quarantine status without a second query.
      // `current_rotation_id` is 0 for chains that never rotated.
      current_rotation_id: number;
      quarantined: boolean;
    }
  | {
      ok: false;
      brokenAt: number;
      reason: 'prev_hash_mismatch' | 'this_hash_mismatch';
      expected: string;
      actual: string;
      current_rotation_id: number;
      quarantined: boolean;
    };

export interface AuditSink {
  emit(input: AuditEmitInput): EmittedRow;
  verifyChain(): VerifyResult;
}

const NOOP_ROW: EmittedRow = { seq: 0, this_hash: '' };

export const createNoopSink = (): AuditSink => ({
  emit: () => NOOP_ROW,
  verifyChain: () => ({ ok: true, rows: 0, current_rotation_id: 0, quarantined: false }),
});

// Build the canonical-hash payload from a row's persisted columns.
// Pulls fields in the order declared by `PERSISTED_COLUMNS` except
// `this_hash`, because `this_hash` is the OUTPUT of the hash — it
// can't be input to itself. The `canonicalize` JSON encoder sorts
// keys lexicographically anyway, so the column order in the column
// list is purely aesthetic; what matters is that both `emit` and
// `verifyChain` build the SAME object shape from the SAME source.
const HASH_INPUT_COLUMNS = PERSISTED_COLUMNS.filter((c) => c !== 'this_hash');

const buildHashPayload = (
  row: Omit<ApprovalLogRow, 'seq' | 'this_hash'>,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const col of HASH_INPUT_COLUMNS) {
    payload[col] = (row as unknown as Record<string, unknown>)[col];
  }
  return payload;
};

// Spec §7.2: `prev_hash = "GENESIS:" || sha256(install_id || created_at_ms)`
// for the first row of each installation. The genesis hash is stable
// for a given identity. A chain rotation keeps the same install_id
// (per spec §7.2 "nova genesis com same install_id") so the genesis
// MUST shift to remain distinct from the pre-rotation chain;
// `computeRotatedGenesisHash` below carries that shift.
export const computeGenesisHash = (identity: InstallIdentity): string =>
  `GENESIS:${sha256Hex(`${identity.install_id}${identity.created_at_ms}`)}`;

// Post-rotation genesis hash. Same install_id, but the genesis incor-
// porates the rotation event identifiers so the new chain is byte-
// distinct from the archived one. The `GENESIS-ROTATED:` prefix makes
// the distinction visible in raw row inspection — a forensic reader
// scanning `prev_hash` columns can spot the boundary without joining
// against `chain_meta`.
export const computeRotatedGenesisHash = (
  identity: InstallIdentity,
  rotation_id: number,
  rotated_at_ms: number,
): string => `GENESIS-ROTATED:${sha256Hex(`${identity.install_id}${rotated_at_ms}${rotation_id}`)}`;

// PERMISSION_ENGINE.md §7.2 `--accept-broken-chain` lookup. Returns
// (seq, ts) for every audit row emitted by the bootstrap when the
// operator opted to continue under a known-broken chain. The
// `bootstrapPermissionEngine` flow writes one such row PER acceptance
// (so multiple resumes under different breaks all stack visibly in
// the chain).
//
// Filter strategy: `tool_name = 'permission-engine'` narrows the scan
// to engine-emitted rows (the only path that produces these), then a
// LIKE on `reason_chain_json` matches the `chain-break-accepted`
// stage marker. The LIKE is acceptable here because (a) the prefix
// filter on tool_name keeps the scanned set tiny in production
// (typically zero or single-digit rows), and (b) the chain stage
// marker is a stable string literal the engine writes verbatim — no
// JSON-shape sensitivity.
export interface ChainBreakAcceptedRow {
  seq: number;
  ts: number;
}

export const listChainBreakAcceptedRows = (db: DB, installId: string): ChainBreakAcceptedRow[] => {
  return db
    .query(
      `SELECT seq, ts
         FROM approvals_log
        WHERE install_id = ?
          AND tool_name = 'permission-engine'
          AND reason_chain_json LIKE '%chain-break-accepted%'
        ORDER BY seq ASC`,
    )
    .all(installId) as ChainBreakAcceptedRow[];
};

export interface CreateSqliteSinkOptions {
  identity: InstallIdentity;
  db: DB;
  // §7.3 sealing integration (slice 56). When set, every successful
  // `emit` notifies the scheduler via `tick()` so the scheduler can
  // count decisions toward `interval_decisions` and seal at the
  // appropriate threshold. Optional — sinks created without a
  // scheduler simply skip the notification and behave exactly as
  // before slice 56. Production wiring lives in the bootstrap
  // (slice 57): construct the scheduler from `[seal]` Policy config,
  // pass it here.
  scheduler?: { tick(): void };
  // §18 telemetry integration (slice 70). When set, every
  // successful `emit` produces a typed `permission.decision`
  // telemetry event mirroring the audit row's content. Structurally-
  // typed `{emit: (event: TelemetryEvent) => void}` so the sink
  // doesn't import from src/telemetry (peer modules — same
  // posture as the scheduler tick option). Production wires the
  // OTEL adapter; tests inject a recording sink. Failures in the
  // telemetry sink NEVER break audit emit — wrapped in try/catch
  // identical to the scheduler.tick handling.
  telemetry?: { emit: (event: TelemetryEvent) => void };
}

export const createSqliteSink = ({
  identity,
  db,
  scheduler,
  telemetry,
}: CreateSqliteSinkOptions): AuditSink => {
  // Resolve the active genesis once at construction. Rotations are
  // operator-driven via the CLI `--rotate-chain` flow that exits
  // before any engine starts, so the sink never sees a mid-flight
  // rotation; the latest `chain_meta` row at construction is the
  // definitive answer for this sink's lifetime.
  const latestMeta = getLatestChainMeta(db, identity.install_id);
  const current_rotation_id = latestMeta?.rotation_id ?? 0;
  const isQuarantined = latestMeta?.quarantined === 1;
  const genesisHash =
    latestMeta === null
      ? computeGenesisHash(identity)
      : computeRotatedGenesisHash(identity, latestMeta.rotation_id, latestMeta.rotated_at_ms);

  const emit = (input: AuditEmitInput): EmittedRow => {
    const last = getLastApprovalsLogByInstall(db, identity.install_id);
    const prev_hash = last === null ? genesisHash : last.this_hash;

    const args_hash = sha256Hex(canonicalize(input.args ?? {}));
    const ts = input.ts ?? Date.now();

    const persistedExceptHash: Omit<ApprovalLogRow, 'seq' | 'this_hash'> = {
      ts,
      install_id: identity.install_id,
      session_id: input.session_id,
      parent_approval_id: input.parent_approval_id ?? null,
      tool_name: input.tool_name,
      tool_version: input.tool_version ?? 'v1',
      resolver_version: input.resolver_version ?? 'v1',
      args_hash,
      capabilities_json: JSON.stringify(input.capabilities ?? []),
      decision: input.decision as ApprovalLogDecision,
      score: input.score ?? 0,
      score_components_json: JSON.stringify(input.score_components ?? {}),
      confidence: input.confidence ?? 'high',
      classifier_hash: input.classifier_hash ?? null,
      classifier_adjust: input.classifier_adjust ?? null,
      policy_hash: input.policy_hash,
      sandbox_profile: input.sandbox_profile ?? null,
      ttl_expires_at: input.ttl_expires_at ?? null,
      reason_chain_json: JSON.stringify(input.reason_chain),
      prev_hash,
    };

    const this_hash = sha256Hex(prev_hash + canonicalize(buildHashPayload(persistedExceptHash)));
    const inserted = appendApprovalsLog(db, { ...persistedExceptHash, this_hash });
    // §7.3 sealing tick (slice 56). ORDER MATTERS: the row is
    // already persisted, so the scheduler's `sealLatestInternal`
    // sees the up-to-date chain head when it queries
    // `getLastApprovalsLogByInstall`. Wrapped in try/catch because
    // the audit path is critical and sealing is best-effort —
    // scheduler internals OR a user-supplied `onSealFailed`
    // callback throwing must NOT break audit emission.
    if (scheduler !== undefined) {
      try {
        scheduler.tick();
      } catch {
        // Best-effort. Surfacing the error here would mean a
        // half-emitted row from the caller's perspective — the row
        // is in the DB, but emit() threw. Silently swallow.
      }
    }
    // §18 telemetry emission (slice 70). Same posture as the
    // scheduler tick: AFTER persist so the event's approval_id
    // (= row.seq) is stable, wrapped in try/catch because
    // observability MUST NOT break audit emit. The event carries
    // the row's content minus secrets-bearing fields (args + raw
    // chain hashes); resolved capabilities + decision + score +
    // policy_hash + classifier_hash are operator-facing
    // diagnostics, safe to export.
    if (telemetry !== undefined) {
      try {
        telemetry.emit({
          kind: 'permission.decision',
          ts,
          approval_id: inserted.seq,
          parent_approval_id: persistedExceptHash.parent_approval_id,
          tool: persistedExceptHash.tool_name,
          tool_version: persistedExceptHash.tool_version,
          resolver_version: persistedExceptHash.resolver_version,
          capabilities: input.capabilities ?? [],
          decision: persistedExceptHash.decision,
          score: persistedExceptHash.score,
          score_components: input.score_components ?? {},
          confidence: persistedExceptHash.confidence,
          policy_hash: persistedExceptHash.policy_hash,
          classifier_hash: persistedExceptHash.classifier_hash,
          classifier_adjust: persistedExceptHash.classifier_adjust,
          sandbox_profile: persistedExceptHash.sandbox_profile,
          ttl_expires_at: persistedExceptHash.ttl_expires_at,
        });
      } catch {
        // Same rationale as the scheduler tick — observability
        // failures cannot corrupt the audit emit signal.
      }
    }
    return { seq: inserted.seq, this_hash };
  };

  const verifyChain = (): VerifyResult => {
    // Re-read the rotation tip on every verify so an out-of-process
    // CLI rotation between `createSqliteSink` and a later
    // `verifyChain` call is still reflected. emit() does not re-read
    // (no concurrent rotation under the same sink by construction),
    // but verify is also exposed via `agent permission verify` which
    // operates on a freshly-constructed sink.
    const tipMeta = getLatestChainMeta(db, identity.install_id);
    const tipRotationId = tipMeta?.rotation_id ?? 0;
    const tipQuarantined = tipMeta?.quarantined === 1;
    const rows = listApprovalsLogByInstall(db, identity.install_id);
    let expectedPrev = genesisHash;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: 'prev_hash_mismatch',
          expected: expectedPrev,
          actual: row.prev_hash,
          current_rotation_id: tipRotationId,
          quarantined: tipQuarantined,
        };
      }
      const recomputed = sha256Hex(row.prev_hash + canonicalize(buildHashPayload(row)));
      if (recomputed !== row.this_hash) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: 'this_hash_mismatch',
          expected: recomputed,
          actual: row.this_hash,
          current_rotation_id: tipRotationId,
          quarantined: tipQuarantined,
        };
      }
      expectedPrev = row.this_hash;
    }
    return {
      ok: true,
      rows: rows.length,
      current_rotation_id: tipRotationId,
      quarantined: tipQuarantined,
    };
  };

  // Surface construction-time rotation snapshot for tests that need
  // to inspect the sink state without populating any rows first.
  // Returned as a side-channel through verifyChain (already includes
  // current_rotation_id + quarantined) — unused vars below silence
  // TS noUnused; both are read inside verifyChain's closures.
  void current_rotation_id;
  void isQuarantined;
  return { emit, verifyChain };
};
