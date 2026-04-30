import type { DB } from '../db.ts';

export type SessionStatus = 'running' | 'done' | 'interrupted' | 'exhausted' | 'error';

export interface Session {
  id: string;
  startedAt: number;
  endedAt: number | null;
  model: string;
  cwd: string;
  status: SessionStatus;
  totalCostUsd: number;
  // Same semantics as HarnessResult.usageComplete: true iff every
  // billable provider call this session reported usage. False means
  // `totalCostUsd` is a lower bound and audit queries should mark it
  // as such.
  usageComplete: boolean;
  // Set when the session was spawned as a subagent (spec §11). Null
  // for top-level user runs. ON DELETE SET NULL: losing the parent
  // row must not cascade-delete the child's audit trail.
  parentSessionId: string | null;
}

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  model: string;
  cwd: string;
  status: SessionStatus;
  total_cost_usd: number;
  usage_complete: number;
  parent_session_id: string | null;
}

const fromRow = (row: SessionRow): Session => ({
  id: row.id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  model: row.model,
  cwd: row.cwd,
  status: row.status,
  totalCostUsd: row.total_cost_usd,
  usageComplete: row.usage_complete === 1,
  parentSessionId: row.parent_session_id,
});

export interface CreateSessionInput {
  id?: string;
  model: string;
  cwd: string;
  startedAt?: number;
  parentSessionId?: string;
}

export const createSession = (db: DB, input: CreateSessionInput): Session => {
  const id = input.id ?? crypto.randomUUID();
  const startedAt = input.startedAt ?? Date.now();
  const parentSessionId = input.parentSessionId ?? null;
  // usage_complete defaults to 1 in the schema and starts true here for
  // the same reason: a freshly-created session has no measured turns
  // yet; the harness flips it to 0 via completeSession when finalizing
  // an incomplete run.
  //
  // `seq` is computed atomically via subquery (migration 008) so two
  // sessions started in the same ms tick still have a deterministic
  // order on listSessions — which is what `--resume last` depends
  // on. Same shape as messages.seq (migration 007).
  db.query(
    `INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd, seq, parent_session_id)
     VALUES (?, ?, ?, ?, 'running', 0, (SELECT COALESCE(MAX(seq), -1) + 1 FROM sessions), ?)`,
  ).run(id, startedAt, input.model, input.cwd, parentSessionId);
  return {
    id,
    startedAt,
    endedAt: null,
    model: input.model,
    cwd: input.cwd,
    status: 'running',
    totalCostUsd: 0,
    usageComplete: true,
    parentSessionId,
  };
};

export const getSession = (db: DB, id: string): Session | null => {
  const row = db
    .query(
      `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | null;
  return row !== null ? fromRow(row) : null;
};

export interface ListSessionsOptions {
  limit?: number;
  cwd?: string;
  status?: SessionStatus;
  // Default: only top-level sessions (parent_session_id IS NULL).
  // Set true to include children — useful for audit/debug listings.
  // The list-sessions CLI exposes this as `--include-subagents`.
  includeSubagents?: boolean;
}

export const listSessions = (db: DB, options: ListSessionsOptions = {}): Session[] => {
  const limit = options.limit ?? 20;
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (options.cwd !== undefined) {
    filters.push('cwd = ?');
    params.push(options.cwd);
  }
  if (options.status !== undefined) {
    filters.push('status = ?');
    params.push(options.status);
  }
  if (options.includeSubagents !== true) {
    filters.push('parent_session_id IS NULL');
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(limit);
  // Secondary order by seq DESC (migration 008) is the deterministic
  // tiebreaker when two sessions started in the same millisecond
  // tick. Without it, `listSessions(..., {limit:1})[0]` could
  // return either of the tied rows depending on SQLite's
  // implementation-defined fallback — and `--resume last` then
  // attaches to the wrong conversation. seq is monotonically
  // increasing per insert, so DESC gives newest-first.
  const sql = `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id
               FROM sessions
               ${where}
               ORDER BY started_at DESC, seq DESC
               LIMIT ?`;
  const rows = db.query(sql).all(...params) as SessionRow[];
  return rows.map(fromRow);
};

// Children of a parent session, oldest-first so renderers can show
// the natural call order (a parent with two task() invocations sees
// child[0] before child[1]). Used by --list-sessions hierarchy and
// by cost rollup queries.
export const listChildSessions = (db: DB, parentSessionId: string): Session[] => {
  const rows = db
    .query(
      `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id
       FROM sessions
       WHERE parent_session_id = ?
       ORDER BY started_at ASC, seq ASC`,
    )
    .all(parentSessionId) as SessionRow[];
  return rows.map(fromRow);
};

export const completeSession = (
  db: DB,
  id: string,
  status: Exclude<SessionStatus, 'running'>,
  totalCostUsd: number,
  usageComplete: boolean,
  endedAt: number = Date.now(),
): void => {
  const result = db
    .query(
      `UPDATE sessions
       SET status = ?, ended_at = ?, total_cost_usd = ?, usage_complete = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(status, endedAt, totalCostUsd, usageComplete ? 1 : 0, id);
  if (result.changes === 0) {
    const exists = getSession(db, id);
    if (exists === null) throw new Error(`session ${id} not found`);
    throw new Error(`session ${id} not in 'running' state (was '${exists.status}')`);
  }
};

export const updateSessionCost = (db: DB, id: string, totalCostUsd: number): void => {
  const result = db
    .query('UPDATE sessions SET total_cost_usd = ? WHERE id = ?')
    .run(totalCostUsd, id);
  if (result.changes === 0) {
    throw new Error(`session ${id} not found`);
  }
};

// Flip a previously-finalized session back to 'running' so a resume
// continuation can reuse the same id. Idempotent — calling on an
// already-running session is a no-op. Without this, completeSession
// at the end of the resumed run would fail its WHERE status='running'
// guard and throw.
export const reopenSession = (db: DB, id: string): void => {
  const result = db
    .query("UPDATE sessions SET status = 'running', ended_at = NULL WHERE id = ?")
    .run(id);
  if (result.changes === 0) {
    throw new Error(`session ${id} not found`);
  }
};
