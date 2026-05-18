// memory_governance_proposals repo (MEMORY.md §11.3, migration 056).
//
// Detectors emit proposals; operators approve; the apply path
// (`src/memory/governance.ts:applyProposal`) delegates to
// `transitionMemoryState`. This module owns the persistence layer
// only — no policy decisions live here. Policy gates (confidence
// threshold, staleness check, kind support matrix) are in the
// apply path so the repo stays a CRUD substrate the slash, the
// detector, and the apply path all consume.
//
// Discipline carried forward from memory-provenance / eviction-events:
//
//   - JSON columns are written canonical (sorted keys via the repo)
//     so the fingerprint is deterministic regardless of caller
//     ordering. Reads parse defensively.
//   - Every list helper takes an explicit limit (default 50). No
//     unbounded SELECTs reach the operator surface.
//   - Append-only on `id` — UPDATE only on the decision columns
//     (status, decided_*). The auxiliary keys table is INSERT-once
//     at recordProposal time; FK CASCADE handles cleanup.
//   - UNIQUE partial index on (proposal_fingerprint) WHERE
//     status='pending' is the at-most-one-pending-per-fingerprint
//     gate. The repo catches the constraint failure and returns
//     the existing row's id instead of throwing — silent dedup is
//     the spec contract (two detectors racing should not surface
//     to the operator).

import { createHash } from 'node:crypto';
import type { MemoryScope } from '../../memory/index.ts';
import { type DB, withTransaction } from '../db.ts';

// ─── kinds + statuses (mirror migration CHECK constraints) ────────────

export const GOVERNANCE_PROPOSAL_KINDS = [
  'quarantine',
  'restore',
  'demote',
  'merge',
  'consolidate',
  'expire',
] as const;
export type MemoryGovernanceProposalKind = (typeof GOVERNANCE_PROPOSAL_KINDS)[number];

export const GOVERNANCE_PROPOSAL_STATUSES = ['pending', 'applied', 'rejected', 'expired'] as const;
export type MemoryGovernanceProposalStatus = (typeof GOVERNANCE_PROPOSAL_STATUSES)[number];

const VALID_KINDS: ReadonlySet<MemoryGovernanceProposalKind> = new Set(GOVERNANCE_PROPOSAL_KINDS);
const VALID_STATUSES: ReadonlySet<MemoryGovernanceProposalStatus> = new Set(
  GOVERNANCE_PROPOSAL_STATUSES,
);
const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set(['user', 'project_shared', 'project_local']);

// ─── tunables ─────────────────────────────────────────────────────────

// 30d sliding window for pending proposals — per MEMORY.md §11.3 +
// TODO S8.4. A pending proposal that didn't get reviewed in 30 days
// loses authority; the underlying memory body / detector context
// may have drifted. Auto-expiry forces detectors to re-emit if the
// finding still holds. Constant is exported so the bootstrap sweep
// + tests can reference the same value.
export const GOVERNANCE_PROPOSAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Default minimum confidence for the apply path's auto-reject gate.
// Phase 2 LLM-judge slices (S11 / S13) override this via constants
// like `SEMANTIC_VERIFY_MIN_CONFIDENCE`. Detectors that don't
// supply a confidence number (operator-authored, deterministic
// counters) bypass the gate (confidence === null).
export const DEFAULT_GOVERNANCE_CONFIDENCE_THRESHOLD = 0.7;

// ─── public shapes ────────────────────────────────────────────────────

export interface MemoryKey {
  scope: MemoryScope;
  name: string;
}

export interface MemorySnapshot {
  scope: MemoryScope;
  name: string;
  // SHA-256 hex of `serializeMemoryFile(file)` at proposal-creation
  // time. The apply path re-hashes the current body and rejects if
  // the value drifted. NULL would defeat the staleness gate; the
  // repo requires non-empty strings here.
  contentHash: string;
}

