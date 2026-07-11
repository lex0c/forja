export const migration021SubagentHandles = {
  id: 21,
  name: '021-subagent-handles',
  // Persistence layer for `task_async` handles (spec
  // ORCHESTRATION.md §3, slice 2 of feat/parallel). The handle
  // store was originally session-scoped (in-memory only); a
  // parent that died between `task_async` and `task_await`
  // produced a handle id the model held in its message history
  // but the store could no longer resolve, surfacing as
  // `subagent.unknown_handle` on resume — confusing UX and
  // stranded child outputs (subagent_outputs already had the
  // payload; the parent just lost the mapping).
  //
  // This migration introduces a parent-side mapping:
  //   handle_id (PK) → (parent_session_id, child_session_id, status, settled_payload)
  //
  // Lifecycle in the persistence path:
  //   1. `task_async` issues handle: INSERT row with
  //      child_session_id=NULL, status='running'.
  //   2. The spawn dispatches and `runSubagent` returns with the
  //      child's session id: UPDATE child_session_id +
  //      status='settled' + settled_payload (envelope JSON).
  //   3. `cancel` mid-run: settle path same as above; envelope
  //      reflects the interrupted exit (cancelled / cancelled-
  //      before-dispatch).
  //   4. drain on session-end: same mass settle.
  //
  // Resume recovery:
  //   - Rows with status='settled' rehydrate the cached envelope
  //     directly. `task_await` returns the cached output without
  //     re-spawning.
  //   - Rows with status='running' (parent crashed mid-spawn) are
  //     converted to a synthesized `interrupted` envelope with
  //     reason='resumed_session'. The child subprocess may still
  //     be alive on the OS — its eventual `subagent_outputs`
  //     write lands harmlessly because the row is already
  //     terminal in the parent's view.
  //
  // FK CASCADE on parent_session_id keeps cleanup hands-off:
  // dropping a session row reaps its handles too.
  //
  // Storage choices:
  //   - `settled_payload` is JSON (TEXT). Same convention as
  //     `subagent_outputs.payload` and `subagent_runs.policy_snapshot`.
  //     Repo layer parses defensively (returns null on malformed
  //     JSON) so audit listings never crash on storage corruption.
  //   - `name` denormalized off the source definition so a
  //     diagnostic dump doesn't have to join through the runs
  //     table; cheap to keep, hard to reconstruct after-the-fact.
  //   - No `prompt` column. Spec §3.4 isolates the prompt to the
  //     child run; persisting it here would duplicate state and
  //     leak prompt content into the parent's handle table.
  //   - `created_at` is NOT NULL — every insert provides a
  //     `Date.now()` value from the JS layer (see other repos for
  //     the convention; SQLite `unixepoch()` is avoided to keep
  //     migrations Bun-portable).
  sql: `
    CREATE TABLE subagent_handles (
      handle_id TEXT NOT NULL PRIMARY KEY,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      child_session_id TEXT,
      name TEXT NOT NULL,
      spawned_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'settled')),
      settled_payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_subagent_handles_parent
      ON subagent_handles(parent_session_id);
  `,
} as const;
