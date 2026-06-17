// retrieval_trace repo (RETRIEVAL.md §10.1).
//
// One row per `runRetrieval` call. The pipeline writes ONE INSERT
// at the end (not per-stage updates) — partial writes would let an
// observer read a half-completed trace and draw wrong conclusions.
// When a stage throws, the caller decides whether to persist a
// partial row (filling in nulls for the stages that didn't run);
// the spec-correct default is "no partial trace, an error surfaces
// via the exception".
//
// Scrub policy at the repo layer (asymmetric by field, by design):
//
//   SCRUBBED (paths / hosts / IPs / SSH refs redacted at INSERT):
//     - query_text
//     - candidate `reason` strings across all three stages
//       (raw / expanded / ranked) and the `reason` in skipped slot
//       entries — these are operator/view free-form text and can
//       leak a path the operator typed or a filename a view picked
//       up. Same pattern outcomes.evidence_json applies for the
//       same reason.
//
//   LEFT RAW (substrate; scrubbing would defeat the pipeline):
//     - ContextSlotEntry.content — the body the retrieval is
//       meant to surface. The model needs the real content to
//       reason; an eval replay needs the real content to re-rank.
//       Secret redaction at the prompt boundary
//       (`telemetry/scrubbing` in the model I/O path) handles
//       what doesn't leave the machine; the trace stores the
//       substrate as-is.
//
// Trace rows live as long as their session (FK CASCADE). Per-trace
// retention beyond that is operator policy — we don't auto-prune.

import type {
  Candidate,
  ContextSlot,
  ExpandedCandidate,
  PipelineTimings,
  RankedCandidate,
  RetrievalQueryType,
  RetrievalTraceRow,
  RetrievalWorkflow,
} from '../../retrieval/types.ts';
import { scrubFreeformText } from '../../telemetry/scrubbing.ts';
import type { DB } from '../db.ts';

export interface CreateRetrievalTraceInput {
  // Optional; defaults to crypto.randomUUID(). Caller pins when
  // replaying / importing.
  id?: string;
  sessionId: string;
  queryText: string;
  workflow: RetrievalWorkflow;
  queryType: RetrievalQueryType;
  budgetTokens: number;
  candidatesRaw: Candidate[];
  candidatesExpanded: ExpandedCandidate[];
  candidatesRanked: RankedCandidate[];
  contextSlot: ContextSlot;
  timings: PipelineTimings;
  // Optional epoch ms; defaults to Date.now().
  createdAt?: number;
}

interface RetrievalTraceDbRow {
  id: string;
  session_id: string;
  query_text: string;
  workflow: RetrievalWorkflow;
  query_type: RetrievalQueryType;
  budget_tokens: number;
  candidates_raw_json: string | null;
  candidates_expanded_json: string | null;
  candidates_ranked_json: string | null;
  context_slot_json: string | null;
  timings_json: string | null;
  created_at: number;
}

const fromRow = (row: RetrievalTraceDbRow): RetrievalTraceRow => {
  const parse = <T>(json: string | null, fallback: T, columnName: string): T => {
    if (json === null) return fallback;
    try {
      return JSON.parse(json) as T;
    } catch (err) {
      // The repo writes JSON we control; a corrupted row implies
      // direct DB mutation, mid-write process kill, or
      // mid-migration tampering — never a code path on our own
      // write side. Fall back to a structurally-valid empty so the
      // read still completes, but surface the corruption on stderr
      // so the operator can notice and audit. Mirrors the same
      // best-effort posture as the trace persist failure path
      // (pipeline.ts).
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `forja retrieval_trace: row ${row.id} ${columnName} JSON parse failed (${msg}); returning empty fallback\n`,
      );
      return fallback;
    }
  };
  return {
    id: row.id,
    sessionId: row.session_id,
    queryText: row.query_text,
    workflow: row.workflow,
    queryType: row.query_type,
    budgetTokens: row.budget_tokens,
    candidatesRaw: parse<Candidate[]>(row.candidates_raw_json, [], 'candidates_raw_json'),
    candidatesExpanded: parse<ExpandedCandidate[]>(
      row.candidates_expanded_json,
      [],
      'candidates_expanded_json',
    ),
    candidatesRanked: parse<RankedCandidate[]>(
      row.candidates_ranked_json,
      [],
      'candidates_ranked_json',
    ),
    contextSlot: parse<ContextSlot>(
      row.context_slot_json,
      { included: [], skipped: [] },
      'context_slot_json',
    ),
    timings: parse<PipelineTimings>(
      row.timings_json,
      {
        searchMs: 0,
        expandMs: 0,
        rankMs: 0,
        compressMs: 0,
      },
      'timings_json',
    ),
    createdAt: row.created_at,
  };
};

