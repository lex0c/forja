import type { DB } from '../db.ts';

// Repo for `hook_runs` (migration 019). Audit-only — hook
// commands and their stdouts already lived on the operator's
// disk; this table answers "which hook fired when, what did it
// decide, what did it print?".
//
// Insert paths come from the dispatcher (one row per dispatched
// hook). Read paths feed `/hooks audit` and forensic queries.

export type HookRunsEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PreCompact'
  | 'Notification'
  | 'PreCheckpoint'
  | 'MemoryWrite'
  | 'Eviction'
  | 'Stop';

export type HookRunsLayer = 'enterprise' | 'user' | 'project';

export type HookRunsOutcome = 'allow' | 'block_silent' | 'block_message' | 'error' | 'timeout';

export interface HookRun {
  id: string;
  sessionId: string | null;
  event: HookRunsEvent;
  layer: HookRunsLayer;
  sourcePath: string;
  hookIndex: number;
  command: string;
  expanded: string;
  exitCode: number | null;
  outcome: HookRunsOutcome;
  durationMs: number;
  stdout: string | null;
  stderr: string | null;
  matchedTool: string | null;
  createdAt: number;
}

interface HookRunRow {
  id: string;
  session_id: string | null;
  event: HookRunsEvent;
  layer: HookRunsLayer;
  source_path: string;
  hook_index: number;
  command: string;
  expanded: string;
  exit_code: number | null;
  outcome: HookRunsOutcome;
  duration_ms: number;
  stdout: string | null;
  stderr: string | null;
  matched_tool: string | null;
  created_at: number;
}

const fromRow = (row: HookRunRow): HookRun => ({
  id: row.id,
  sessionId: row.session_id,
  event: row.event,
  layer: row.layer,
  sourcePath: row.source_path,
  hookIndex: row.hook_index,
  command: row.command,
  expanded: row.expanded,
  exitCode: row.exit_code,
  outcome: row.outcome,
  durationMs: row.duration_ms,
  stdout: row.stdout,
  stderr: row.stderr,
  matchedTool: row.matched_tool,
  createdAt: row.created_at,
});

export interface CreateHookRunInput {
  // Optional caller-supplied id — replay tools / batch loaders
  // pass deterministic ids. Defaults to a fresh UUID.
  id?: string;
  sessionId?: string | null;
  event: HookRunsEvent;
  layer: HookRunsLayer;
  sourcePath: string;
  hookIndex: number;
  command: string;
  expanded: string;
  exitCode?: number | null;
  outcome: HookRunsOutcome;
  durationMs: number;
  stdout?: string | null;
  stderr?: string | null;
  matchedTool?: string | null;
  createdAt?: number;
}