export interface MemoryGovernanceProposalRow {
  id: string;
  sessionId: string | null;
  kind: MemoryGovernanceProposalKind;
  // Always returned in canonical sorted order regardless of insertion
  // order — the fingerprint depends on it, and downstream consumers
  // (slash render, apply path) expect stable iteration.
  sourceMemoryKeys: MemoryKey[];
  targetPayload: Record<string, unknown> | null;
  confidence: number | null;
  evidence: Record<string, unknown>;
  status: MemoryGovernanceProposalStatus;
  proposedBy: string;
  proposalFingerprint: string;
  sourceMemorySnapshots: MemorySnapshot[];
  decidedReason: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface RecordProposalInput {
  // Optional; defaults to crypto.randomUUID(). Caller pins when
  // replaying / importing.
  id?: string;
  sessionId: string | null;
  kind: MemoryGovernanceProposalKind;
  // Caller MAY pass keys in any order; the repo sorts canonically
  // before fingerprinting + persisting. One-element for single-
  // memory proposals; multi-element for merge/consolidate.
  sourceMemoryKeys: MemoryKey[];
  targetPayload?: Record<string, unknown> | null;
  confidence?: number | null;
  evidence: Record<string, unknown>;
  proposedBy: string;
  // Caller MUST pass one snapshot per source key (same length,
  // matching by {scope, name}). The repo validates the bijection.
  sourceMemorySnapshots: MemorySnapshot[];
  // Detector-supplied dedup essence. Defaults to JSON.stringify
  // of the evidence object — fine for detectors that emit
  // deterministic evidence. LLM-judge detectors override with a
  // stable extract (e.g. the LLM's `claim_extracted`) so two
  // runs with different ephemeral details (timestamps, model_id)
  // still collapse to one pending proposal.
  evidenceEssence?: string;
  // Optional; defaults to Date.now().
  createdAt?: number;
}

export interface RecordProposalResult {
  // Always set. Either the just-inserted id OR the id of an existing
  // pending row that matched the fingerprint (silent dedup per
  // MEMORY.md §11.3).
  id: string;
  // True when an existing pending row matched the fingerprint and
  // no INSERT happened. The slash command surface uses this to
  // render "proposal already pending as <id>" instead of "new
  // proposal recorded as <id>".
  deduped: boolean;
}

// ─── helpers ──────────────────────────────────────────────────────────

const canonicalKeyOrder = (keys: readonly MemoryKey[]): MemoryKey[] => {
  // Sort by scope/name lexicographic. Spread first so caller's
  // array isn't mutated.
  return [...keys].sort((a, b) => {
    const aTag = `${a.scope}/${a.name}`;
    const bTag = `${b.scope}/${b.name}`;
    return aTag < bTag ? -1 : aTag > bTag ? 1 : 0;
  });
};

// Stable JSON.stringify with deterministic object-key ordering.
// JS objects iterate in insertion order, so `JSON.stringify({a, b})`
// and `JSON.stringify({b, a})` produce different strings — fatal for
// the default `evidenceEssence` derivation because two detectors
// emitting equivalent evidence in different key orders would compute
// different fingerprints and the silent-dedup gate would never fire.
//
// Walk: objects → keys sorted ascending, values recursively
// canonicalized. Arrays preserve order (positional semantics).
// Primitives + null go through unchanged. Functions / undefined
// values are dropped (matches default JSON.stringify behavior).
//
// Cost: O(n log n) per object level. Evidence payloads are bounded
// (operator-facing slash truncates display at 240 chars; detector
// outputs are JSON-schema-validated to a few fields) so the cost is
// negligible against the SHA-256 hashing it feeds.
export const canonicalJsonStringify = (value: unknown): string => {
  const canonicalize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canonicalize);
    const obj = v as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) out[k] = canonicalize(obj[k]);
    return out;
  };
  return JSON.stringify(canonicalize(value));
};

// Fingerprint contract: SHA-256 hex of a stable JSON projection of
// (kind, sorted source keys, evidence essence). Exposed so tests
// can pin the same shape detectors will hash against and so the
// apply path can re-compute for assertions.
export const computeProposalFingerprint = (input: {
  kind: MemoryGovernanceProposalKind;
  sourceMemoryKeys: readonly MemoryKey[];
  evidenceEssence: string;
}): string => {
  const sorted = canonicalKeyOrder(input.sourceMemoryKeys);
  const canonical = JSON.stringify({
    kind: input.kind,
    source_memory_keys: sorted.map((k) => ({ scope: k.scope, name: k.name })),
    evidence_essence: input.evidenceEssence,
  });
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
};

