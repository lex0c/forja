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
});

export interface CreateSessionInput {
  id?: string;
  model: string;
  cwd: string;
  startedAt?: number;
}

export const createSession = (db: DB, input: CreateSessionInput): Session => {
  const id = input.id ?? crypto.randomUUID();
  const startedAt = input.startedAt ?? Date.now();
  // usage_complete defaults to 1 in the schema and starts true here for
  // the same reason: a freshly-created session has no measured turns
  // yet; the harness flips it to 0 via completeSession when finalizing
  // an incomplete run.
  db.query(
    `INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd)
     VALUES (?, ?, ?, ?, 'running', 0)`,
  ).run(id, startedAt, input.model, input.cwd);
  return {
    id,
    startedAt,
    endedAt: null,
    model: input.model,
    cwd: input.cwd,
    status: 'running',
    totalCostUsd: 0,
    usageComplete: true,
  };
};

export const getSession = (db: DB, id: string): Session | null => {
  const row = db
    .query(
      `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | null;
  return row !== null ? fromRow(row) : null;
};

export interface ListSessionsOptions {
  limit?: number;
  cwd?: string;
  status?: SessionStatus;
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
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  params.push(limit);
  const sql = `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete
               FROM sessions
               ${where}
               ORDER BY started_at DESC
               LIMIT ?`;
  const rows = db.query(sql).all(...params) as SessionRow[];
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
