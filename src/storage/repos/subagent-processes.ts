import type { DB } from '../db.ts';

// Repo for `subagent_processes` (migration 029). End-to-end
// subprocess lifecycle audit — see the migration comment for the
// schema rationale.
//
// Two-phase write:
//   1. `recordProcessSpawn` — INSERT after Bun.spawn returns a pid.
//   2. `recordProcessExit` — single UPDATE when proc.exited resolves.
// Plus an optional `markIpcHandshakeOk` between them, called the
// first time the parent observes a valid `session_start` from the
// child over IPC.

export type SubagentProcessExitReason =
  | 'normal'
  | 'crash'
  | 'killed'
  | 'parent_aborted'
  | 'signal'
  | 'unknown';

export interface SubagentProcessRecord {
  sessionId: string;
  parentSessionId: string | null;
  pid: number;
  argvHash: string;
  spawnedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  stderrLogPath: string | null;
  ipcHandshakeOk: boolean;
  exitReason: SubagentProcessExitReason | null;
}

interface SubagentProcessRow {
  session_id: string;
  parent_session_id: string | null;
  pid: number;
  argv_hash: string;
  spawned_at: number;
  exited_at: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  stderr_log_path: string | null;
  ipc_handshake_ok: number;
  exit_reason: string | null;
}

const isExitReason = (raw: string | null): raw is SubagentProcessExitReason => {
  return (
    raw === 'normal' ||
    raw === 'crash' ||
    raw === 'killed' ||
    raw === 'parent_aborted' ||
    raw === 'signal' ||
    raw === 'unknown'
  );
};

const fromRow = (row: SubagentProcessRow): SubagentProcessRecord => ({
  sessionId: row.session_id,
  parentSessionId: row.parent_session_id,
  pid: row.pid,
  argvHash: row.argv_hash,
  spawnedAt: row.spawned_at,
  exitedAt: row.exited_at,
  exitCode: row.exit_code,
  exitSignal: row.exit_signal,
  stderrLogPath: row.stderr_log_path,
  ipcHandshakeOk: row.ipc_handshake_ok === 1,
  // Tolerant read: a corrupt enum value (manual SQL edit, future
  // migration drift) reads as `null` rather than throwing —
  // forensic queries should still surface the row.
  exitReason: isExitReason(row.exit_reason) ? row.exit_reason : null,
});

export interface RecordProcessSpawnInput {
  sessionId: string;
  parentSessionId: string | null;
  pid: number;
  argvHash: string;
  spawnedAt: number;
  stderrLogPath: string | null;
}

// `INSERT OR REPLACE` for idempotence: a child session that's
// resurrected (would never happen with CASCADE on sessions(id),
// but defensive against hand-edits) overwrites the prior row
// rather than throwing on PK conflict. The repo's contract is
// "this child started AT this pid" — if the same session_id
// starts twice the second IS the truth.
//
// `ipc_handshake_ok` is omitted from the column list so the
// DEFAULT 0 from migration 029 sets the initial value. A REPLACE
// over an already-handshaked row therefore correctly resets the
// flag — the new spawn hasn't completed its own handshake yet.
export const recordProcessSpawn = (db: DB, input: RecordProcessSpawnInput): void => {
  db.query(
    `INSERT OR REPLACE INTO subagent_processes (
       session_id, parent_session_id, pid, argv_hash,
       spawned_at, stderr_log_path
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionId,
    input.parentSessionId,
    input.pid,
    input.argvHash,
    input.spawnedAt,
    input.stderrLogPath,
  );
};

// Idempotent: called every time a `session_start` arrives, but
// SQL is a no-op once the row already shows handshake_ok=1.
// Cheaper than read-then-write because the WHERE clause
// short-circuits after the first true match.
export const markIpcHandshakeOk = (db: DB, sessionId: string): void => {
  db.query(
    `UPDATE subagent_processes
       SET ipc_handshake_ok = 1
     WHERE session_id = ?
       AND ipc_handshake_ok = 0`,
  ).run(sessionId);
};

export interface RecordProcessExitInput {
  sessionId: string;
  exitedAt: number;
  exitCode: number | null;
  exitSignal: string | null;
  exitReason: SubagentProcessExitReason;
}

// Single UPDATE; absence of a matching row (recordProcessSpawn
// never ran — spawn failed before insert, or test harness skipped
// the spawn record) silently does nothing. The runtime's higher
// layers (subagent_outputs, failure_events) cover that path.
export const recordProcessExit = (db: DB, input: RecordProcessExitInput): void => {
  db.query(
    `UPDATE subagent_processes
       SET exited_at = ?,
           exit_code = ?,
           exit_signal = ?,
           exit_reason = ?
     WHERE session_id = ?`,
  ).run(input.exitedAt, input.exitCode, input.exitSignal, input.exitReason, input.sessionId);
};

export const getProcessRecord = (db: DB, sessionId: string): SubagentProcessRecord | null => {
  const row = db
    .query<SubagentProcessRow, [string]>(
      `SELECT session_id, parent_session_id, pid, argv_hash, spawned_at,
              exited_at, exit_code, exit_signal, stderr_log_path,
              ipc_handshake_ok, exit_reason
         FROM subagent_processes
        WHERE session_id = ?`,
    )
    .get(sessionId);
  return row === null ? null : fromRow(row);
};

// Lists all subprocesses spawned (directly) by a given parent
// session, ordered by spawn time. Used by the audit forensics
// surface ("show me everything subprocess-shaped under run X").
// Walks one level — descendants of descendants need a recursive
// CTE which a future slice can add when the audit CLI lands.
export const listProcessesByParent = (db: DB, parentSessionId: string): SubagentProcessRecord[] => {
  const rows = db
    .query<SubagentProcessRow, [string]>(
      `SELECT session_id, parent_session_id, pid, argv_hash, spawned_at,
              exited_at, exit_code, exit_signal, stderr_log_path,
              ipc_handshake_ok, exit_reason
         FROM subagent_processes
        WHERE parent_session_id = ?
        ORDER BY spawned_at ASC`,
    )
    .all(parentSessionId);
  return rows.map(fromRow);
};

// Subprocesses that started but never recorded an exit. Janitor /
// forensics surface for "what did the parent crash leave behind".
// Used by future `forja worktree gc` extensions.
export const listOrphanedProcesses = (db: DB): SubagentProcessRecord[] => {
  const rows = db
    .query<SubagentProcessRow, []>(
      `SELECT session_id, parent_session_id, pid, argv_hash, spawned_at,
              exited_at, exit_code, exit_signal, stderr_log_path,
              ipc_handshake_ok, exit_reason
         FROM subagent_processes
        WHERE exited_at IS NULL
        ORDER BY spawned_at ASC`,
    )
    .all();
  return rows.map(fromRow);
};