const validateKeys = (keys: readonly MemoryKey[]): void => {
  if (keys.length === 0) {
    throw new Error('recordProposal: sourceMemoryKeys must be non-empty');
  }
  for (const k of keys) {
    if (!VALID_SCOPES.has(k.scope)) {
      throw new Error(`recordProposal: invalid memory scope '${k.scope}'`);
    }
    if (typeof k.name !== 'string' || k.name.length === 0) {
      throw new Error('recordProposal: memory name must be non-empty string');
    }
  }
};

const validateSnapshots = (
  keys: readonly MemoryKey[],
  snapshots: readonly MemorySnapshot[],
): void => {
  if (snapshots.length !== keys.length) {
    throw new Error(
      `recordProposal: sourceMemorySnapshots length (${snapshots.length}) must match sourceMemoryKeys length (${keys.length})`,
    );
  }
  // Bijection check — every key must have exactly one snapshot at
  // the same (scope, name). Catches caller bugs where the arrays
  // got out of sync (e.g., one was reordered).
  const keySet = new Set(keys.map((k) => `${k.scope}/${k.name}`));
  const snapSet = new Set(snapshots.map((s) => `${s.scope}/${s.name}`));
  if (keySet.size !== snapSet.size) {
    throw new Error('recordProposal: duplicate (scope, name) in sourceMemoryKeys or snapshots');
  }
  for (const tag of keySet) {
    if (!snapSet.has(tag)) {
      throw new Error(`recordProposal: missing snapshot for ${tag}`);
    }
  }
  for (const s of snapshots) {
    if (!VALID_SCOPES.has(s.scope)) {
      throw new Error(`recordProposal: invalid snapshot scope '${s.scope}'`);
    }
    if (typeof s.contentHash !== 'string' || s.contentHash.length === 0) {
      throw new Error(`recordProposal: snapshot for ${s.scope}/${s.name} missing contentHash`);
    }
  }
};

// JSON serialize with stable shape. Picks scope/name only (drops
// stray fields a caller might have added) so the on-disk JSON is
// the canonical projection — fingerprint and downstream consumers
// rely on this.
const stringifyKeys = (keys: readonly MemoryKey[]): string =>
  JSON.stringify(canonicalKeyOrder(keys).map((k) => ({ scope: k.scope, name: k.name })));

const stringifySnapshots = (snapshots: readonly MemorySnapshot[]): string => {
  // Sort by scope/name same as keys so persisted JSON is canonical.
  const sorted = [...snapshots].sort((a, b) => {
    const aTag = `${a.scope}/${a.name}`;
    const bTag = `${b.scope}/${b.name}`;
    return aTag < bTag ? -1 : aTag > bTag ? 1 : 0;
  });
  return JSON.stringify(
    sorted.map((s) => ({ scope: s.scope, name: s.name, content_hash: s.contentHash })),
  );
};

interface RawProposalRow {
  id: string;
  session_id: string | null;
  kind: string;
  source_memory_keys: string;
  target_payload: string | null;
  confidence: number | null;
  evidence: string;
  status: string;
  proposed_by: string;
  proposal_fingerprint: string;
  source_memory_snapshots: string;
  decided_reason: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

const parseJsonOrThrow = <T>(raw: string, field: string, id: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`memory_governance_proposals[${id}]: ${field} JSON parse failed: ${msg}`);
  }
};

