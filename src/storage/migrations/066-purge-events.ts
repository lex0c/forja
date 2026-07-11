// purge_events — append-only ledger of `forja purge --force`
// invocations. Spec: AGENTIC_CLI.md §2.1.2, AUDIT.md §1.
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS TABLE EXISTS
//
// `forja purge` removes everything under <repoRoot>/.forja/ (configs,
// memory, bg logs, operator-edited playbooks). Without an audit row,
// the only post-purge evidence is "the directory is gone" — an
// operator cannot reconstruct "what was here before I purged?" and
// compliance cannot answer "when was project X reset and by which
// install identity?".
//
// approvals_log is the wrong home: it ledgers permission engine
// decisions (`tool_name`, `decision`, `args_hash`, hash chain) and
// requires a `session_id`. Purge fires OUTSIDE any session, with no
// "tool call" semantics. Forcing a synthetic session+tool entry would
// poison the chain shape and break replay invariants.
//
// failure_events is also wrong: purge is a successful operator-fired
// reset, not a failure to classify.
//
// Dedicated table mirrors the pattern of every other event-log in
// Forja (memory_events, hook_runs, eviction_events, outcomes): one
// concern per table, append-only, project-keyed for forensic queries.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - `id` (INTEGER PRIMARY KEY AUTOINCREMENT). Local sequence per
//   install. Surfaces in dry-run JSON as `audit_id` after a force
//   write so the operator can correlate stdout against the DB row.
//
// - `ts` (INTEGER NOT NULL CHECK > 0). Epoch ms at confirmation
//   time. Constraint matches the convention used across the audit
//   schema (`approvals_log.ts`, `eviction_events.recorded_at`).
//
// - `install_id` (TEXT NOT NULL). Identity from
//   ~/.local/share/forja/install_id. Allows multi-install forensics
//   ("which install ran the purge?") and ties the purge to the same
//   identity that owns the approvals_log genesis hash.
//
// - `cwd` (TEXT NOT NULL). Canonical repoRoot resolved via
//   `git rev-parse --show-toplevel` (memory/paths.ts:resolveRepoRoot).
//   NOT the operator's invocation cwd — always the repo root so
//   `forja purge` from `<repo>/src/` and from `<repo>/` record the
//   same `cwd` row. Indexed for "show purge history for project X"
//   queries.
//
// - `artifacts_present_json` (TEXT NOT NULL). Canonical-JSON array
//   of absolute paths enumerated pre-purge. Single source of truth
//   for "what existed before the operator confirmed?" — the dry-run
//   render uses this same list. Schema is `string[]` for v1; if
//   future slices need per-path bytes/kind, this becomes
//   `Array<{path,size,kind}>` and old readers tolerate the broadened
//   shape (JSON, not typed columns).
//
// - `bytes_present` (INTEGER NOT NULL CHECK >= 0). Sum of
//   `lstat.size` across every file enumerated PRE-purge (symlink
//   size is the link target string length per POSIX, not the
//   dereferenced target — fine for the "how much was here"
//   question). Snapshot, NOT post-removal: a race where another
//   process adds/removes files between snapshot and removal yields
//   real-removal counts that differ from this row. The audit row
//   is the operator-confirmed plan, not the after-action report.
//
// - `files_present` / `dirs_present` (INTEGER NOT NULL CHECK >= 0).
//   Separate counts because symlink entries count as files (not
//   dirs) even when the link target is a directory — we never
//   followed it. Same snapshot semantics as `bytes_present`.
//   `dirs_present` does NOT include the `.forja/` root itself —
//   only the children walked into it.
//
// - `forja_version` (TEXT NOT NULL). VERSION string at purge time.
//   Lets a future bisect ("which version started purging
//   `.forja/playbooks/` aggressively?") work without a schema bump.
//
// ────────────────────────────────────────────────────────────────────
// INDEXES
//
// - `(cwd, ts)` — primary forensic query: "history of purges for
//   project X, most recent first". Single seek; ordering native.
//
// ────────────────────────────────────────────────────────────────────
// LIFECYCLE
//
// Append-only by contract. Retention 365d (par with approvals_log,
// per AUDIT.md §1.2). No UPDATE surface, no DELETE outside the
// retention sweep (which is separate from this migration).
//
// No hash chain: purge is an operational event, not a policy
// decision that needs replay. The approvals_log chain endures for
// the install identity; purge_events lives parallel as a lightweight
// reset log.

export const migration066PurgeEvents = {
  id: 66,
  name: '066-purge-events',
  sql: `
    CREATE TABLE purge_events (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                      INTEGER NOT NULL CHECK (ts > 0),
      install_id              TEXT NOT NULL,
      cwd                     TEXT NOT NULL,
      artifacts_present_json  TEXT NOT NULL,
      bytes_present           INTEGER NOT NULL CHECK (bytes_present >= 0),
      files_present           INTEGER NOT NULL CHECK (files_present >= 0),
      dirs_present            INTEGER NOT NULL CHECK (dirs_present >= 0),
      forja_version           TEXT NOT NULL
    );

    CREATE INDEX idx_purge_events_cwd_ts
      ON purge_events(cwd, ts);
  `,
} as const;
