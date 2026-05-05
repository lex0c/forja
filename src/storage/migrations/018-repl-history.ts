export const migration018ReplHistory = {
  id: 18,
  name: '018-repl-history',
  // REPL input history table (HISTORY.md §1.1).
  //
  // History is the ordered sequence of prompts the operator has
  // submitted to the REPL, scoped per project_root. Recallable via
  // ↑/↓ and Ctrl+R reverse search — the convention every shell has
  // shipped for 30 years. It is NOT a conversation log (that lives
  // in `messages`) and NOT an audit trail (that's `audit_events`);
  // those tables have different lifetimes and different consumers,
  // and reusing either would force history queries to filter by
  // role and reconstruct a notion of "submission" that the
  // dedicated table answers in one query.
  //
  // Schema rationale:
  //
  // - id (INTEGER PRIMARY KEY AUTOINCREMENT). Append-only insertion,
  //   single-writer-per-REPL hot path. AUTOINCREMENT (vs ROWID
  //   alias) pins ids monotonically across deletes — trim drops the
  //   oldest rows by ts but the surviving ids never collide with
  //   future inserts. That keeps `loadHistory` deterministic when
  //   two rows share a `ts` (sub-ms collision under fast typing):
  //   id is the stable tiebreaker.
  //
  // - ts (INTEGER NOT NULL). Epoch ms, Date.now()-shaped — same
  //   convention as memory_events, sessions, audit_events. Ordering
  //   key for ↑/↓ recall and reverse search.
  //
  // - project_root (TEXT NOT NULL). path.resolve(cwd) at submit
  //   time. Stored absolute and never decorated; per-project
  //   isolation (HISTORY.md §0.1) hangs entirely on this column. We
  //   do NOT canonicalize symlinks here — `cwd` already comes
  //   absolute from bootstrap, and realpath defense lives in trust
  //   storage where it actually changes a security decision.
  //
  // - prompt (TEXT NOT NULL). Full multi-line buffer, including
  //   embedded `\n`. Stored verbatim so recall produces the exact
  //   bytes the operator had typed; truncation/sanitization belongs
  //   to display layers, not storage.
  //
  // Indexes:
  //
  // - (project_root, ts DESC). Both hot reads (`loadHistory` /
  //   reverse-search) filter by project_root and walk newest-first.
  //   Composite ordered DESC means SQLite scans the index forward
  //   instead of doing a sort step. AUTOINCREMENT id is implicitly
  //   covered by the PK index and serves as the deterministic
  //   tiebreaker in `ORDER BY ts DESC, id DESC` queries.
  //
  // No FK to sessions — history outlives any single session, and a
  // prompt submitted in session A is still relevant context for
  // session B inside the same project.
  sql: `
    CREATE TABLE repl_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      project_root TEXT    NOT NULL,
      prompt       TEXT    NOT NULL
    );

    CREATE INDEX repl_history_by_project_ts
      ON repl_history(project_root, ts DESC);
  `,
} as const;