const fromRow = (row: RawProposalRow): MemoryGovernanceProposalRow => {
  if (!VALID_KINDS.has(row.kind as MemoryGovernanceProposalKind)) {
    throw new Error(`memory_governance_proposals[${row.id}]: invalid kind '${row.kind}'`);
  }
  if (!VALID_STATUSES.has(row.status as MemoryGovernanceProposalStatus)) {
    throw new Error(`memory_governance_proposals[${row.id}]: invalid status '${row.status}'`);
  }
  const rawSnapshots = parseJsonOrThrow<
    Array<{ scope: string; name: string; content_hash: string }>
  >(row.source_memory_snapshots, 'source_memory_snapshots', row.id);
  const snapshots: MemorySnapshot[] = rawSnapshots.map((s) => {
    if (!VALID_SCOPES.has(s.scope as MemoryScope)) {
      throw new Error(
        `memory_governance_proposals[${row.id}]: snapshot has invalid scope '${s.scope}'`,
      );
    }
    return { scope: s.scope as MemoryScope, name: s.name, contentHash: s.content_hash };
  });
  const rawKeys = parseJsonOrThrow<Array<{ scope: string; name: string }>>(
    row.source_memory_keys,
    'source_memory_keys',
    row.id,
  );
  const keys: MemoryKey[] = rawKeys.map((k) => {
    if (!VALID_SCOPES.has(k.scope as MemoryScope)) {
      throw new Error(`memory_governance_proposals[${row.id}]: key has invalid scope '${k.scope}'`);
    }
    return { scope: k.scope as MemoryScope, name: k.name };
  });
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as MemoryGovernanceProposalKind,
    sourceMemoryKeys: keys,
    targetPayload:
      row.target_payload === null
        ? null
        : parseJsonOrThrow<Record<string, unknown>>(row.target_payload, 'target_payload', row.id),
    confidence: row.confidence,
    evidence: parseJsonOrThrow<Record<string, unknown>>(row.evidence, 'evidence', row.id),
    status: row.status as MemoryGovernanceProposalStatus,
    proposedBy: row.proposed_by,
    proposalFingerprint: row.proposal_fingerprint,
    sourceMemorySnapshots: snapshots,
    decidedReason: row.decided_reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
};

const SELECT_ALL = `
  SELECT id, session_id, kind, source_memory_keys, target_payload,
         confidence, evidence, status, proposed_by, proposal_fingerprint,
         source_memory_snapshots, decided_reason, created_at, decided_at, decided_by
    FROM memory_governance_proposals
`;

const isConstraintError = (err: unknown): boolean => {
  // bun:sqlite SQLiteError carries `code: 'SQLITE_CONSTRAINT'` and
  // message text containing 'UNIQUE constraint failed'. Match on
  // either signal — depending on bun version one or the other may
  // be the surface.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true;
  if (typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)) return true;
  return false;
};

// ─── recordProposal ───────────────────────────────────────────────────

const INSERT_PROPOSAL_SQL = `
  INSERT INTO memory_governance_proposals (
    id, session_id, kind, source_memory_keys, target_payload, confidence,
    evidence, status, proposed_by, proposal_fingerprint,
    source_memory_snapshots, decided_reason, created_at, decided_at, decided_by
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, NULL, NULL)
`;

const INSERT_KEY_SQL = `
  INSERT INTO memory_governance_proposal_keys (proposal_id, memory_scope, memory_name)
  VALUES (?, ?, ?)
`;

const SELECT_PENDING_BY_FINGERPRINT_SQL = `
  ${SELECT_ALL}
   WHERE proposal_fingerprint = ? AND status = 'pending'
   LIMIT 1
`;

