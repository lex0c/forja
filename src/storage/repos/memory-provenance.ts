// memory_provenance repo (MEMORY.md §11.2, migration 054).
//
// Records EXPOSURES — moments where the model had a memory's bytes
// in its window. NOT causation: an exposed memory can be ignored,
// and we have no signal saying "the model attended to this". The
// schema header (`migrations/054-memory-provenance.ts`) lays out
// the full semantic; this repo enforces the discipline at the
// query layer:
//
//   - Every list helper requires sessionId. Privacy + analytics
//     both want session-scoped queries as the default — a
//     cross-session aggregate would need a separate, explicitly
//     named function (mirror of `listRetrievalTracesByWorkflow`
//     regression fix in 55ba11a).
//   - Tiebreaker `id DESC` on every ORDER BY for deterministic
//     ordering under equal-ms timestamps.
//   - Provenance rows are append-only — no UPDATE / DELETE
//     surface beyond the GC sweep at the bottom.
//
// Cost discipline: schema header reasons about index coverage; this
// module respects it by never running a query that would force a
// table scan on a production-shaped DB (sessions with thousands of
// rows + retention windows of millions over time).

import { createHash } from 'node:crypto';
import type { MemoryScope } from '../../memory/index.ts';
import type { DB } from '../db.ts';

export type ProvenanceSurface = 'eager' | 'memory_read' | 'retrieve_context';

const VALID_SURFACES: ReadonlySet<ProvenanceSurface> = new Set([
  'eager',
  'memory_read',
  'retrieve_context',
]);

// Mirror of MemoryScope. The DB CHECK at the schema layer is the
// last line of defense; this guard catches caller bugs that
// bypassed TS (e.g., `as never` cast, JSON round-trip) with a
// clearer error than SQLiteError.
const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set(['user', 'project_shared', 'project_local']);

export interface MemoryProvenanceRow {
  id: string;
  sessionId: string;
  // NULL for eager-load exposures (which happen before any tool
  // call exists). Set for `memory_read` and `retrieve_context`.
  toolCallId: string | null;
  memoryScope: MemoryScope;
  memoryName: string;
  surface: ProvenanceSurface;
  // Non-null only for `retrieve_context`. Groups multiple
  // exposures from the same retrieval batch.
  retrievalQueryId: string | null;
  // Non-null only for `retrieve_context`. 0 = top hit of slot.
  positionInCorpus: number | null;
  // SHA-256 of frontmatter+body bytes at exposure time. NULL when
  // hashing failed (best-effort — never blocks the exposure
  // record).
  memoryContentHash: string | null;
  // Snapshot of `frontmatter.state` ('active' / 'quarantined' /
  // etc.) at exposure time. Memory may have transitioned since;
  // this column is the historical truth.
  memoryStateAtExposure: string | null;
  // Epoch ms.
  createdAt: number;
}

interface MemoryProvenanceDbRow {
  id: string;
  session_id: string;
  tool_call_id: string | null;
  memory_scope: MemoryScope;
  memory_name: string;
  surface: ProvenanceSurface;
  retrieval_query_id: string | null;
  position_in_corpus: number | null;
  memory_content_hash: string | null;
  memory_state_at_exposure: string | null;
  created_at: number;
}

const fromRow = (row: MemoryProvenanceDbRow): MemoryProvenanceRow => ({
  id: row.id,
  sessionId: row.session_id,
  toolCallId: row.tool_call_id,
  memoryScope: row.memory_scope,
  memoryName: row.memory_name,
  surface: row.surface,
  retrievalQueryId: row.retrieval_query_id,
  positionInCorpus: row.position_in_corpus,
  memoryContentHash: row.memory_content_hash,
  memoryStateAtExposure: row.memory_state_at_exposure,
  createdAt: row.created_at,
});

