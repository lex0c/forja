export const migration005BackgroundProcesses = {
  id: 5,
  name: '005-background-processes',
  // Spec §7.3 — `bash_background` spawns long-running
  // processes (npm run dev, pytest --watch, builds) that outlive a single
  // turn. Their lifecycle (pid, command, status, output cursor) needs to
  // survive across model turns within a session and be visible in the
  // audit log between sessions.
  //
  // - id (TEXT) is the internal process_id returned to the model. Not the
  //   OS pid: keeping the public surface decoupled from os-level
  //   identifiers lets us swap process strategy later (daemon, remote,
  //   bun_worker) without changing the tool contract.
  // - os_pid is recorded for `agent doctor`-class diagnostics (M4) so a
  //   crashed harness's orphans can be identified externally.
  // - cwd is captured at spawn so `bash_output` can resolve relative log
  //   paths even if the session's cwd changed mid-run.
  // - cursor_position is the byte offset already returned to the model
  //   from the stdout log; advances on each `bash_output` call.
  // - exited_at / exit_code are nullable; populated on natural exit OR
  //   on kill. status='killed' distinguishes "exited because we asked"
  //   from "exited on its own".
  sql: `
    CREATE TABLE background_processes (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      os_pid              INTEGER,
      label               TEXT,
      command             TEXT NOT NULL,
      cwd                 TEXT NOT NULL,
      spawned_at          INTEGER NOT NULL,
      exited_at           INTEGER,
      exit_code           INTEGER,
      status              TEXT NOT NULL
                            CHECK (status IN ('running','exited','killed','failed')),
      stdout_log_path     TEXT NOT NULL,
      stderr_log_path     TEXT NOT NULL,
      cursor_position     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_bg_session_status   ON background_processes(session_id, status);
    CREATE INDEX idx_bg_session_spawned  ON background_processes(session_id, spawned_at DESC);
  `,
} as const;