// INSERT a new proposal. On fingerprint collision with an existing
// pending row, return that row's id with `deduped: true` and skip
// the INSERT entirely (silent dedup per spec).
//
// Atomicity: the parent row + every key row land in one transaction.
// If the keys insert fails halfway, the parent is rolled back too —
// we don't want orphan parent rows without their key index entries
// (would defeat listProposalsForMemory).
export const recordProposal = (db: DB, input: RecordProposalInput): RecordProposalResult => {
  if (!VALID_KINDS.has(input.kind)) {
    throw new Error(`recordProposal: invalid kind '${input.kind}'`);
  }
  validateKeys(input.sourceMemoryKeys);
  validateSnapshots(input.sourceMemoryKeys, input.sourceMemorySnapshots);
  if (input.confidence !== undefined && input.confidence !== null) {
    if (input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.confidence)) {
      throw new Error(`recordProposal: confidence must be in [0, 1] (got ${input.confidence})`);
    }
  }
  if (typeof input.proposedBy !== 'string' || input.proposedBy.length === 0) {
    throw new Error('recordProposal: proposedBy must be non-empty string');
  }
  const createdAt = input.createdAt ?? Date.now();
  if (createdAt <= 0) {
    throw new Error(`recordProposal: createdAt must be > 0 epoch ms (got ${createdAt})`);
  }

  // Default evidence-essence is a key-sorted canonical JSON so two
  // detectors that emit the same fields in different orders still
  // collapse to one fingerprint. Detectors with volatile evidence
  // (timestamps, run ids) should still pass an explicit
  // `evidenceEssence` extracting only the stable bits.
  const evidenceEssence = input.evidenceEssence ?? canonicalJsonStringify(input.evidence);
  const fingerprint = computeProposalFingerprint({
    kind: input.kind,
    sourceMemoryKeys: input.sourceMemoryKeys,
    evidenceEssence,
  });
  const id = input.id ?? crypto.randomUUID();
  const keysJson = stringifyKeys(input.sourceMemoryKeys);
  const snapshotsJson = stringifySnapshots(input.sourceMemorySnapshots);
  const targetPayloadJson =
    input.targetPayload === undefined || input.targetPayload === null
      ? null
      : JSON.stringify(input.targetPayload);
  const evidenceJson = JSON.stringify(input.evidence);
  const confidence = input.confidence ?? null;

  // Two-statement transaction. `withTransaction` wraps
  // `db.transaction(fn)()` which uses SAVEPOINTs and nests safely if
  // a caller is already inside a transaction. Manual BEGIN/COMMIT
  // here would (a) throw "cannot start a transaction within a
  // transaction" when nested and (b) the catch's ROLLBACK would
  // unwind the OUTER transaction. The previous shape also masked
  // BEGIN failures because the catch ran ROLLBACK against a non-
  // existent transaction; withTransaction lets bun:sqlite handle
  // both correctly.
  try {
    withTransaction(db, () => {
      db.query(INSERT_PROPOSAL_SQL).run(
        id,
        input.sessionId,
        input.kind,
        keysJson,
        targetPayloadJson,
        confidence,
        evidenceJson,
        input.proposedBy,
        fingerprint,
        snapshotsJson,
        createdAt,
      );
      const sortedKeys = canonicalKeyOrder(input.sourceMemoryKeys);
      const insertKey = db.query(INSERT_KEY_SQL);
      for (const k of sortedKeys) {
        insertKey.run(id, k.scope, k.name);
      }
    });
    return { id, deduped: false };
  } catch (err) {
    if (isConstraintError(err)) {
      // Most likely the UNIQUE partial fingerprint index. Lookup
      // the existing pending row and return its id.
      const existing = db
        .query<RawProposalRow, [string]>(SELECT_PENDING_BY_FINGERPRINT_SQL)
        .get(fingerprint);
      if (existing !== null) {
        return { id: existing.id, deduped: true };
      }
      // Fingerprint not pending — must be another constraint (e.g.,
      // PRIMARY KEY collision on caller-supplied id). Re-throw so
      // caller sees the underlying error.
    }
    throw err;
  }
};

// ─── reads ────────────────────────────────────────────────────────────

export const getProposalById = (db: DB, id: string): MemoryGovernanceProposalRow | null => {
  const row = db.query<RawProposalRow, [string]>(`${SELECT_ALL} WHERE id = ? LIMIT 1`).get(id);
  return row === null ? null : fromRow(row);
};

export interface ListProposalsOptions {
  // Filter by status. Omit for all statuses.
  status?: MemoryGovernanceProposalStatus;
  // Filter by session. Omit for cross-session.
  sessionId?: string | null;
  limit?: number;
}

