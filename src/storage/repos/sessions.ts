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
  // The LIVE FK link to the parent session (null when no parent or
  // when the parent has been purged — ON DELETE SET NULL). Use this
  // for tree traversal of currently-related rows; for the answer to
  // "was this session ORIGINALLY a subagent" use `isSubagent` below.
  parentSessionId: string | null;
  // The IDENTITY flag: true iff this row was created as a subagent
  // child. Set once at create time and never modified, so a parent
  // purge that nulls `parentSessionId` does NOT promote the orphan
  // back to "top-level user session". This is the predicate the
  // default listSessions filter (and `--resume last`) uses.
  isSubagent: boolean;
  // Discriminator for sessions that ended via abort. Mirrors
  // HarnessResult.abortCause: 'soft' = cooperative (let in-flight
  // work finish); 'hard' = preemptive (kill mid-tool). Null for any
  // other terminal status — the value is meaningless when the
  // session didn't exit through the abort path. Audit queries use
  // this to distinguish "operator nudged" from "operator escalated".
  abortCause: 'soft' | 'hard' | null;
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
  is_subagent: number;
  abort_cause: 'soft' | 'hard' | null;
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
  isSubagent: row.is_subagent === 1,
  abortCause: row.abort_cause,
});

export interface CreateSessionInput {
  id?: string;
  model: string;
  cwd: string;
  startedAt?: number;
  parentSessionId?: string;
  // Override the default `is_subagent` derivation. Omit
  // (default) to let `parentSessionId !== null` decide.
  // Set `true` to mark a parentless audit-anchor row as
  // hidden from top-level listings — used by REPL synthetic
  // parents that exist only to attribute slash-dispatched
  // playbook children when no real turn has run yet.
  isSubagent?: boolean;
}

export const createSession = (db: DB, input: CreateSessionInput): Session => {
  const id = input.id ?? crypto.randomUUID();
  const startedAt = input.startedAt ?? Date.now();
  const parentSessionId = input.parentSessionId ?? null;
  // is_subagent is the IDENTITY flag — flips once based on the
  // role this session plays in the audit graph, never updated
  // afterwards. parent_session_id can later go to NULL via the
  // ON DELETE SET NULL cascade when the parent is purged, but
  // is_subagent stays at 1 so the orphaned row continues to be
  // excluded from the default top-level listing.
  //
  // Default derivation: a session with a parent IS a subagent
  // child. The explicit `isSubagent` override exists for
  // synthetic anchor rows (e.g., the REPL's lazy-created parent
  // for slash playbook dispatches before any real turn) — those
  // rows have no parent but also no user-facing conversation,
  // and treating them as top-level pollutes `--list-sessions`
  // and lets `--resume last` resurrect an empty shell instead
  // of the operator's real session.
  const isSubagent = input.isSubagent ?? parentSessionId !== null;
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
    `INSERT INTO sessions (id, started_at, model, cwd, status, total_cost_usd, seq, parent_session_id, is_subagent)
     VALUES (?, ?, ?, ?, 'running', 0, (SELECT COALESCE(MAX(seq), -1) + 1 FROM sessions), ?, ?)`,
  ).run(id, startedAt, input.model, input.cwd, parentSessionId, isSubagent ? 1 : 0);
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
    isSubagent,
    abortCause: null,
  };
};

