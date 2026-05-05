export const migration019HookRuns = {
  id: 19,
  name: '019-hook-runs',
  // M3 / hooks subsystem audit table.
  //
  // Spec AGENTIC_CLI.md §10.3 line 1006: "Logging: cada execução
  // grava em tabela `hook_runs` (auditoria)". Without this table,
  // a hook that silently ate a tool call leaves no trace — the
  // operator sees "tool denied" with no idea which hook denied
  // it or what it returned.
  //
  // One row per dispatched hook, written by the dispatcher
  // regardless of outcome (allow / block / error / timeout).
  //
  // Schema rationale:
  //
  // - id (TEXT PK). UUID v4. Same rationale as memory_events:
  //   audit rows can land concurrently from a multi-step hook
  //   chain across distinct subsystems.
  //
  // - session_id (TEXT, nullable, FK SET NULL). Same shape as
  //   memory_events. Hooks fire DURING a session typically, but
  //   `SessionStart` runs before the harness fully constructs
  //   the session id — null is the right marker there.
  //
  // - event (TEXT NOT NULL CHECK). The 9-event union from spec
  //   §10.1. Closed list under CHECK so an operator-driven INSERT
  //   (importing from a backup, replay tool) is gated.
  //
  // - layer (TEXT NOT NULL CHECK). Source layer of the hook
  //   spec — enterprise / user / project. Mirrors the
  //   permissions hierarchy semantics. Audit consumers filter
  //   by layer to triage "is this corp policy or operator
  //   custom?".
  //
  // - source_path (TEXT NOT NULL). Absolute path of the
  //   hooks.toml file that declared this hook. Forensic value:
  //   "which hook config emitted this row?" — answers without
  //   re-loading the config from disk (which may have changed
  //   since the row was written).
  //
  // - hook_index (INTEGER NOT NULL). Position of the hook within
  //   the originating layer's hook list. Together with
  //   source_path, this is enough to identify the exact spec
  //   that ran. Useful when the same hooks.toml has multiple
  //   `[[hooks]]` for the same event.
  //
  // - command (TEXT NOT NULL). Pre-expansion command literal
  //   (with `{{...}}` placeholders). Pairs with `expanded`
  //   below: forensic readers see both the operator's intent
  //   and what actually ran.
  //
  // - expanded (TEXT NOT NULL). Post-template-expansion command
  //   that ran via `sh -c`. Quoted values land here verbatim;
  //   reader can replay the command as-is.
  //
  // - exit_code (INTEGER, nullable). Process exit code per
  //   CONTRACTS.md §3 line 725. For timeout outcomes the
  //   dispatcher writes 124 (POSIX `timeout(1)` convention)
  //   rather than the killed-process's signal-derived code
  //   (143/137) since those don't carry decision semantics.
  //   Null is reserved for future events that have no exit
  //   code at all (none today).
  //
  // - outcome (TEXT NOT NULL CHECK). Discriminated decision the
  //   dispatcher derived from exit_code + event:
  //     allow         — exit 0, target operation continues
  //     block_silent  — exit 1
  //     block_message — exit 2 (stdout becomes the reason)
  //     error         — exit > 2 (target continues unless
  //                     fail_closed=true)
  //     timeout       — process killed
  //   The decision the SUBSYSTEM acted on lives implicitly here
  //   — caller knows whether it was a blockable event from the
  //   event field (BLOCKING_EVENTS set in types.ts).
  //
  // - duration_ms (INTEGER NOT NULL). Wall-clock time from
  //   spawn to exit. Zero is valid (instant exits are common).
  //
  // - stdout (TEXT, nullable). Truncated to 4KB per spec §10.3
  //   line 719 BEFORE storage so the table doesn't bloat with
  //   chatty hooks. Null when the hook produced no stdout
  //   (distinguish from empty string for the audit reader).
  //
  // - stderr (TEXT, nullable). Same truncation rule. Null when
  //   absent. Stderr doesn't drive decisions but is invaluable
  //   for debugging "why did my hook fail?" without needing
  //   live tooling.
  //
  // - matched_tool (TEXT, nullable). For `PreToolUse` /
  //   `PostToolUse` only — the tool name the matcher matched
  //   against. Null for non-tool events. Lets `/hooks audit`
  //   group "every hook that ever fired against `bash`".
  //
  // - created_at (INTEGER NOT NULL). Epoch ms.
  //
  // Indexes:
  //
  // - (session_id, created_at DESC) WHERE NOT NULL. Hot read:
  //   "show me hook runs in the current session" — partial
  //   index keeps the size small.
  //
  // - (event, created_at DESC). For dashboards / forensic
  //   queries cross-session ("how many PreToolUse blocks
  //   happened this week?").
  sql: `
    CREATE TABLE hook_runs (
      id            TEXT PRIMARY KEY,
      session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      event         TEXT NOT NULL
                    CHECK (event IN (
                      'SessionStart', 'UserPromptSubmit', 'PreToolUse',
                      'PostToolUse', 'PreCompact', 'Notification',
                      'PreCheckpoint', 'MemoryWrite', 'Stop'
                    )),
      layer         TEXT NOT NULL
                    CHECK (layer IN ('enterprise', 'user', 'project')),
      source_path   TEXT NOT NULL,
      hook_index    INTEGER NOT NULL,
      command       TEXT NOT NULL,
      expanded      TEXT NOT NULL,
      exit_code     INTEGER,
      outcome       TEXT NOT NULL
                    CHECK (outcome IN (
                      'allow', 'block_silent', 'block_message',
                      'error', 'timeout'
                    )),
      duration_ms   INTEGER NOT NULL,
      stdout        TEXT,
      stderr        TEXT,
      matched_tool  TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX idx_hook_runs_session
      ON hook_runs(session_id, created_at DESC)
      WHERE session_id IS NOT NULL;

    CREATE INDEX idx_hook_runs_event
      ON hook_runs(event, created_at DESC);
  `,
} as const;