// Selective scrub. Operator/view-emitted free-form strings (the
// `reason` carried through every candidate stage and the `reason`
// in skipped entries) can leak paths the operator typed into a
// query or filenames the view picked up. We scrub those.
//
// `ContextSlotEntry.content` is the OPPOSITE policy — it carries
// the substrate the retrieval is meant to surface (file body,
// memory body). Scrubbing here would defeat the pipeline's purpose
// (the compressed payload would lose its meaning). The scrub
// layer at the prompt boundary (telemetry/scrubbing in the model
// I/O path) handles secret redaction before tokens leave the
// machine; the trace stores the substrate as-is so eval replay
// can re-rank against the real content.
const scrubReason = (reason: string): string => scrubFreeformText(reason);

const scrubCandidates = (cands: readonly Candidate[]): Candidate[] =>
  cands.map((c) => ({ ...c, reason: scrubReason(c.reason) }));

const scrubExpanded = (cands: readonly ExpandedCandidate[]): ExpandedCandidate[] =>
  cands.map((c) => ({ ...c, reason: scrubReason(c.reason) }));

const scrubRanked = (cands: readonly RankedCandidate[]): RankedCandidate[] =>
  cands.map((c) => ({ ...c, reason: scrubReason(c.reason) }));

const scrubContextSlot = (slot: ContextSlot): ContextSlot => ({
  included: slot.included.map((e) => ({ ...e })), // content kept raw (see header)
  skipped: slot.skipped.map((s) => ({ ...s, reason: scrubReason(s.reason) })),
});

const INSERT_SQL = `
  INSERT INTO retrieval_trace (
    id, session_id, query_text, workflow, query_type, budget_tokens,
    candidates_raw_json, candidates_expanded_json, candidates_ranked_json,
    context_slot_json, timings_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const createRetrievalTrace = (
  db: DB,
  input: CreateRetrievalTraceInput,
): RetrievalTraceRow => {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  // Scrub query text + all view-emitted reason strings. See
  // scrubReason header for the policy on what's scrubbed vs left
  // raw.
  const queryText = scrubFreeformText(input.queryText);
  const candidatesRaw = scrubCandidates(input.candidatesRaw);
  const candidatesExpanded = scrubExpanded(input.candidatesExpanded);
  const candidatesRanked = scrubRanked(input.candidatesRanked);
  const contextSlot = scrubContextSlot(input.contextSlot);
  db.query(INSERT_SQL).run(
    id,
    input.sessionId,
    queryText,
    input.workflow,
    input.queryType,
    input.budgetTokens,
    JSON.stringify(candidatesRaw),
    JSON.stringify(candidatesExpanded),
    JSON.stringify(candidatesRanked),
    JSON.stringify(contextSlot),
    JSON.stringify(input.timings),
    createdAt,
  );
  return {
    id,
    sessionId: input.sessionId,
    queryText,
    workflow: input.workflow,
    queryType: input.queryType,
    budgetTokens: input.budgetTokens,
    candidatesRaw,
    candidatesExpanded,
    candidatesRanked,
    contextSlot,
    timings: input.timings,
    createdAt,
  };
};

const SELECT_ALL = `
  SELECT id, session_id, query_text, workflow, query_type, budget_tokens,
         candidates_raw_json, candidates_expanded_json, candidates_ranked_json,
         context_slot_json, timings_json, created_at
    FROM retrieval_trace
`;

export const getRetrievalTrace = (db: DB, id: string): RetrievalTraceRow | null => {
  const row = db.query(`${SELECT_ALL} WHERE id = ?`).get(id) as RetrievalTraceDbRow | null;
  return row !== null ? fromRow(row) : null;
};

// Latest N traces in a session, newest first. Backed by
// idx_retrieval_trace_session_created. Default limit 20 mirrors
// /memory audit + /agent policy list pagination defaults.
//
// Secondary sort by `id DESC` guards against equal-ms timestamps
// (concurrent inserts under eval harness load, or two traces
// landing in the same millisecond). Without the tiebreaker the
// pagination / short-id resolution flakes between calls. Matches
// the pattern in `failure-events.ts:93`.
export const listRetrievalTracesBySession = (
  db: DB,
  sessionId: string,
  limit = 20,
): RetrievalTraceRow[] => {
  const rows = db
    .query<RetrievalTraceDbRow, [string, number]>(
      `${SELECT_ALL}
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(sessionId, limit);
  return rows.map(fromRow);
};

