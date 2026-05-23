import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';

// `prompt_versions` repo — append-only, content-addressed registry
// of every system prompt and playbook variant ever materialized.
// Spec: AUDIT.md §1.3.
//
// Write path is `INSERT OR IGNORE` (idempotent by hash): the same
// content re-recorded across boots, sessions, and hosts collapses
// to a single row, and the first recorder's metadata (author,
// created_at, source_commit) wins. Read path returns the canonical
// row for a given hash, or the (name)-keyed history newest-first.

export type PromptKind = 'system' | 'playbook' | 'workflow_section';

export interface PromptVersion {
  hash: string;
  kind: PromptKind;
  name: string;
  content: string;
  parentHash: string | null;
  author: string;
  createdAt: number;
  sourceCommit: string | null;
  evalRunId: string | null;
  notes: string | null;
}

interface PromptVersionRow {
  hash: string;
  kind: PromptKind;
  name: string;
  content: string;
  parent_hash: string | null;
  author: string;
  created_at: number;
  source_commit: string | null;
  eval_run_id: string | null;
  notes: string | null;
}

const fromRow = (row: PromptVersionRow): PromptVersion => ({
  hash: row.hash,
  kind: row.kind,
  name: row.name,
  content: row.content,
  parentHash: row.parent_hash,
  author: row.author,
  createdAt: row.created_at,
  sourceCommit: row.source_commit,
  evalRunId: row.eval_run_id,
  notes: row.notes,
});

const SELECT_COLS =
  'hash, kind, name, content, parent_hash, author, created_at, ' +
  'source_commit, eval_run_id, notes';

// Canonical hash per §1.3.3: SHA256 of the prompt content as the
// model will see it, hex-encoded. "Canonical" here means the
// already-assembled prompt string — the composer chain in
// `bootstrap.ts` is what defines canonicalization (section order,
// separators, the date in the environment block); this helper
// hashes whatever bytes that produces. The hex form matches the
// pattern already used by `memory-provenance.hashMemoryContent`.
export const hashPromptContent = (content: string): string =>
  createHash('sha256').update(content, 'utf-8').digest('hex');

// Best-effort author resolution per §1.3.8: try `git config
// user.email` first, fall back to the OS user, and last to `'ci'`
// for unconfigured CI runners. NEVER throws — the prompt itself is
// the load-bearing data; author is provenance the operator can lose
// without breaking the registry.
//
// Memoized for the lifetime of the process: the git config and the
// OS-user env vars don't change mid-run, and `execSync` blocks the
// event loop ~5-50ms per call. With one bootstrap + N subagent
// spawns per session, the memoization drops the cost to one call
// instead of (1 + N). `INSERT OR IGNORE` then discards the value
// on idempotent collisions anyway — preserving the first
// recorder's author per §1.3.3.
//
// Windows `USERNAME` is in the env fallback chain (it's the
// canonical user-id var on Windows; `USER`/`LOGNAME` are POSIX).
let cachedAuthor: string | undefined;

export const resolveAuthor = (): string => {
  if (cachedAuthor !== undefined) return cachedAuthor;
  try {
    const out = execSync('git config user.email', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out.length > 0) {
      cachedAuthor = out;
      return cachedAuthor;
    }
  } catch {
    // git absent, no config, or any other failure — fall through.
  }
  cachedAuthor = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? 'ci';
  return cachedAuthor;
};

export interface RecordPromptVersionInput {
  hash: string;
  kind: PromptKind;
  name: string;
  content: string;
  parentHash?: string | null;
  author: string;
  createdAt?: number;
  sourceCommit?: string | null;
  evalRunId?: string | null;
  notes?: string | null;
}

// Insert a new prompt version, or no-op when a row with the same
// hash already exists. Returns the canonical row either way so the
// caller never has to branch on inserted-vs-existed.
//
// `INSERT OR IGNORE` is the idempotency primitive (§1.3.3 step 3):
// the same content re-recorded across boots, sessions, and hosts
// dedupes to the original row — preserving the original `author` /
// `created_at` / `source_commit` (the first recorder wins, by
// design; later recorders just attest the same content existed).
export const recordPromptVersion = (db: DB, input: RecordPromptVersionInput): PromptVersion => {
  const createdAt = input.createdAt ?? Date.now();
  const parentHash = input.parentHash ?? null;
  const sourceCommit = input.sourceCommit ?? null;
  const evalRunId = input.evalRunId ?? null;
  const notes = input.notes ?? null;
  db.query(
    `INSERT OR IGNORE INTO prompt_versions
       (hash, kind, name, content, parent_hash, author,
        created_at, source_commit, eval_run_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.hash,
    input.kind,
    input.name,
    input.content,
    parentHash,
    input.author,
    createdAt,
    sourceCommit,
    evalRunId,
    notes,
  );
  const row = db
    .query<PromptVersionRow, [string]>(`SELECT ${SELECT_COLS} FROM prompt_versions WHERE hash = ?`)
    .get(input.hash);
  if (row === null) {
    // The INSERT-OR-IGNORE branch above either inserted the row or
    // collided with an existing one; the row MUST be present. A
    // null here means a concurrent DELETE, which §1.3.4 forbids.
    // Surface loudly rather than fabricate.
    throw new Error(`prompt_versions: row vanished after upsert (hash=${input.hash})`);
  }
  return fromRow(row);
};

// Look up a previously-recorded prompt version by hash. Null when
// the hash is unknown locally — usually means the row was recorded
// on a different host and never replicated here. Callers that need
// a row must `recordPromptVersion` with the content first.
export const getPromptVersion = (db: DB, hash: string): PromptVersion | null => {
  const row = db
    .query<PromptVersionRow, [string]>(`SELECT ${SELECT_COLS} FROM prompt_versions WHERE hash = ?`)
    .get(hash);
  return row !== null ? fromRow(row) : null;
};

// History of a named prompt — most recent first. Default limit of
// 50 covers the CLI `agent audit prompts list` (§1.3.6) without
// paginating in the common case; callers needing more pass `limit`.
export const listPromptVersionsByName = (db: DB, name: string, limit = 50): PromptVersion[] => {
  const rows = db
    .query<PromptVersionRow, [string, number]>(
      `SELECT ${SELECT_COLS} FROM prompt_versions
         WHERE name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(name, limit);
  return rows.map(fromRow);
};