// Cross-session global list — operator's primary surface. Pass
// `status: 'pending'` for the action queue.
export const listProposals = (
  db: DB,
  opts: ListProposalsOptions = {},
): MemoryGovernanceProposalRow[] => {
  const limit = opts.limit ?? 50;
  const clauses: string[] = [];
  const params: Array<string | number | null> = [];
  if (opts.status !== undefined) {
    if (!VALID_STATUSES.has(opts.status)) {
      throw new Error(`listProposals: invalid status '${opts.status}'`);
    }
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts.sessionId !== undefined) {
    clauses.push('session_id IS ?');
    params.push(opts.sessionId);
  }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
  params.push(limit);
  const rows = db
    .query<RawProposalRow, typeof params>(
      `${SELECT_ALL} ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map(fromRow);
};

// Pending-only convenience — most-recent first, ready to render in
// the operator queue.
export const listPendingProposals = (db: DB, limit = 50): MemoryGovernanceProposalRow[] =>
  listProposals(db, { status: 'pending', limit });

// All proposals referencing a memory, regardless of status. Backed
// by the auxiliary `memory_governance_proposal_keys` index — no
// JSON pattern matching, no full-table scan.
export const listProposalsForMemory = (
  db: DB,
  scope: MemoryScope,
  name: string,
  limit = 50,
): MemoryGovernanceProposalRow[] => {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`listProposalsForMemory: invalid scope '${scope}'`);
  }
  const rows = db
    .query<RawProposalRow, [MemoryScope, string, number]>(
      `SELECT p.id, p.session_id, p.kind, p.source_memory_keys, p.target_payload,
              p.confidence, p.evidence, p.status, p.proposed_by, p.proposal_fingerprint,
              p.source_memory_snapshots, p.decided_reason, p.created_at, p.decided_at, p.decided_by
         FROM memory_governance_proposals p
         INNER JOIN memory_governance_proposal_keys k ON k.proposal_id = p.id
        WHERE k.memory_scope = ? AND k.memory_name = ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`,
    )
    .all(scope, name, limit);
  return rows.map(fromRow);
};

// Pending-only variant of listProposalsForMemory. Used by the S11
// pre-dispatch dedup guard ("if a pending proposal already exists
// for this memory, skip LLM dispatch") and by the slash inspector.
export const listPendingProposalsForMemory = (
  db: DB,
  scope: MemoryScope,
  name: string,
  limit = 50,
): MemoryGovernanceProposalRow[] => {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`listPendingProposalsForMemory: invalid scope '${scope}'`);
  }
  const rows = db
    .query<RawProposalRow, [MemoryScope, string, number]>(
      `SELECT p.id, p.session_id, p.kind, p.source_memory_keys, p.target_payload,
              p.confidence, p.evidence, p.status, p.proposed_by, p.proposal_fingerprint,
              p.source_memory_snapshots, p.decided_reason, p.created_at, p.decided_at, p.decided_by
         FROM memory_governance_proposals p
         INNER JOIN memory_governance_proposal_keys k ON k.proposal_id = p.id
        WHERE k.memory_scope = ? AND k.memory_name = ? AND p.status = 'pending'
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`,
    )
    .all(scope, name, limit);
  return rows.map(fromRow);
};

// ─── decideProposal ───────────────────────────────────────────────────

export interface DecideProposalInput {
  status: 'applied' | 'rejected' | 'expired';
  decidedBy: string;
  decidedReason?: string | null;
  decidedAt?: number;
}

// Transition a pending proposal to a terminal state. Returns true
// when a row was updated; false when the id was unknown OR the
// proposal was already in a terminal state (idempotency).
//
// The transition is intentionally non-atomic w.r.t. the apply path
// (transitionMemoryState): apply path mutates memory state, repo
// updates governance status. The two are sequenced by
// `applyProposal` in `src/memory/governance.ts` — repo is the
// substrate, not the orchestrator.
export const decideProposal = (db: DB, id: string, input: DecideProposalInput): boolean => {
  if (typeof input.decidedBy !== 'string' || input.decidedBy.length === 0) {
    throw new Error('decideProposal: decidedBy must be non-empty string');
  }
  const decidedAt = input.decidedAt ?? Date.now();
  if (decidedAt <= 0) {
    throw new Error(`decideProposal: decidedAt must be > 0 epoch ms (got ${decidedAt})`);
  }
  const result = db
    .query(
      `UPDATE memory_governance_proposals
          SET status = ?, decided_by = ?, decided_reason = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(input.status, input.decidedBy, input.decidedReason ?? null, decidedAt, id);
  return Number(result.changes) > 0;
};

// ─── expirePendingProposals ───────────────────────────────────────────

// Bulk-transition every pending proposal with created_at < cutoff
// to status='expired', decided_by='system:ttl'. Returns the row
// count for telemetry. Used by the bootstrap-time sweep (T8.4).
//
// The cutoff is EXCLUSIVE — a row at exactly cutoff is KEPT. Same
// semantic as pruneMemoryProvenance for consistency.
export const expirePendingProposals = (db: DB, olderThanMs: number, nowMs?: number): number => {
  const decidedAt = nowMs ?? Date.now();
  if (decidedAt <= 0) {
    throw new Error(`expirePendingProposals: nowMs must be > 0 (got ${decidedAt})`);
  }
  const result = db
    .query(
      `UPDATE memory_governance_proposals
          SET status = 'expired', decided_by = 'system:ttl',
              decided_reason = 'pending > 30d retention window',
              decided_at = ?
        WHERE status = 'pending' AND created_at < ?`,
    )
    .run(decidedAt, olderThanMs);
  return Number(result.changes);
};
