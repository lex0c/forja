// Skills subsystem audit table. Spec: SKILLS.md §0.7 + §14;
// RETRIEVAL.md §3.4.5.
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS TABLE EXISTS
//
// Skill CONTENT lives in markdown files (auditable via the filesystem
// + git). Skill EVENTS live here so an operator can answer "which
// skills did the model see, invoke, or have filtered out — when, in
// which session, from which cwd?".
//
// The load-bearing query is `surfaced` vs `invoked` per skill: a skill
// surfaced into many prompts but never invoked has a `description`
// that is not pulling. RETRIEVAL §3.4.5 names exactly this as the
// signal for tuning a skill's description against real use — without
// the audit trail there is nothing to tune against.
//
// Dedicated table, mirroring memory_events / hook_runs / eviction_
// events: one concern per table, append-only, session- and name-keyed
// for forensic queries.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA
//
// - id (TEXT PRIMARY KEY). UUID v4 from the repo. Not an INTEGER
//   auto-increment: audit rows can be inserted concurrently from
//   background subagent runs, and UUIDs avoid SQLite row-id
//   contention on the hot insert path. Mirrors memory_events.
//
// - scope (TEXT NOT NULL CHECK). The three v1 scopes (§3.1-3.3).
//   `imported` (§3.4) is v2 — deliberately absent from the CHECK so a
//   stray imported-scope row is rejected until that scope ships.
//
// - action (TEXT NOT NULL CHECK). The three v1 audit verbs (§0.7):
//   'surfaced' (skill entered the eager catalog), 'invoked' (the
//   model called skill_invoke on it), 'filtered' (skill dropped
//   during catalog resolution — malformed / name mismatch / shadowed).
//
// - skill_name (TEXT NOT NULL). The skill's canonical name — the
//   `<name>.md` filename stem. Joined here so audit queries filter by
//   skill without walking the filesystem. No path column: a skill may
//   be promoted across scopes during its lifetime, and (scope, name)
//   is the stable identity.
//
//   There is NO `source` column (unlike memory_events): skills have no
//   inferred-vs-explicit provenance axis in v1 — `scope` is the only
//   provenance the audit needs.
//
// - session_id (TEXT, nullable, FK ON DELETE SET NULL). The session
//   that triggered the event. Nullable because a future standalone
//   catalog inspector has no session. SET NULL on session purge keeps
//   the audit row alive — the history stays reachable via skill_name.
//
// - cwd (TEXT, nullable). Working directory at event time. Null
//   outside a session.
//
// - created_at (INTEGER NOT NULL). Epoch ms, Date.now()-shaped.
//
// - details (TEXT, nullable). JSON blob with action-specific extras:
//   the invocation outcome for 'invoked', the filter-reason payload
//   for 'filtered'. The repo serializes on write and parses on read;
//   consumers own the per-action shape.
//
// ────────────────────────────────────────────────────────────────────
// INDEXES
//
// - (session_id) WHERE NOT NULL — the hot read is "this session's
//   skill activity"; a partial index keeps it small while covering
//   the actual query.
// - (skill_name, created_at DESC) — "everything that happened to
//   skill X", recency-ordered so the natural LIMIT-N query is an
//   index scan.
//
// Mirrors memory_events' index pair exactly.

export const migration067SkillEvents = {
  id: 67,
  name: '067-skill-events',
  sql: `
    CREATE TABLE skill_events (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL
                  CHECK (scope IN ('user', 'project_local', 'project_shared')),
      action      TEXT NOT NULL
                  CHECK (action IN ('surfaced', 'invoked', 'filtered')),
      skill_name  TEXT NOT NULL,
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      cwd         TEXT,
      created_at  INTEGER NOT NULL,
      details     TEXT
    );

    CREATE INDEX idx_skill_events_session
      ON skill_events(session_id)
      WHERE session_id IS NOT NULL;

    CREATE INDEX idx_skill_events_name
      ON skill_events(skill_name, created_at DESC);
  `,
} as const;
