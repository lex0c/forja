import type { DB } from '../db.ts';
import { parseJsonObject } from '../json-safe.ts';

// Repo for `skill_events` (migration 067). Audit-only — skill content
// lives in markdown files, not here. Answers "which skills did the
// model see, invoke, or have filtered out — when, in which session?"
// (spec SKILLS.md §0.7, RETRIEVAL.md §3.4.5).
//
// Three actions:
//   - surfaced — the skill entered the eager catalog at boot.
//   - invoked  — the model called skill_invoke on it.
//   - filtered — the skill was dropped during catalog resolution
//                (malformed / name-mismatched / shadowed).
// Correlating `surfaced` against `invoked` per skill is what lets an
// operator tune a skill's `description`: surfaced-often-but-never-
// invoked means the description is not pulling.
//
// Unlike memory_events there is no `source` column — skills have no
// inferred-vs-explicit provenance axis in v1; `scope` is the only
// provenance the audit needs.

export type SkillEventScope = 'user' | 'project_local' | 'project_shared';
export type SkillEventAction = 'surfaced' | 'invoked' | 'filtered';

export interface SkillEvent {
  id: string;
  scope: SkillEventScope;
  action: SkillEventAction;
  skillName: string;
  sessionId: string | null;
  cwd: string | null;
  createdAt: number;
  // Action-specific extras. The repo neither validates nor interprets
  // the shape; consumers own the per-action contract. Returned as
  // null when the row had no details OR when the persisted JSON was
  // malformed — callers needing to distinguish "absent" from
  // "corrupted" should query the raw column directly.
  details: Record<string, unknown> | null;
}

interface SkillEventRow {
  id: string;
  scope: SkillEventScope;
  action: SkillEventAction;
  skill_name: string;
  session_id: string | null;
  cwd: string | null;
  created_at: number;
  details: string | null;
}

const fromRow = (row: SkillEventRow): SkillEvent => ({
  id: row.id,
  scope: row.scope,
  action: row.action,
  skillName: row.skill_name,
  sessionId: row.session_id,
  cwd: row.cwd,
  createdAt: row.created_at,
  // `parseJsonObject` swallows a corrupt `details` blob to null —
  // storage corruption must not crash an audit listing.
  details: parseJsonObject(row.details),
});

export interface CreateSkillEventInput {
  // Optional: caller may supply an id when batching from a
  // deterministic source. Defaults to a fresh UUID.
  id?: string;
  scope: SkillEventScope;
  action: SkillEventAction;
  skillName: string;
  sessionId?: string | null;
  cwd?: string | null;
  createdAt?: number;
  details?: Record<string, unknown> | null;
}

export const createSkillEvent = (db: DB, input: CreateSkillEventInput): SkillEvent => {
  const id = input.id ?? crypto.randomUUID();
  const sessionId = input.sessionId ?? null;
  const cwd = input.cwd ?? null;
  const createdAt = input.createdAt ?? Date.now();
  const details = input.details ?? null;
  const detailsJson = details === null ? null : JSON.stringify(details);
  db.query(
    `INSERT INTO skill_events
       (id, scope, action, skill_name, session_id, cwd, created_at, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.scope, input.action, input.skillName, sessionId, cwd, createdAt, detailsJson);
  return {
    id,
    scope: input.scope,
    action: input.action,
    skillName: input.skillName,
    sessionId,
    cwd,
    createdAt,
    details,
  };
};

// Audit feed for one session. Chronological (created_at ASC, id ASC
// as a stable tiebreak) so a timeline view doesn't shuffle on equal
// timestamps. Covered by the partial index on (session_id). Rows
// whose session was purged keep the row (FK SET NULL) but drop out
// of this filter — reach them via listSkillEventsByName.
export const listSkillEventsBySession = (db: DB, sessionId: string): SkillEvent[] => {
  const rows = db
    .query<SkillEventRow, [string]>(
      `SELECT id, scope, action, skill_name, session_id, cwd, created_at, details
         FROM skill_events
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

// History of one skill across its full lifetime, most-recent first
// (matching the composite index direction) so a caller can LIMIT N
// for the latest activity.
export const listSkillEventsByName = (db: DB, skillName: string, limit?: number): SkillEvent[] => {
  if (limit !== undefined) {
    const rows = db
      .query<SkillEventRow, [string, number]>(
        `SELECT id, scope, action, skill_name, session_id, cwd, created_at, details
           FROM skill_events
          WHERE skill_name = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(skillName, limit);
    return rows.map(fromRow);
  }
  const rows = db
    .query<SkillEventRow, [string]>(
      `SELECT id, scope, action, skill_name, session_id, cwd, created_at, details
         FROM skill_events
        WHERE skill_name = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(skillName);
  return rows.map(fromRow);
};

// Recent skill events, no name/session filter — the "what happened
// lately" feed across the whole table. Most-recent first, capped by
// `limit` (default 50).
export const listRecentSkillEvents = (db: DB, limit = 50): SkillEvent[] => {
  const rows = db
    .query<SkillEventRow, [number]>(
      `SELECT id, scope, action, skill_name, session_id, cwd, created_at, details
         FROM skill_events
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map(fromRow);
};