// Canonical hash function for the `memory_content_hash` column.
//
// Input contract: callers MUST pass the same canonical form used
// by every other emitter — `${frontmatter}\n\n${body}`, matching
// MemoryFile.body post-parse semantics. Two callers using
// different separators would produce mismatched hashes for
// equivalent content, defeating replay-fidelity.
//
// Output: lowercase SHA-256 hex (64 chars). SHA-256 is the
// documented canonical; the column type is just TEXT but the hex
// shape is the convention every reader assumes.
//
// Failure mode: node:crypto.createHash can throw in degraded
// hosts (FIPS misconfig, missing native). This helper does NOT
// catch — the caller (T1.3/T1.4/T1.5 instrumentation) is expected
// to wrap with try/catch and pass `memoryContentHash: null` on
// failure. The schema permits NULL precisely so a hash glitch
// never blocks the exposure record.
export const hashMemoryContent = (frontmatterAndBody: string): string =>
  createHash('sha256').update(frontmatterAndBody, 'utf-8').digest('hex');

export interface RecordProvenanceInput {
  // Optional; defaults to crypto.randomUUID(). Caller pins when
  // replaying / importing historical data.
  id?: string;
  sessionId: string;
  toolCallId: string | null;
  memoryScope: MemoryScope;
  memoryName: string;
  surface: ProvenanceSurface;
  retrievalQueryId?: string | null;
  positionInCorpus?: number | null;
  memoryContentHash?: string | null;
  memoryStateAtExposure?: string | null;
  // Optional epoch ms; defaults to Date.now().
  createdAt?: number;
}

const INSERT_SQL = `
  INSERT INTO memory_provenance (
    id, session_id, tool_call_id, memory_scope, memory_name, surface,
    retrieval_query_id, position_in_corpus, memory_content_hash,
    memory_state_at_exposure, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// Append a provenance row. Validates the surface enum + retrieval
// grouping invariants (retrieval_query_id and position_in_corpus
// MUST both be set, or both NULL — caller bug otherwise) so the
// CHECK at the DB layer never has to be the gate.
export const recordProvenance = (db: DB, input: RecordProvenanceInput): MemoryProvenanceRow => {
  if (!VALID_SURFACES.has(input.surface)) {
    throw new Error(`recordProvenance: invalid surface '${input.surface}'`);
  }
  if (!VALID_SCOPES.has(input.memoryScope)) {
    throw new Error(`recordProvenance: invalid memoryScope '${input.memoryScope}'`);
  }
  // toolCallId nullability is surface-dependent (schema header
  // commits to this contract). Eager rows are emitted before any
  // tool_call exists, so NULL is the only legal value. Per-call
  // surfaces MUST link to the originating tool_call — silently
  // accepting NULL there would orphan the provenance row from its
  // causal context (the very thing this table exists to record).
  if (input.surface === 'eager') {
    if (input.toolCallId !== null) {
      throw new Error('recordProvenance: surface=eager requires toolCallId=null');
    }
  } else if (input.toolCallId === null) {
    throw new Error(`recordProvenance: surface=${input.surface} requires a non-null toolCallId`);
  }
  const retrievalQueryId = input.retrievalQueryId ?? null;
  const positionInCorpus = input.positionInCorpus ?? null;
  // INSERT-time invariant: retrieval grouping fields go together.
  // Either both set (retrieve_context exposure) or both null (eager
  // / memory_read). A future caller that forgets one would silently
  // produce un-groupable rows.
  //
  // Note on post-cascade state: the FK `retrieval_query_id ON
  // DELETE SET NULL` (schema 054) may null this column AFTER a
  // retrieval_trace deletion. That bypasses this guard by design —
  // the row exists with surface='retrieve_context' and
  // retrievalQueryId=null. Downstream consumers handle the state
  // gracefully (see schema header for the full split). This guard
  // is INSERT-side only.
  if (input.surface === 'retrieve_context') {
    if (retrievalQueryId === null || positionInCorpus === null) {
      throw new Error(
        'recordProvenance: surface=retrieve_context requires both retrievalQueryId and positionInCorpus',
      );
    }
    // positionInCorpus is the index in `contextSlot.included`
    // (0 = top hit). Negative values are caller bugs — schema
    // accepts them (no CHECK), but forensic queries ("memory
    // ranked Nth") would produce garbage. Guard at the repo
    // layer so an off-by-one in the runner can't silently land.
    if (positionInCorpus < 0) {
      throw new Error(
        `recordProvenance: surface=retrieve_context requires positionInCorpus >= 0 (got ${positionInCorpus})`,
      );
    }
  } else {
    if (retrievalQueryId !== null || positionInCorpus !== null) {
      throw new Error(
        `recordProvenance: surface=${input.surface} must not set retrievalQueryId / positionInCorpus`,
      );
    }
  }

  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  // Epoch ms is non-negative by contract. A caller passing 0 or
  // negative is a bug (broken clock mock, miscomputed timestamp);
  // the row would still INSERT but break `created_at >= cutoff`
  // window queries downstream. Guard at the repo so the bug
  // surfaces at the call site, not in `countExposuresInWindow`
  // 60 days later.
  if (createdAt <= 0) {
    throw new Error(`recordProvenance: createdAt must be > 0 epoch ms (got ${createdAt})`);
  }
  db.query(INSERT_SQL).run(
    id,
    input.sessionId,
    input.toolCallId,
    input.memoryScope,
    input.memoryName,
    input.surface,
    retrievalQueryId,
    positionInCorpus,
    input.memoryContentHash ?? null,
    input.memoryStateAtExposure ?? null,
    createdAt,
  );
  return {
    id,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    memoryScope: input.memoryScope,
    memoryName: input.memoryName,
    surface: input.surface,
    retrievalQueryId,
    positionInCorpus,
    memoryContentHash: input.memoryContentHash ?? null,
    memoryStateAtExposure: input.memoryStateAtExposure ?? null,
    createdAt,
  };
};

