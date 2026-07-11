// Deterministic projection from session state → RecapMini.
// Cheap by design (target: <50ms per session per RECAP.md §3.1)
// because list views fan out N projections per page-load. Reads
// at most three rows + two counts, no full message scan.
//
// Sources:
//   - sessions row: id, status, startedAt, endedAt, costUsd, cwd
//   - count(messages) per role: drives `steps` (assistant turns)
//   - count(tool_calls) where tool_name in FILE_WRITER_TOOLS:
//     drives `filesChanged`
//   - first user message: drives `goal` and the deterministic
//     `oneLineSummary` template
//
// `hasErrors` is a single COUNT over `failure_events` filtered to
// `user_visible = 1` (RECAP §3.1: "true se sessão tem
// failure_events visíveis") — kept cheap to honour the <50ms list
// budget. `incomplete` is `status === 'running'`.

import { basename } from 'node:path';
import type { DB } from '../../storage/db.ts';
import { getSession } from '../../storage/repos/sessions.ts';
// File-writing tools, shared with projection.ts + the verify gate (one source).
import { FILE_WRITER_TOOLS } from '../../tools/file-writer-tools.ts';
import { RECAP_MINI_LIMITS, RECAP_MINI_SCHEMA_VERSION, type RecapMini } from './schema.ts';

// First user message content. Sessions almost always have at
// least one (the original prompt); the rare race where the
// projection runs before appendMessage just yields an empty
// string. Inline SQL — there's only one call site. Skips retracted
// (operator un-sent) turns so a cancelled first prompt can't become
// the mini goal / oneLineSummary or match `/recap list --search`
// (migration 079) — the same exclusion the full projection applies.
const firstUserMessageContent = (db: DB, sessionId: string): string => {
  const row = db
    .query<{ content: string }, [string]>(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND retracted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(sessionId);
  if (row === null) return '';
  try {
    const parsed = JSON.parse(row.content) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      // Tool-shaped content: pick first text block.
      for (const block of parsed) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          return (block as { text: string }).text;
        }
      }
    }
  } catch {
    // ignore malformed row; goal stays empty
  }
  return '';
};

const countAssistantMessages = (db: DB, sessionId: string): number => {
  const row = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND role = 'assistant'",
    )
    .get(sessionId);
  return row?.count ?? 0;
};

const countFileWrites = (db: DB, sessionId: string, toolNames: readonly string[]): number => {
  if (toolNames.length === 0) return 0;
  const placeholders = toolNames.map(() => '?').join(', ');
  const row = db
    .query<{ count: number }, (string | string)[]>(
      `SELECT COUNT(*) AS count FROM tool_calls
         WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)
           AND tool_name IN (${placeholders})`,
    )
    .get(sessionId, ...toolNames) as { count: number } | null;
  return row?.count ?? 0;
};

// User-visible failure count drives `hasErrors`. Indexed on
// session_id (migration 041), so this is a single cheap lookup —
// no row materialization, matching the projection's read budget.
const countUserVisibleFailures = (db: DB, sessionId: string): number => {
  const row = db
    .query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM failure_events WHERE session_id = ? AND user_visible = 1',
    )
    .get(sessionId);
  return row?.count ?? 0;
};

const firstLine = (s: string): string => {
  const idx = s.indexOf('\n');
  const head = idx === -1 ? s : s.slice(0, idx);
  return head.trim();
};

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
};

// Deterministic one-line summary, RECAP §3.1 spec literal:
// `"<status>: {N} steps, {M} files, {goal_truncated}"`.
const buildDeterministicOneLine = (
  status: string,
  steps: number,
  files: number,
  goal: string,
): string => {
  // Reserve ~30 chars for the prefix; truncate the goal to fit
  // the 120-char cap.
  const prefix = `${status}: ${steps} steps, ${files} files, `;
  const remaining = Math.max(10, RECAP_MINI_LIMITS.oneLineSummaryMaxChars - prefix.length);
  return `${prefix}${truncate(goal, remaining)}`.slice(0, RECAP_MINI_LIMITS.oneLineSummaryMaxChars);
};

export interface ProjectRecapMiniInput {
  sessionId: string;
  // Wall-clock for the projection. Used to compute durationMs
  // when the session is still running (endedAt === null);
  // otherwise endedAt - startedAt is authoritative.
  now?: number;
}

export const projectRecapMini = (db: DB, input: ProjectRecapMiniInput): RecapMini => {
  const session = getSession(db, input.sessionId);
  if (session === null) {
    throw new Error(`recap-mini: session ${input.sessionId} not found`);
  }
  const now = input.now ?? Date.now();

  const goalText = firstUserMessageContent(db, session.id);
  const goal = truncate(firstLine(goalText), RECAP_MINI_LIMITS.goalMaxChars);

  const steps = countAssistantMessages(db, session.id);
  const filesChanged = countFileWrites(db, session.id, [...FILE_WRITER_TOOLS]);

  const endedAt = session.endedAt;
  const durationMs = endedAt !== null ? endedAt - session.startedAt : now - session.startedAt;

  const cwdLabel = truncate(
    basename(session.cwd) || session.cwd,
    RECAP_MINI_LIMITS.cwdLabelMaxChars,
  );

  const incomplete = session.status === 'running';

  return {
    schemaVersion: RECAP_MINI_SCHEMA_VERSION,
    sessionId: session.id,
    goal,
    status: session.status,
    startedAt: session.startedAt,
    endedAt,
    durationMs: Math.max(0, durationMs),
    steps,
    costUsd: session.totalCostUsd,
    cwd: session.cwd,
    cwdLabel,
    oneLineSummary: buildDeterministicOneLine(session.status, steps, filesChanged, goal),
    filesChanged,
    hasErrors: countUserVisibleFailures(db, session.id) > 0,
    incomplete,
  };
};
