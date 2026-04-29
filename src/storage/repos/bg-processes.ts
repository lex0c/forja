import type { DB } from '../db.ts';

export type BgProcessStatus = 'running' | 'exited' | 'killed' | 'failed';

export interface BgProcess {
  id: string;
  sessionId: string;
  osPid: number | null;
  label: string | null;
  command: string;
  cwd: string;
  spawnedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  status: BgProcessStatus;
  stdoutLogPath: string;
  stderrLogPath: string;
  // Byte offset on each stream already returned to the model.
  // Stdout and stderr advance independently so a noisy stdout
  // can't strand stderr writes (see migration 006).
  stdoutCursorPosition: number;
  stderrCursorPosition: number;
}

interface BgProcessRow {
  id: string;
  session_id: string;
  os_pid: number | null;
  label: string | null;
  command: string;
  cwd: string;
  spawned_at: number;
  exited_at: number | null;
  exit_code: number | null;
  status: BgProcessStatus;
  stdout_log_path: string;
  stderr_log_path: string;
  cursor_position: number;
  stderr_cursor_position: number;
}

const fromRow = (row: BgProcessRow): BgProcess => ({
  id: row.id,
  sessionId: row.session_id,
  osPid: row.os_pid,
  label: row.label,
  command: row.command,
  cwd: row.cwd,
  spawnedAt: row.spawned_at,
  exitedAt: row.exited_at,
  exitCode: row.exit_code,
  status: row.status,
  stdoutLogPath: row.stdout_log_path,
  stderrLogPath: row.stderr_log_path,
  stdoutCursorPosition: row.cursor_position,
  stderrCursorPosition: row.stderr_cursor_position,
});

export interface InsertBgProcessInput {
  id?: string;
  sessionId: string;
  osPid?: number | null;
  label?: string | null;
  command: string;
  cwd: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  spawnedAt?: number;
}

export const insertBgProcess = (db: DB, input: InsertBgProcessInput): BgProcess => {
  const id = input.id ?? crypto.randomUUID();
  const spawnedAt = input.spawnedAt ?? Date.now();
  const osPid = input.osPid ?? null;
  const label = input.label ?? null;
  db.query(
    `INSERT INTO background_processes
       (id, session_id, os_pid, label, command, cwd, spawned_at,
        exited_at, exit_code, status, stdout_log_path, stderr_log_path, cursor_position)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'running', ?, ?, 0)`,
  ).run(
    id,
    input.sessionId,
    osPid,
    label,
    input.command,
    input.cwd,
    spawnedAt,
    input.stdoutLogPath,
    input.stderrLogPath,
  );
  return {
    id,
    sessionId: input.sessionId,
    osPid,
    label,
    command: input.command,
    cwd: input.cwd,
    spawnedAt,
    exitedAt: null,
    exitCode: null,
    status: 'running',
    stdoutLogPath: input.stdoutLogPath,
    stderrLogPath: input.stderrLogPath,
    stdoutCursorPosition: 0,
    stderrCursorPosition: 0,
  };
};

export const getBgProcess = (db: DB, id: string): BgProcess | null => {
  const row = db
    .query(
      `SELECT id, session_id, os_pid, label, command, cwd, spawned_at,
              exited_at, exit_code, status, stdout_log_path, stderr_log_path,
              cursor_position, stderr_cursor_position
       FROM background_processes
       WHERE id = ?`,
    )
    .get(id) as BgProcessRow | null;
  return row === null ? null : fromRow(row);
};

export interface ListBgProcessesFilter {
  status?: BgProcessStatus | BgProcessStatus[];
}