// Traces for a session whose created_at falls in [cutoffMs, ∞),
// newest first. Used by `/agent retrieval metrics` to compute
// aggregates honestly over the full requested window — the older
// `listRetrievalTracesBySession(... limit=100)` + in-memory date
// filter silently sampled the freshest 100 rows, biasing metrics
// for any session whose window has >100 traces.
//
// A hard SQL cap still applies as defense against pathological
// sessions (think eval harness logging 50k retrieval calls). The
// caller learns whether the cap clipped the result via the
// returned `capReached` flag and can render an explicit warning
// instead of silently truncating.
export interface RetrievalTracesSinceResult {
  rows: RetrievalTraceRow[];
  // True when SQL returned exactly `hardCap` rows AND there is at
  // least one older trace in the window the caller asked for.
  // The cap was therefore the binding constraint, not the window.
  capReached: boolean;
  hardCap: number;
}

export const listRetrievalTracesSinceMs = (
  db: DB,
  sessionId: string,
  cutoffMs: number,
  hardCap = 10_000,
): RetrievalTracesSinceResult => {
  // Fetch hardCap + 1 so we can tell "exactly hardCap rows in the
  // window" (capReached=false) from "hardCap rows AND more behind
  // them" (capReached=true). One extra row at the SQL layer is
  // cheaper than a separate COUNT query.
  // Secondary sort by `id DESC` mirrors `listRetrievalTracesBySession`
  // — deterministic order under equal-ms timestamps so eval replays
  // and metric aggregates over the window are stable across calls.
  const rows = db
    .query<RetrievalTraceDbRow, [string, number, number]>(
      `${SELECT_ALL}
        WHERE session_id = ? AND created_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(sessionId, cutoffMs, hardCap + 1);
  const capReached = rows.length > hardCap;
  const kept = capReached ? rows.slice(0, hardCap) : rows;
  return { rows: kept.map(fromRow), capReached, hardCap };
};

// Latest N traces for a specific workflow within a single session,
// newest first. Useful for per-workflow drilldowns from a session's
// `/agent retrieval audit`. `sessionId` is required — the previous
// signature filtered only by `workflow = ?` and spanned every
// session in the DB, which leaks cross-session traces to any
// caller that assumed session-scope (operator inspecting "debug
// workflow traces" would see traces from other operators' sessions
// on the same DB). A cross-session aggregation surface would need
// a different function with explicit acknowledgement that the
// caller wants every session.
//
// Backed by idx_retrieval_trace_session_created + workflow filter
// at SQL level. Secondary sort `id DESC` for the same deterministic
// ordering as the other list helpers.
export const listRetrievalTracesByWorkflow = (
  db: DB,
  sessionId: string,
  workflow: RetrievalWorkflow,
  limit = 50,
): RetrievalTraceRow[] => {
  const rows = db
    .query<RetrievalTraceDbRow, [string, RetrievalWorkflow, number]>(
      `${SELECT_ALL}
        WHERE session_id = ? AND workflow = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(sessionId, workflow, limit);
  return rows.map(fromRow);
};

export const countRetrievalTraces = (db: DB): number => {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM retrieval_trace').get() as {
    n: number;
  };
  return row.n;
};

// ─── pruneRetrievalTrace ───────────────────────────────────────────────
//
// Retention sweep for `forja gc` (AGENTIC_CLI §2.1.3, AUDIT §1.2,
// RETRIEVAL §10.1). Default retention 90d on `created_at`. Cutoff
// EXCLUSIVE — a row at exactly `olderThanMs` is KEPT (matches
// pruneVerifyAttempts and the other prune helpers).
//
// Standalone sweep is the cold-path backstop: FK CASCADE with
// `sessions` already drops traces when the parent session is
// purged, so most traces leave via cascade. This sweep covers the
// case where the session survives but the traces should be aged
// out (e.g., long-lived workflow sessions accumulating traces
// across many queries).
export const pruneRetrievalTrace = (db: DB, olderThanMs: number): number => {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error(
      `pruneRetrievalTrace: olderThanMs must be a positive finite number (got ${olderThanMs})`,
    );
  }
  const result = db.query('DELETE FROM retrieval_trace WHERE created_at < ?').run(olderThanMs);
  return Number(result.changes);
};
