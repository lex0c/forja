import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectDirName } from '../config/app-namespace.ts';
import type { DB } from './db.ts';

// HISTORY.md §1.3 — default cap, env-overridable. Read once at
// module load so a mid-session change doesn't retroactively trim
// past inserts; matches the spec's "read no boot" wording.
export const HISTORY_CAP_DEFAULT = 10_000;

const parseCapEnv = (): number => {
  const raw = process.env.FORJA_HISTORY_SIZE;
  if (!raw) return HISTORY_CAP_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : HISTORY_CAP_DEFAULT;
};

export const HISTORY_CAP = parseCapEnv();

// HISTORY.md §3.3 — three-level opt-out. The session-volatile
// `/history off` is enforced by the REPL (it never calls into
// here); env + file marker are storage-layer concerns because
// they should be honored by every caller — slash commands,
// future tooling, anything that imports this module.
//
// Returns the discriminator so callers (REPL boot, `/history on`)
// can surface a precise reason instead of a generic "disabled" cue.
// `null` = persistence is on for this project.
export type HistoryOptOutReason = 'env' | 'file-marker';

export const historyOptOutReason = (projectRoot: string): HistoryOptOutReason | null => {
  if (process.env.FORJA_NO_HISTORY === '1') return 'env';
  if (existsSync(resolve(projectRoot, projectDirName(), 'no-history'))) return 'file-marker';
  return null;
};

const isHistoryDisabled = (projectRoot: string): boolean =>
  historyOptOutReason(projectRoot) !== null;

export interface AppendHistoryOptions {
  // Test seam: override the cap without touching env. Production
  // callers omit it and inherit HISTORY_CAP from module scope.
  cap?: number;
  // Test seam: pin the timestamp instead of Date.now(). Lets
  // tests assert ordering without sleeping between inserts.
  ts?: number;
}

// Insert one prompt, with dup-of-last suppression and trim.
//
// - Suppression: if the most recent row for this project_root
//   has the same `prompt`, no-op. Reduces ruído pra submits
//   gêmeos (operator presses Enter twice on the same buffer).
//   Compares against the row in storage, not a process-local
//   cache, so the suppression is correct even across REPL
//   restarts within the same project.
//
// - Trim: after insert, if total rows for this project exceed
//   the cap, delete the oldest until back at cap. Cap enforcement
//   on append (HISTORY.md §1.3) keeps load on the hot path
//   index-only.
//
// The whole flow runs under a single SQLite transaction so a
// concurrent writer can't observe an over-cap intermediate state.
//
// Returns true if a row was inserted, false if suppressed (dup-of-last) or
// history is disabled — the hard-abort un-send uses this to remove only the
// entries a submit actually created (a suppressed dup created none).
export const appendHistory = (
  db: DB,
  projectRoot: string,
  prompt: string,
  options: AppendHistoryOptions = {},
): boolean => {
  if (isHistoryDisabled(projectRoot)) return false;
  const cap = options.cap ?? HISTORY_CAP;
  const ts = options.ts ?? Date.now();

  return db.transaction(() => {
    const last = db
      .query(
        `SELECT prompt FROM repl_history
         WHERE project_root = ?
         ORDER BY ts DESC, id DESC
         LIMIT 1`,
      )
      .get(projectRoot) as { prompt: string } | null;
    if (last !== null && last.prompt === prompt) return false;

    db.query(
      `INSERT INTO repl_history (ts, project_root, prompt)
       VALUES (?, ?, ?)`,
    ).run(ts, projectRoot, prompt);

    const total = (
      db
        .query('SELECT COUNT(*) AS n FROM repl_history WHERE project_root = ?')
        .get(projectRoot) as { n: number }
    ).n;
    if (total > cap) {
      // Drop the oldest (total - cap) rows. Composite index keeps
      // this an index walk; the DELETE clause names the rowids it
      // selected to avoid a second filter pass.
      db.query(
        `DELETE FROM repl_history WHERE id IN (
           SELECT id FROM repl_history
           WHERE project_root = ?
           ORDER BY ts ASC, id ASC
           LIMIT ?
         )`,
      ).run(projectRoot, total - cap);
    }
    return true;
  })();
};

// Load up to `limit` most-recent prompts, returned oldest-first
// so the caller can map index 0 → first ↑ press, last → newest.
//
// Also no-op (returns []) when history is disabled — operator
// who turned off persistence shouldn't see entries from before
// the toggle. countHistory and clearHistory stay live because
// they answer "is there anything to clean up?" and "wipe it",
// both of which the operator may want even after disabling.
export const loadHistory = (db: DB, projectRoot: string, limit: number = HISTORY_CAP): string[] => {
  if (isHistoryDisabled(projectRoot)) return [];
  if (limit <= 0) return [];
  const rows = db
    .query(
      `SELECT prompt FROM (
         SELECT prompt, ts, id FROM repl_history
         WHERE project_root = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?
       )
       ORDER BY ts ASC, id ASC`,
    )
    .all(projectRoot, limit) as { prompt: string }[];
  return rows.map((r) => r.prompt);
};

// Substring search for Ctrl+R. Case-insensitive, ordered newest
// first so repeated Ctrl+R cycles to older matches naturally.
//
// Implemented in SQL (LIKE) rather than JS so the index helps
// us narrow by project_root before the full scan; the LIKE
// itself is a linear pass on the matching subset, which fits
// the cap (≤ 10k rows) well within frame budget.
export const searchHistory = (
  db: DB,
  projectRoot: string,
  query: string,
  limit = 100,
): string[] => {
  if (isHistoryDisabled(projectRoot)) return [];
  if (query === '') return [];
  // Escape LIKE wildcards in the user-typed query so a literal
  // `%` or `_` matches itself, not "anything".
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  const rows = db
    .query(
      `SELECT prompt FROM repl_history
       WHERE project_root = ?
         AND prompt LIKE ? ESCAPE '\\' COLLATE NOCASE
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
    )
    .all(projectRoot, pattern, limit) as { prompt: string }[];
  return rows.map((r) => r.prompt);
};

export const clearHistory = (db: DB, projectRoot: string): void => {
  db.query('DELETE FROM repl_history WHERE project_root = ?').run(projectRoot);
};

// Remove the most-recent history row for this project IF it still matches
// `prompt`. Used by the hard-abort un-send: the operator retracted the prompt
// they just sent, so it must stop resurfacing via ↑/↓, Ctrl+R, and /history,
// the same way it leaves the conversation. Matches on the tail's content (not a
// blind "delete last") so a race that recorded a newer entry leaves history
// untouched — we only ever drop the exact row `recordHistorySubmit` just added.
// No-op (returns false) when history is disabled, empty, or the tail differs.
export const deleteLastHistoryIfMatches = (
  db: DB,
  projectRoot: string,
  prompt: string,
): boolean => {
  if (isHistoryDisabled(projectRoot)) return false;
  return db.transaction(() => {
    const last = db
      .query(
        `SELECT id, prompt FROM repl_history
         WHERE project_root = ?
         ORDER BY ts DESC, id DESC
         LIMIT 1`,
      )
      .get(projectRoot) as { id: number; prompt: string } | null;
    if (last === null || last.prompt !== prompt) return false;
    db.query('DELETE FROM repl_history WHERE id = ?').run(last.id);
    return true;
  })();
};

export const countHistory = (db: DB, projectRoot: string): number => {
  return (
    db.query('SELECT COUNT(*) AS n FROM repl_history WHERE project_root = ?').get(projectRoot) as {
      n: number;
    }
  ).n;
};
