export const migration009Checkpoints = {
  id: 9,
  name: '009-checkpoints',
  // M3 / Step 3. Spec §12 + CHECKPOINTS.md design doc. Each step that
  // executes a tool with `writes: true` produces a snapshot in git
  // (commit object referenced under `refs/agent/checkpoints/<session>/<id>`).
  // This table is the audit + lookup layer: it lets `--checkpoints list`
  // enumerate the chain without walking refs, and `--undo` find the
  // most recent snapshot without parsing reflogs.
  //
  // - id (TEXT) is the public checkpoint identifier surfaced on the CLI.
  //   Decoupled from git_ref so an eventual non-git backend (cp --reflink,
  //   deferred per CHECKPOINTS §4) can reuse the same id space.
  // - step_id mirrors messages.id of the assistant turn whose tool calls
  //   triggered the snapshot. Foreign-keyed so deleting the session
  //   cascades the audit trail. ON DELETE CASCADE matches what the
  //   bg-processes table does — there is no half-living checkpoint
  //   without its session.
  // - git_ref stores the commit SHA (the actual snapshot content).
  //   Distinct from "the named ref pointing at it" which is reconstructed
  //   from session_id + id. Storing the SHA here is what lets restore
  //   work even if the ref namespace gets reorganized later.
  // - had_bash flags whether the step that produced this checkpoint ran
  //   bash. Drives the warning in `--undo` ("this step ran bash; fs
  //   reverts but DB/network/processes don't"). Stored here so the
  //   undo path doesn't have to re-scan tool_calls per checkpoint —
  //   that scan would have to parse args to know whether bash was
  //   involved, and the data is cheap to capture at write time.
  //
  // Indexes:
  // - (session_id, created_at DESC) supports list/by-session
  //   newest-first, the dominant access pattern for `/undo` and
  //   `--checkpoints list`.
  // - (session_id, step_id) supports the upsert-style "did this step
  //   already snapshot?" check the harness uses to skip duplicate
  //   work within the same step (defense in depth — the harness
  //   issues at most one snapshot per step today).
  sql: `
    CREATE TABLE checkpoints (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      step_id       TEXT NOT NULL,
      git_ref       TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      had_bash      INTEGER NOT NULL DEFAULT 0
                      CHECK (had_bash IN (0, 1))
    );

    CREATE INDEX idx_checkpoints_session_created
      ON checkpoints(session_id, created_at DESC);
    CREATE INDEX idx_checkpoints_session_step
      ON checkpoints(session_id, step_id);
  `,
} as const;