export const getSession = (db: DB, id: string): Session | null => {
  const row = db
    .query(
      `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id, is_subagent, abort_cause
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | null;
  return row !== null ? fromRow(row) : null;
};

export interface ListSessionsOptions {
  limit?: number;
  cwd?: string;
  status?: SessionStatus;
  // Inclusive lower bound on `started_at`. Used by `/recap list
  // --since YYYY-MM-DD` so the SQL-side LIMIT does not silently
  // drop matching older sessions when more recent unfiltered ones
  // also exist. Without this, applying `--since` after fetching
  // `LIMIT 20` newest-first would yield "20 newest then drop those
  // before --since", surprising operators who expect "20 newest
  // matching all filters".
  startedAtMin?: number;
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
  if (options.startedAtMin !== undefined) {
    filters.push('started_at >= ?');
    params.push(options.startedAtMin);
  }
  if (options.includeSubagents !== true) {
    // Filter on the IDENTITY flag (`is_subagent`), not on the FK
    // (`parent_session_id IS NULL`). After a parent is purged via
    // ON DELETE SET NULL, the child's parent_session_id becomes
    // NULL but is_subagent stays at 1 — so the orphan stays out
    // of the top-level pool, which is what `--resume last` and
    // the user-facing listing want.
    filters.push('is_subagent = 0');
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
  const sql = `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id, is_subagent, abort_cause
               FROM sessions
               ${where}
               ORDER BY started_at DESC, seq DESC
               LIMIT ?`;
  const rows = db.query(sql).all(...params) as SessionRow[];
  return rows.map(fromRow);
};

// Total count of sessions matching the same filters as
// `listSessions` but ignoring `limit`. Used by `--list-sessions`
// to accurately report the truncation hint: `listSessions` itself
// caps at `limit`, so the iterating code can't tell whether the
// returned batch IS everything or whether the DB holds more rows
// the cap excluded. A COUNT(*) against the same predicate fills
// the gap in O(1) with the index migration 011 created.
export const countSessions = (db: DB, options: Omit<ListSessionsOptions, 'limit'> = {}): number => {
  const filters: string[] = [];
  const params: string[] = [];
  if (options.cwd !== undefined) {
    filters.push('cwd = ?');
    params.push(options.cwd);
  }
  if (options.status !== undefined) {
    filters.push('status = ?');
    params.push(options.status);
  }
  if (options.includeSubagents !== true) {
    filters.push('is_subagent = 0');
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const row = db
    .query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM sessions ${where}`)
    .get(...params);
  return row?.n ?? 0;
};

// Sum of `total_cost_usd` for a root session and ALL its
// descendants reachable via parent_session_id (DFS). Used by
// `--list-sessions` so the user doesn't have to mentally sum
// per-row costs across a fan-out tree.
//
// Orphans (rows whose parent was purged → parent_session_id=NULL)
// are NOT included: the FK link is the rollup channel, and a
// purged parent has no live tree to walk. Their cost is still
// recorded on the orphan row itself; an audit query that wants
// "total spend including detached subagents" can iterate
// listSessions({includeSubagents: true}) and sum directly.
//
// The seen-guard mirrors the listing's fanOut: defense in depth
// against a corrupt self-referential row that the FK doesn't
// prevent at write time. Without it, a self-loop would deadlock
// the walk.
export const cumulativeCostUsd = (db: DB, rootSessionId: string): number => {
  const seen = new Set<string>();
  let total = 0;
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const row = db
      .query<{ total_cost_usd: number }, [string]>(
        'SELECT total_cost_usd FROM sessions WHERE id = ?',
      )
      .get(id);
    if (row === null) return;
    total += row.total_cost_usd;
    const children = db
      .query<{ id: string }, [string]>('SELECT id FROM sessions WHERE parent_session_id = ?')
      .all(id);
    for (const c of children) visit(c.id);
  };
  visit(rootSessionId);
  return total;
};

// Children of a parent session, oldest-first so renderers can show
// the natural call order (a parent with two task() invocations sees
// child[0] before child[1]). Used by --list-sessions hierarchy and
// by cost rollup queries.
export const listChildSessions = (db: DB, parentSessionId: string): Session[] => {
  const rows = db
    .query(
      `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id, is_subagent, abort_cause
       FROM sessions
       WHERE parent_session_id = ?
       ORDER BY started_at ASC, seq ASC`,
    )
    .all(parentSessionId) as SessionRow[];
  return rows.map(fromRow);
};

export interface ListSessionsInRangeOptions {
  // Half-open `[start, end)` interval on `started_at`, epoch ms.
  // Inclusive lower bound, exclusive upper bound — matches how
  // recap's `dayBoundsUtc` builds day windows
  // (`Date.UTC(...) ` to `+24h`), so a session started at exactly
  // midnight UTC belongs to that day, not the next.
  start: number;
  end: number;
  cwd?: string;
  includeSubagents?: boolean;
}

// Sessions whose `started_at` falls in `[start, end)`, optionally
// filtered by `cwd`. Used by `/recap day` / `/recap range` so the
// time predicate is applied in SQL — filtering AFTER a `LIMIT`
// (the listSessions trap) silently misses older windows once a
// project crosses the cap.
//
// Ordered oldest-first to match the recap projection's canonical
// chronological reading; consumers that want newest-first can
// reverse client-side. The (`started_at`, `seq`) tiebreak mirrors
// `listSessions` so two sessions started in the same millisecond
// resolve deterministically.
//
// `is_subagent = 0` is the default filter (same discipline as
// `listSessions`): cross-session recap should not surface
// orphaned children unless an explicit `includeSubagents:true`
// asks for them. The (status, started_at) and (cwd, started_at)
// indexes cover the common variants; the predicate-only-on-
// started_at variant uses the cwd-prefixed index when `cwd` is
// supplied and falls back to a scan in the full-table case.
export const listSessionsInRange = (db: DB, options: ListSessionsInRangeOptions): Session[] => {
  const filters: string[] = ['started_at >= ?', 'started_at < ?'];
  const params: (string | number)[] = [options.start, options.end];
  if (options.cwd !== undefined) {
    filters.push('cwd = ?');
    params.push(options.cwd);
  }
  if (options.includeSubagents !== true) {
    filters.push('is_subagent = 0');
  }
  const rows = db
    .query(
      `SELECT id, started_at, ended_at, model, cwd, status, total_cost_usd, usage_complete, parent_session_id, is_subagent, abort_cause
       FROM sessions
       WHERE ${filters.join(' AND ')}
       ORDER BY started_at ASC, seq ASC`,
    )
    .all(...params) as SessionRow[];
  return rows.map(fromRow);
};

export const completeSession = (
  db: DB,
  id: string,
  status: Exclude<SessionStatus, 'running'>,
  totalCostUsd: number,
  usageComplete: boolean,
  endedAt: number = Date.now(),
  // Optional discriminator for status='interrupted'. Caller (the
  // harness loop's finish() helper) passes 'soft' or 'hard' when
  // reason was 'aborted', undefined otherwise. The CHECK constraint
  // on the column rejects any other value, so a future caller that
  // typos 'cooperative' fails at SQLite write time rather than
  // silently storing junk.
  abortCause?: 'soft' | 'hard',
): void => {
  const result = db
    .query(
      `UPDATE sessions
       SET status = ?, ended_at = ?, total_cost_usd = ?, usage_complete = ?,
           abort_cause = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(status, endedAt, totalCostUsd, usageComplete ? 1 : 0, abortCause ?? null, id);
  if (result.changes === 0) {
    const exists = getSession(db, id);
    if (exists === null) throw new Error(`session ${id} not found`);
    throw new Error(`session ${id} not in 'running' state (was '${exists.status}')`);
  }
};

// Reclassify an ALREADY-finalized session's status. Used by
// post-finalize failure detection — currently the playbook
// output_schema validator, which runs AFTER `runAgent` returns
// (and therefore AFTER `completeSession` flipped status to
// `done`). Without this override, a schema-failed run leaves
// `sessions.status = 'done'` while the published envelope says
// `status = 'error'` / `reason = 'playbook.output_invalid'`,
// and any audit / telemetry query keyed on `sessions.status`
// counts the run as successful.
//
// Strict precondition: the row must be in `expectedFrom` status
// (typically `'done'`). Refusing to override `running` rows
// keeps `completeSession` as the canonical finalize path —
// using this for the initial finalize would race the harness's
// own writeback. The CHECK constraint on `sessions.status`
// rejects any unknown destination value at SQLite write time.
export const reclassifySessionStatus = (
  db: DB,
  id: string,
  expectedFrom: Exclude<SessionStatus, 'running'>,
  newStatus: Exclude<SessionStatus, 'running'>,
): void => {
  const result = db
    .query('UPDATE sessions SET status = ? WHERE id = ? AND status = ?')
    .run(newStatus, id, expectedFrom);
  if (result.changes === 0) {
    const exists = getSession(db, id);
    if (exists === null) throw new Error(`session ${id} not found`);
    throw new Error(
      `session ${id} not in expected '${expectedFrom}' state (was '${exists.status}')`,
    );
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
