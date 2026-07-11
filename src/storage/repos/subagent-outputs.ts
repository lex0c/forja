import type { DB } from '../db.ts';

// Repo for `subagent_outputs` (migration 014). The IPC table
// the subprocess flow writes into.
//
// Two write paths matter:
//   1. `insertSubagentOutput` — child subprocess creates its
//      row at startup, before any heartbeat. payload is null
//      until the run finishes; last_heartbeat is null until the
//      first beat lands.
//   2. `updateSubagentHeartbeat` / `setSubagentPayload` — the
//      child publishes liveness and the final result; both
//      bump `updated_at`. The split is deliberate: a heartbeat
//      pulse must not require the child to know its terminal
//      payload yet, and writing the terminal payload must not
//      require an additional heartbeat hop.
//
// Read paths:
//   - `getSubagentOutput(sessionId)` — single-row lookup, used by
//     the parent's poller and by audit consumers.
//   - `listStaleSubagentOutputs(beforeTs)` — surfaces every row
//     whose last_heartbeat is older than `beforeTs`; the
//     parent's timeout enforcer (FAILURE_MODES §7.3) feeds its
//     wall-clock cutoff in. Excludes rows where last_heartbeat
//     IS NULL (those are pre-spawn or spawn-failed; not the
//     timeout subsystem's job).

export interface SubagentOutput {
  sessionId: string;
  // The child's terminal envelope (status, reason, cost, output
  // text, etc). Null while the child is still running — the
  // parent's poller treats null as "no terminal yet". Caller
  // shape is opaque at the repo layer; subagent runtime defines
  // and parses it.
  payload: Record<string, unknown> | null;
  // Epoch ms of the child's last heartbeat write. Null until the
  // first beat lands. Stays bumped on every heartbeat AND on
  // every payload write (a payload write IS a liveness signal).
  lastHeartbeat: number | null;
  createdAt: number;
  updatedAt: number;
}

interface SubagentOutputRow {
  session_id: string;
  payload: string | null;
  last_heartbeat: number | null;
  created_at: number;
  updated_at: number;
}

