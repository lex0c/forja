export const migration029SubagentProcesses = {
  id: 29,
  name: '029-subagent-processes',
  // End-to-end subprocess audit. `subagent_outputs` captures the
  // structured RESULT a child publishes; `subagent_runs` captures
  // the spawn metadata the parent committed to. Neither covers the
  // OS-level lifecycle: pid, exit code, exit signal, where stderr
  // landed on disk, whether the IPC handshake completed before the
  // process died.
  //
  // Without those, "subagent X failed" forensic queries route
  // through stderr.log files on disk + speculation. With them, an
  // operator (or future `agent audit subprocess <id>`) gets one row
  // that answers "what happened to that subprocess".
  //
  // Schema rationale:
  // - session_id (PK + FK CASCADE). 1:1 with the child's session,
  //   matches `subagent_outputs` / `subagent_runs` shape. The row
  //   is born when Bun.spawn returns a pid; spawn failures (ENOENT,
  //   EACCES, out-of-fds) produce no row here — they're caught by
  //   the runtime's try/catch and surface via `subagent_outputs`
  //   with a spawn-failed result. This table is "processes that
  //   actually ran", not "every spawn attempt".
  // - parent_session_id (FK, ON DELETE SET NULL). Same pattern as
  //   `subagent_runs.parent_session_id`. Lets `agent audit
  //   subprocess --parent <id>` walk all subprocesses spawned by a
  //   given top-level session, even after the parent is purged.
  // - pid INTEGER NOT NULL. OS pid at spawn. Useful for correlating
  //   with `ps`/`top`/external profilers and for the rare debug
  //   case where the operator captured a flamegraph mid-flight.
  //   Nullable doesn't make sense — if there's no pid there's no
  //   row.
  // - argv_hash TEXT NOT NULL. SHA256 of the child's argv joined
  //   with NUL. Reproducibility surface: "what flags did this
  //   child run with" answerable without storing the full argv
  //   (which contains paths, tokens, etc — argv_hash is a
  //   fingerprint, not the value itself). Future regression hunts
  //   ("when did this playbook start failing? did the argv change
  //   between runs?") get a one-column join.
  // - spawned_at INTEGER NOT NULL. Epoch ms at the moment Bun.spawn
  //   returned. Distinct from `sessions.created_at` (session row
  //   exists before spawn) and `subagent_outputs.created_at` (which
  //   is the row's creation, not the process's). The delta
  //   `spawned_at - sessions.created_at` measures "how long did
  //   prep take before we actually launched a child".
  // - exited_at INTEGER, nullable. Epoch ms when proc.exited
  //   resolved. NULL while the process is still running OR if the
  //   parent itself crashed before observing the exit. The
  //   `idx_subagent_processes_running` partial index targets this
  //   "still running OR orphaned" set for janitor queries.
  // - exit_code INTEGER, nullable. `proc.exitCode` at exit. NULL
  //   when the process was killed by a signal (POSIX semantics:
  //   exitCode is undefined for signaled exits) or while still
  //   running. exit_code=0 + exit_signal=NULL = clean exit.
  // - exit_signal TEXT, nullable. e.g. 'SIGTERM' / 'SIGKILL' /
  //   'SIGSEGV'. NULL on normal exit. Bun reports signal-killed
  //   processes with `proc.signalCode`; the caller normalizes.
  // - stderr_log_path TEXT, nullable. Absolute path the parent
  //   asked for (e.g. `<bgLogDir>/stderr.log`). NULL when bgLogDir
  //   was undefined (test fixture, headless tooling). The file
  //   itself may or may not exist — `drainStderrToLogFile` only
  //   creates it on the first byte. Audit consumer probes existence
  //   on read.
  // - ipc_handshake_ok INTEGER NOT NULL DEFAULT 0. 1 iff the
  //   parent received a valid `session_start` over IPC with a
  //   matching `protocolVersion`. Distinguishes "child crashed
  //   before booting the harness" (handshake_ok=0, exit_code≠0)
  //   from "child booted, then misbehaved" (handshake_ok=1,
  //   anything else). Without this column those two failure modes
  //   read identical at audit-query time.
  // - exit_reason TEXT, nullable. Categorical post-mortem — one of
  //   'normal', 'crash', 'killed', 'parent_aborted', 'signal',
  //   'unknown'. NULL while still running. Computed at exit-record
  //   time from (exit_code, exit_signal, parent's abort state).
  //   Redundant with the other exit_* columns but answerable
  //   without joining or computing — `agent audit subprocess
  //   --reason crash` is a one-shot.
  //
  // Indexes:
  // - idx_subagent_processes_parent: query "all subprocesses by
  //   parent X" for the audit forensics CLI.
  // - idx_subagent_processes_running PARTIAL on
  //   exited_at IS NULL: ranks the live/orphaned set first; janitor
  //   queries that detect parent crashes (rows where exited_at
  //   never landed) read this set.
  //
  // No UPDATE timestamps (created_at / updated_at) because the
  // table is conceptually two-phase (INSERT at spawn, single
  // UPDATE at exit) — extra timestamp columns would just track the
  // same two moments. Mirrors the precedent set by `subagent_runs`
  // (also two-phase, also no updated_at).
  //
  // CASCADE on session_id: deleting the child session drops this
  // row. Parent purge that ON DELETE SET NULL's parent_session_id
  // keeps the child + its process row intact (operator deleted the
  // PARENT session but the child is still useful evidence).
  sql: `
    CREATE TABLE subagent_processes (
      session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      pid               INTEGER NOT NULL,
      argv_hash         TEXT NOT NULL,
      spawned_at        INTEGER NOT NULL,
      exited_at         INTEGER,
      exit_code         INTEGER,
      exit_signal       TEXT,
      stderr_log_path   TEXT,
      ipc_handshake_ok  INTEGER NOT NULL DEFAULT 0,
      exit_reason       TEXT
    );

    CREATE INDEX idx_subagent_processes_parent
      ON subagent_processes(parent_session_id);

    CREATE INDEX idx_subagent_processes_running
      ON subagent_processes(spawned_at ASC)
      WHERE exited_at IS NULL;
  `,
} as const;