export const listBgProcessesBySession = (
  db: DB,
  sessionId: string,
  filter?: ListBgProcessesFilter,
): BgProcess[] => {
  // Status filter is an explicit literal-list match — keeps the query
  // safe (no string interpolation of user data) and lets indices apply.
  const statuses =
    filter?.status === undefined
      ? null
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
  if (statuses === null) {
    const rows = db
      .query(
        `SELECT id, session_id, os_pid, label, command, cwd, spawned_at,
                exited_at, exit_code, status, stdout_log_path, stderr_log_path,
                cursor_position, stderr_cursor_position
         FROM background_processes
         WHERE session_id = ?
         ORDER BY spawned_at DESC, id ASC`,
      )
      .all(sessionId) as BgProcessRow[];
    return rows.map(fromRow);
  }
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db
    .query(
      `SELECT id, session_id, os_pid, label, command, cwd, spawned_at,
              exited_at, exit_code, status, stdout_log_path, stderr_log_path,
              cursor_position, stderr_cursor_position
       FROM background_processes
       WHERE session_id = ? AND status IN (${placeholders})
       ORDER BY spawned_at DESC, id ASC`,
    )
    .all(sessionId, ...statuses) as BgProcessRow[];
  return rows.map(fromRow);
};

// Stdout cursor advance — hot path on every successful `bash_output`,
// `wait_for(process_output)`, and `monitor(process_output_*)` call.
// Three readers can target the same process concurrently (e.g.,
// canonical bash_output + a wait_for poll loop + a monitor poll
// loop), and each call's `stdoutWin.end` may differ. A naive
// `UPDATE SET cursor_position = ?` would let the slowest read
// clobber a faster one's larger cursor, rolling back already-emitted
// bytes and replaying them.
//
// Fix: monotonic at the DB level via `cursor_position < ?` —
// only updates when the new value is greater, so out-of-order
// writes from concurrent readers are no-ops. SQLite's row-level
// locking serializes the comparison + write, so the pattern is
// race-free.
//
// The legacy column is named `cursor_position` (predates the
// dual-cursor split in migration 006); the public name is explicit
// about which stream it tracks.
export const advanceBgProcessStdoutCursor = (db: DB, id: string, newCursor: number): void => {
  db.query(
    `UPDATE background_processes
     SET cursor_position = ?
     WHERE id = ? AND cursor_position < ?`,
  ).run(newCursor, id, newCursor);
};

// Stderr cursor advance. Same monotonic guard as stdout — see
// rationale above. Tracked independently so a noisy stdout can't
// strand stderr writes (migration 006 failure mode).
export const advanceBgProcessStderrCursor = (db: DB, id: string, newCursor: number): void => {
  db.query(
    `UPDATE background_processes
     SET stderr_cursor_position = ?
     WHERE id = ? AND stderr_cursor_position < ?`,
  ).run(newCursor, id, newCursor);
};

// Mark a process as exited or killed. exit_code may be null on signal-
// driven termination where the OS didn't surface one. status='failed'
// is reserved for spawn-time errors (binary not found, permission
// denied) — distinct from 'exited' (ran and finished) and 'killed'
// (we asked it to stop).
export interface FinalizeBgProcessInput {
  id: string;
  status: 'exited' | 'killed' | 'failed';
  exitCode?: number | null;
  exitedAt?: number;
}

export const finalizeBgProcess = (db: DB, input: FinalizeBgProcessInput): void => {
  const exitedAt = input.exitedAt ?? Date.now();
  const exitCode = input.exitCode ?? null;
  db.query(
    `UPDATE background_processes
     SET status = ?, exit_code = ?, exited_at = ?
     WHERE id = ?`,
  ).run(input.status, exitCode, exitedAt, input.id);
};

// Mark every still-running row in a session as killed. Called from the
// session-end cleanup hook AFTER the actual kills have been issued —
// the DB write reflects observed state, it doesn't drive it.
// Returns the number of rows touched, useful for cleanup logging.
export const markRunningAsKilled = (db: DB, sessionId: string): number => {
  const now = Date.now();
  const result = db
    .query(
      `UPDATE background_processes
       SET status = 'killed', exited_at = ?
       WHERE session_id = ? AND status = 'running'`,
    )
    .run(now, sessionId);
  return Number(result.changes);
};