const SELECT_ALL = `
  SELECT id, session_id, tool_call_id, memory_scope, memory_name, surface,
         retrieval_query_id, position_in_corpus, memory_content_hash,
         memory_state_at_exposure, created_at
    FROM memory_provenance
`;

// Exposures during a specific tool call. Session-scoped at the
// caller level (the tool_call belongs to a session; we still
// require sessionId so a leaked tool_call_id can't surface
// cross-session exposures). Ordered DESC by created_at +
// id-tiebreaker for stable display.
export const listProvenanceForToolCall = (
  db: DB,
  sessionId: string,
  toolCallId: string,
): MemoryProvenanceRow[] => {
  const rows = db
    .query<MemoryProvenanceDbRow, [string, string]>(
      `${SELECT_ALL}
        WHERE session_id = ? AND tool_call_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId, toolCallId);
  return rows.map(fromRow);
};

// Exposure history of a memory within a session. Most-recent
// first, capped by `limit` (default 50 matches `/memory audit`'s
// default page size). When the operator wants more, they pass
// an explicit limit.
export const listProvenanceForMemory = (
  db: DB,
  sessionId: string,
  scope: MemoryScope,
  name: string,
  limit = 50,
): MemoryProvenanceRow[] => {
  const rows = db
    .query<MemoryProvenanceDbRow, [string, MemoryScope, string, number]>(
      `${SELECT_ALL}
        WHERE session_id = ? AND memory_scope = ? AND memory_name = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(sessionId, scope, name, limit);
  return rows.map(fromRow);
};

// Like `listProvenanceForMemory` but resolves across every scope
// for a given name. Operator surfaces (`/memory provenance <name>`)
// don't always know the scope — the memory may have been deleted,
// or live in a scope the operator can't easily query. By-name
// lookup matches the `/memory audit --name` shape and outlives
// deletion of the memory file itself.
export const listProvenanceByName = (
  db: DB,
  sessionId: string,
  name: string,
  limit = 50,
): MemoryProvenanceRow[] => {
  const rows = db
    .query<MemoryProvenanceDbRow, [string, string, number]>(
      `${SELECT_ALL}
        WHERE session_id = ? AND memory_name = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(sessionId, name, limit);
  return rows.map(fromRow);
};

// Every memory exposed by a single retrieve_context call. Ordered
// by `position_in_corpus ASC` so the rendering reflects the slot's
// ranking (0 first, etc.). `retrieval_query_id` is enough — we
// don't need sessionId for this query because retrieval_query_id
// is a UUID that's effectively unguessable, but we still take it
// for the symmetric API shape (also helps slash commands surface
// it under the right session context).
export const listExposuresInRetrieval = (
  db: DB,
  sessionId: string,
  retrievalQueryId: string,
): MemoryProvenanceRow[] => {
  const rows = db
    .query<MemoryProvenanceDbRow, [string, string]>(
      `${SELECT_ALL}
        WHERE session_id = ? AND retrieval_query_id = ?
        ORDER BY position_in_corpus ASC, id DESC`,
    )
    .all(sessionId, retrievalQueryId);
  return rows.map(fromRow);
};

// Count exposures of a memory within a sliding window (ms). Used
// by Slice 3's `user_override_repeated` detector to aggregate
// "memory X was visible during N tool calls in the last 24h" —
// not the same as "the model attended to it N times", but the
// best proxy without a model-side attention signal.
//
// Eager rows count too: an eager-loaded memory was visible for
// every tool call in the session, so each eager row contributes
// once per session (the dedupe means the eager surface emits one
// row per session×memory). Per-call surfaces contribute per call.
export const countExposuresInWindow = (
  db: DB,
  sessionId: string,
  scope: MemoryScope,
  name: string,
  windowMs: number,
  nowMs: number,
): number => {
  const cutoffMs = nowMs - windowMs;
  const row = db
    .query<{ n: number }, [string, MemoryScope, string, number]>(
      `SELECT COUNT(*) AS n
         FROM memory_provenance
        WHERE session_id = ? AND memory_scope = ? AND memory_name = ?
          AND created_at >= ?`,
    )
    .get(sessionId, scope, name, cutoffMs) as { n: number };
  return row.n;
};

// Cross-session, cross-scope aggregate by memory name. EXPLICITLY
// named (mirrors `listGlobalProvenanceForMemory`) so a caller
// writing session-scoped queries can't accidentally reach for it.
// Used by `/memory provenance <name> --all` for forensic "every
// time this memory was exposed, anywhere".
export const listGlobalProvenanceByName = (
  db: DB,
  name: string,
  limit = 50,
): MemoryProvenanceRow[] => {
  const rows = db
    .query<MemoryProvenanceDbRow, [string, number]>(
      `${SELECT_ALL}
        WHERE memory_name = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(name, limit);
  return rows.map(fromRow);
};

// Cross-session aggregate. EXPLICITLY named so a caller writing
// session-scoped queries can't accidentally reach for it. Used by
// /memory audit / `/memory provenance` operator surfaces and by
// future analytics — the session_id is dropped on purpose.
export const listGlobalProvenanceForMemory = (
  db: DB,
  scope: MemoryScope,
  name: string,
  limit = 50,
): MemoryProvenanceRow[] => {
  const rows = db
    .query<MemoryProvenanceDbRow, [MemoryScope, string, number]>(
      `${SELECT_ALL}
        WHERE memory_scope = ? AND memory_name = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(scope, name, limit);
  return rows.map(fromRow);
};

// Idempotency probe for the harness loop's eager emit. Returns
// true when ANY eager provenance row already exists for this
// session — used to distinguish "first boot of session" (emit)
// from "resume of existing session" (skip, rows already landed)
// AND to keep subagent first boots working (preassignedSessionId
// is set but no eager rows exist yet).
//
// Single indexed lookup against the session-led composite index;
// the LIMIT 1 stops at the first match.
export const hasEagerProvenance = (db: DB, sessionId: string): boolean => {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT 1 AS n
         FROM memory_provenance
        WHERE session_id = ? AND surface = 'eager'
        LIMIT 1`,
    )
    .get(sessionId);
  return row !== null;
};

// Retention window for the boot-time GC sweep (S1/T1.7). 90 days
// mirrors `eviction_events` retention. Exposure rows are a
// forensic substrate: useful for "what was visible when X
// happened" queries, but value decays fast — a 6-month-old
// exposure row is dead weight at provenance-query latency and
// disk-cost (millions of rows accumulate across long-lived
// installs). The TTL is conservative for now; future tuning may
// expose it as an operator policy if real install data shows
// 90d is too short.
export const MEMORY_PROVENANCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// Boot-time GC: drop rows older than `olderThanMs`. Returns the
// row count for telemetry. Cutoff is EXCLUSIVE — a row at exactly
// `olderThanMs` is KEPT, so callers can treat the cutoff as the
// inclusive lower-bound of the retention window.
export const pruneMemoryProvenance = (db: DB, olderThanMs: number): number => {
  const result = db.query('DELETE FROM memory_provenance WHERE created_at < ?').run(olderThanMs);
  return Number(result.changes);
};