export const createHookRun = (db: DB, input: CreateHookRunInput): HookRun => {
  const id = input.id ?? crypto.randomUUID();
  const sessionId = input.sessionId ?? null;
  const exitCode = input.exitCode ?? null;
  const stdout = input.stdout ?? null;
  const stderr = input.stderr ?? null;
  const matchedTool = input.matchedTool ?? null;
  const createdAt = input.createdAt ?? Date.now();
  db.query(
    `INSERT INTO hook_runs
       (id, session_id, event, layer, source_path, hook_index, command,
        expanded, exit_code, outcome, duration_ms, stdout, stderr,
        matched_tool, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sessionId,
    input.event,
    input.layer,
    input.sourcePath,
    input.hookIndex,
    input.command,
    input.expanded,
    exitCode,
    input.outcome,
    input.durationMs,
    stdout,
    stderr,
    matchedTool,
    createdAt,
  );
  return {
    id,
    sessionId,
    event: input.event,
    layer: input.layer,
    sourcePath: input.sourcePath,
    hookIndex: input.hookIndex,
    command: input.command,
    expanded: input.expanded,
    exitCode,
    outcome: input.outcome,
    durationMs: input.durationMs,
    stdout,
    stderr,
    matchedTool,
    createdAt,
  };
};

// All hook runs for one session, ordered most-recent first
// (matches the partial index direction). Pages via optional
// `limit`.
export const listHookRunsBySession = (db: DB, sessionId: string, limit?: number): HookRun[] => {
  if (limit !== undefined) {
    const rows = db
      .query<HookRunRow, [string, number]>(
        `SELECT id, session_id, event, layer, source_path, hook_index,
                command, expanded, exit_code, outcome, duration_ms,
                stdout, stderr, matched_tool, created_at
           FROM hook_runs
          WHERE session_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(sessionId, limit);
    return rows.map(fromRow);
  }
  const rows = db
    .query<HookRunRow, [string]>(
      `SELECT id, session_id, event, layer, source_path, hook_index,
              command, expanded, exit_code, outcome, duration_ms,
              stdout, stderr, matched_tool, created_at
         FROM hook_runs
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

// Recent hook runs across all sessions. Used by `/hooks audit`
// when no session filter is requested. Capped by `limit`
// (default 50, mirrors `listRecentMemoryEvents`).
export const listRecentHookRuns = (db: DB, limit = 50): HookRun[] => {
  const rows = db
    .query<HookRunRow, [number]>(
      `SELECT id, session_id, event, layer, source_path, hook_index,
              command, expanded, exit_code, outcome, duration_ms,
              stdout, stderr, matched_tool, created_at
         FROM hook_runs
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};

// Recent runs filtered by event. Useful for dashboards counting
// PreToolUse blocks per week.
export const listHookRunsByEvent = (db: DB, event: HookRunsEvent, limit = 50): HookRun[] => {
  const rows = db
    .query<HookRunRow, [HookRunsEvent, number]>(
      `SELECT id, session_id, event, layer, source_path, hook_index,
              command, expanded, exit_code, outcome, duration_ms,
              stdout, stderr, matched_tool, created_at
         FROM hook_runs
        WHERE event = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(event, limit);
  return rows.map(fromRow);
};

// Combined-filter query for `/hooks audit` (slash command). Both
// session AND event filters are optional; when set, they're
// pushed down to the SQL WHERE clause so `LIMIT ?` runs AFTER
// filtering — fetching the limit first and filtering in memory
// would silently truncate matching rows whenever non-matching
// events crowded the recent tail.
//
// Returns rows newest-first (matches `listRecent…` ordering); the
// session-partial index covers the session-scoped path, the
// event index covers the cross-session path.
export interface HookRunsQuery {
  sessionId?: string;
  event?: HookRunsEvent;
  limit?: number;
}
export const queryHookRuns = (db: DB, opts: HookRunsQuery = {}): HookRun[] => {
  const limit = opts.limit ?? 50;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.sessionId !== undefined) {
    where.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.event !== undefined) {
    where.push('event = ?');
    params.push(opts.event);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const rows = db
    .query<HookRunRow, (string | number)[]>(
      `SELECT id, session_id, event, layer, source_path, hook_index,
              command, expanded, exit_code, outcome, duration_ms,
              stdout, stderr, matched_tool, created_at
         FROM hook_runs
         ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map(fromRow);
};

// ─── pruneHookRuns ─────────────────────────────────────────────────────
//
// Retention sweep for `agent gc` Phase 2 (AGENTIC_CLI §2.1.3, AUDIT
// §1.2). Default retention 90d on `created_at`. Cutoff EXCLUSIVE.
//
// Per-event hook execution log. FK SET NULL with sessions — rows
// survive session cleanup independently. Grows with every hook
// dispatch; among the fastest-accumulating tables in workflows with
// rich operator hook chains.
export const pruneHookRuns = (db: DB, olderThanMs: number): number => {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error(
      `pruneHookRuns: olderThanMs must be a positive finite number (got ${olderThanMs})`,
    );
  }
  const result = db.query('DELETE FROM hook_runs WHERE created_at < ?').run(olderThanMs);
  return Number(result.changes);
};
