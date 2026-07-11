// Migration 068: `prompt_versions` table + per-row `prompt_hash`
// columns on `messages` and `tool_calls`. Spec: AUDIT.md §1.3.
//
// ────────────────────────────────────────────────────────────────────
// WHY THIS TABLE EXISTS
//
// CONTEXT_TUNING §1.8.5 makes regression-eval of the system prompt
// a hard pre-ship gate, and AUDIT §1.3.7 pins `prompt_hash` as the
// input dimension of that eval: every behavioral outcome is keyed
// by the prompt version that produced it. Without this table,
// prompt changes ship unmeasured and a quality regression is
// untraceable back to a commit — the exact failure mode AUDIT §1.3
// preamble names (the 2026 Anthropic leak).
//
// Content-addressed by `SHA256(canonical(content))` so identical
// prompts dedupe to a single row across sessions, reboots, and
// hosts. Forever retention per AUDIT §4.1 — without the historical
// content a past hash is unjoinable.
//
// ────────────────────────────────────────────────────────────────────
// SCHEMA (column-for-column with §1.3.1)
//
// - hash          PK, SHA256 hex of the canonicalized content; the
//                 join key for `messages.prompt_hash` and
//                 `tool_calls.prompt_hash`.
// - kind          'system' | 'playbook' | 'workflow_section'. CHECK
//                 pins the v1 vocabulary; a fourth kind requires a
//                 follow-up migration that also widens the producer.
// - name          Logical identity within `kind` — e.g.,
//                 'system.autonomous', 'playbook.code-review'. The
//                 (name, created_at) index covers the "history of
//                 this prompt" query (§1.3.5).
// - content       Prompt literal, no redaction (§1.3 preamble:
//                 content IS the point of the table).
// - parent_hash   Soft pointer to the prior version sharing the
//                 same `name`; nullable for the genesis row of a
//                 name. No SQL FK because the prior row may have
//                 been inserted from a different host and is not
//                 guaranteed to exist locally.
// - author        Git `user.email` that materialized this version,
//                 best-effort. Falls back to `'ci'` when the session
//                 runs without a configured git user (§1.3.8).
// - created_at    Epoch ms, Date.now()-shaped — consistent with
//                 every other audit table.
// - source_commit Git sha that introduced this version, nullable
//                 when materialized ad-hoc outside a commit.
// - eval_run_id   Soft FK to the eval run that validated this
//                 version (§1.3.7); nullable until the eval pipeline
//                 ships (deliverables B + C of this milestone).
// - notes         One-line changelog free-text; nullable.
//
// Append-only forever (§1.3.4 / §4.1): no UPDATE, no DELETE. A
// tampered row is detectable as a chain break (§4.2).
//
// ────────────────────────────────────────────────────────────────────
// PER-ROW REFERENCES (§1.3.2)
//
// `messages.prompt_hash` and `tool_calls.prompt_hash` are nullable
// TEXT columns — soft FKs into `prompt_versions(hash)`. Nullable
// because rows persisted before this migration carry no hash, and
// because the producer in the harness loop populates them best-
// effort (a missing hash MUST NOT break a write). The §1.3.5
// canonical queries join on these columns.
//
// No SQL FK constraint: the join is by content-hash equality, not
// by referential integrity — a `prompt_versions` row CAN be moved
// across hosts and the join still works as long as the hash matches.

export const migration068PromptVersions = {
  id: 68,
  name: '068-prompt-versions',
  sql: `
    CREATE TABLE prompt_versions (
      hash           TEXT PRIMARY KEY,
      kind           TEXT NOT NULL
                       CHECK (kind IN ('system', 'playbook', 'workflow_section')),
      name           TEXT NOT NULL,
      content        TEXT NOT NULL,
      parent_hash    TEXT,
      author         TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      source_commit  TEXT,
      eval_run_id    TEXT,
      notes          TEXT
    );

    CREATE INDEX idx_prompt_versions_name ON prompt_versions(name, created_at);

    ALTER TABLE messages ADD COLUMN prompt_hash TEXT;
    ALTER TABLE tool_calls ADD COLUMN prompt_hash TEXT;
  `,
} as const;
