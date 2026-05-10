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
  | { ok: true; rows: number }
  | {
      ok: false;
      brokenAt: number;
      reason: 'prev_hash_mismatch' | 'this_hash_mismatch';
      expected: string;
      actual: string;
    };

export interface AuditSink {
  emit(input: AuditEmitInput): EmittedRow;
  verifyChain(): VerifyResult;
}

const NOOP_ROW: EmittedRow = { seq: 0, this_hash: '' };

export const createNoopSink = (): AuditSink => ({
  emit: () => NOOP_ROW,
  verifyChain: () => ({ ok: true, rows: 0 }),
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
// for a given identity — a chain rotation (spec §7.2 "Quebra de chain")
// rewrites install_id (creating a new identity) and therefore a new
// genesis.
export const computeGenesisHash = (identity: InstallIdentity): string =>
  `GENESIS:${sha256Hex(`${identity.install_id}${identity.created_at_ms}`)}`;

export interface CreateSqliteSinkOptions {
  identity: InstallIdentity;
  db: DB;
}

export const createSqliteSink = ({ identity, db }: CreateSqliteSinkOptions): AuditSink => {
  const genesisHash = computeGenesisHash(identity);

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
    return { seq: inserted.seq, this_hash };
  };

  const verifyChain = (): VerifyResult => {
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
        };
      }
      expectedPrev = row.this_hash;
    }
    return { ok: true, rows: rows.length };
  };

  return { emit, verifyChain };
};