// Defensive payload parse. Storage corruption is unlikely (TEXT
// is opaque to SQLite, and only our own code writes it), but a
// malformed JSON should NOT crash audit listings — return null
// and let the consumer detect via `payload === null` paired with
// non-null timestamps. Mirrors the same pattern in
// `subagent-runs.ts:46-52` for `tools_whitelist`.
const parsePayload = (raw: string | null): Record<string, unknown> | null => {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const fromRow = (row: SubagentOutputRow): SubagentOutput => ({
  sessionId: row.session_id,
  payload: parsePayload(row.payload),
  lastHeartbeat: row.last_heartbeat,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface InsertSubagentOutputInput {
  sessionId: string;
  // Optional initial payload. The subprocess flow inserts
  // with null payload (the row precedes any output the child
  // publishes); leaving it optional here lets tests stage a
  // pre-populated row without a follow-up update.
  payload?: Record<string, unknown> | null;
  // Optional initial heartbeat. Production callers leave this
  // null (the first heartbeat lands via updateSubagentHeartbeat).
  // All ts fields here are `Date.now()`-shaped epoch ms; values
  // like 0 or other sentinels are accepted by the schema but
  // semantically meaningless and would surface as "ancient" rows
  // in `listStaleSubagentOutputs`. Tests that need deterministic
  // timestamps should pass plausible epoch values (e.g., 1, 100,
  // 200) — small numbers stay below `Date.now()` so MAX-guarded
  // updates have somewhere to advance to.
  lastHeartbeat?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

// Insert a fresh row. The PK is session_id, so calling this
// twice for the same session throws — that's the contract: only
// the child subprocess inserts, exactly once at startup. Tests
// that need a pre-existing row should call this directly.
export const insertSubagentOutput = (db: DB, input: InsertSubagentOutputInput): SubagentOutput => {
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? createdAt;
  const lastHeartbeat = input.lastHeartbeat ?? null;
  const payload = input.payload ?? null;
  const payloadJson = payload === null ? null : JSON.stringify(payload);
  db.query(
    `INSERT INTO subagent_outputs
       (session_id, payload, last_heartbeat, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.sessionId, payloadJson, lastHeartbeat, createdAt, updatedAt);
  return {
    sessionId: input.sessionId,
    payload,
    lastHeartbeat,
    createdAt,
    updatedAt,
  };
};

// Bump the heartbeat. Also bumps updated_at — every liveness
// signal is itself a write, and the parent's stale-row detection
// uses updated_at as a secondary signal when last_heartbeat is
// suspiciously old (e.g., the child wrote a payload but didn't
// touch the heartbeat for a few cycles before exit).
//
// Throws when no row exists for `sessionId`. The subprocess flow
// always inserts before the first heartbeat, so a missing row
// indicates a programmer / sequencing bug rather than a runtime
// state.
//
// Both columns advance MONOTONICALLY via `MAX(col, ?)` so an
// out-of-order write (NTP step backward on the child host, VM
// migration between hosts with skewed clocks, container reinit)
// can never regress `last_heartbeat`. Without this guard, a
// retroactive pulse would make the parent's poller see a
// healthy child as stale and SIGTERM it. `IFNULL(..., 0)` covers
// the first heartbeat case where the column starts NULL — the
// MAX of 0 and any positive ts is the ts itself.
export const updateSubagentHeartbeat = (
  db: DB,
  sessionId: string,
  ts: number = Date.now(),
): void => {
  const result = db
    .query(
      `UPDATE subagent_outputs
          SET last_heartbeat = MAX(IFNULL(last_heartbeat, 0), ?),
              updated_at     = MAX(updated_at, ?)
        WHERE session_id = ?`,
    )
    .run(ts, ts, sessionId);
  if (result.changes === 0) {
    throw new Error(
      `updateSubagentHeartbeat: no subagent_outputs row for session ${sessionId} (insert before heartbeat)`,
    );
  }
};

// Publish the terminal payload. The child calls this on its
// last write before exit. Bumps last_heartbeat too (a payload
// write IS a liveness signal — there's no scenario where the
// child publishes its result and then the parent should still
// believe it's hung). Throws on missing row, same contract as
// updateSubagentHeartbeat.
//
// `payload` is overwritten unconditionally (a re-publish from a
// retried final-write is legal and the latest envelope wins);
// `last_heartbeat` and `updated_at` advance via MAX so an
// out-of-order ts can't regress them. See the heartbeat helper
// above for the clock-skew rationale.
export const setSubagentPayload = (
  db: DB,
  sessionId: string,
  payload: Record<string, unknown>,
  ts: number = Date.now(),
): void => {
  const result = db
    .query(
      `UPDATE subagent_outputs
          SET payload        = ?,
              last_heartbeat = MAX(IFNULL(last_heartbeat, 0), ?),
              updated_at     = MAX(updated_at, ?)
        WHERE session_id = ?`,
    )
    .run(JSON.stringify(payload), ts, ts, sessionId);
  if (result.changes === 0) {
    throw new Error(
      `setSubagentPayload: no subagent_outputs row for session ${sessionId} (insert before payload)`,
    );
  }
};

// Returns null when no row exists. Two distinct cases produce
// null and the caller must treat them differently:
//   (a) the session was never a subprocess subagent (no row was
//       ever inserted) — the audit consumer should NOT interpret
//       this as a timeout;
//   (b) the session IS a subprocess subagent but the FK CASCADE
//       dropped the row when the session was purged — the row's
//       absence is structural, not a runtime state.
// Disambiguation: pair with `sessions.is_subagent` and the run's
// definition `isolation` field.
export const getSubagentOutput = (db: DB, sessionId: string): SubagentOutput | null => {
  const row = db
    .query<SubagentOutputRow, [string]>(
      `SELECT session_id, payload, last_heartbeat, created_at, updated_at
         FROM subagent_outputs
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row !== null ? fromRow(row) : null;
};

// Surface every row whose last_heartbeat is older than `beforeTs`,
// ordered by oldest first. The parent's timeout enforcer feeds
// its wall-clock cutoff (typically `Date.now() - childWallBudget`)
// and acts on the result list. Rows where last_heartbeat IS NULL
// are excluded — those represent pre-spawn or spawn-failed
// children that the timeout subsystem doesn't own.
export const listStaleSubagentOutputs = (db: DB, beforeTs: number): SubagentOutput[] => {
  const rows = db
    .query<SubagentOutputRow, [number]>(
      `SELECT session_id, payload, last_heartbeat, created_at, updated_at
         FROM subagent_outputs
        WHERE last_heartbeat IS NOT NULL AND last_heartbeat < ?
        ORDER BY last_heartbeat ASC`,
    )
    .all(beforeTs);
  return rows.map(fromRow);
};
