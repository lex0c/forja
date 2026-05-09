import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { canonicalJson } from '../json-safe.ts';

// RECAP.md §8.3 — read/write/key for the recap_cache table.
//
// The table caches LLM-rendered recap output. The deterministic
// projection / template path is fast (~10ms) and free, so it
// never goes through the cache; only the LLM render path does.
//
// Correctness contract:
//
//   1. Cache key is sha256 over (scope_kind, sorted session_ids,
//      renderer, prompt_version, sha256(canonicalize(intermediate))).
//      The content hash is the correctness leg — without it, an
//      active session would serve a stale render after new steps
//      land.
//   2. TTL is eviction, not correctness. Even within the TTL,
//      a content change produces a different scope_hash → miss.
//   3. Reads evict expired rows opportunistically before the miss
//      bubbles up; the dedicated purge job (future) is just an
//      optimization to keep the table small when reads are sparse.

export const DEFAULT_RECAP_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

export type RecapCacheRenderer = 'pr' | 'changelog' | 'slack' | 'terse' | 'human' | 'mini';

export interface RecapCacheKeyInput {
  scopeKind: string;
  sessionIds: readonly string[];
  renderer: RecapCacheRenderer;
  promptVersion: string;
  // The full RecapIntermediate value — projection output. Hashed
  // canonically so two structurally equal intermediates collapse
  // to the same key (insertion-order independence is required:
  // SQLite row order is not stable).
  intermediate: unknown;
}

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

// NUL byte separator, written as the \u0000 escape (not a literal
// 0x00 in the source). Most editors render a literal NUL as either
// a space or an empty cell, which makes the constant look like a
// typo and invites a "cleanup" that would silently break the hash:
// fields would concatenate without a delimiter, the key would
// collide across distinct inputs, and the cache would degrade
// (worst case: serve a wrong scope's render). The escape form is
// greppable and unambiguous.
const NUL = '\u0000';

// Volatile fields excluded from the hashed intermediate. Their
// values change every projection regardless of audit-log content
// (`generatedAt` is the wall-clock at projection time), which
// would otherwise force a cache miss on every call. The cache
// represents "what is in the audit log right now" — recording
// metadata about WHEN we last looked is the audit row's job, not
// the cache key's. Mutates a shallow copy; the input is not touched.
const VOLATILE_INTERMEDIATE_KEYS: ReadonlySet<string> = new Set(['generatedAt']);

const stripVolatile = (intermediate: unknown): unknown => {
  if (typeof intermediate !== 'object' || intermediate === null || Array.isArray(intermediate)) {
    return intermediate;
  }
  const obj = intermediate as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (VOLATILE_INTERMEDIATE_KEYS.has(key)) continue;
    out[key] = obj[key];
  }
  return out;
};

// Composes the cache key. The NUL separators prevent injection
// across fields (a session id of `'a' + NUL + 'b'` cannot collide
// with two real ids `'a','b'` because canonical JSON of an array
// would not produce that string). Sorting session_ids makes the
// key independent of the order in which the projection happened
// to list them — important for `day` / `range` scopes where the
// SQL ORDER BY can change without semantic effect.
export const canonicalScopeHash = (input: RecapCacheKeyInput): string => {
  const sortedIds = [...input.sessionIds].sort();
  const intermediateHash = sha256Hex(canonicalJson(stripVolatile(input.intermediate)));
  const composed = [
    input.scopeKind,
    sortedIds.join(NUL),
    input.renderer,
    input.promptVersion,
    intermediateHash,
  ].join(NUL);
  return sha256Hex(composed);
};

export interface RecapCacheEntry {
  scopeHash: string;
  renderer: RecapCacheRenderer;
  output: string;
  promptVersion: string;
  generatedAt: number;
  expiresAt: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

interface RecapCacheRow {
  scope_hash: string;
  renderer: string;
  output: string;
  prompt_version: string;
  generated_at: number;
  expires_at: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
}

const fromRow = (row: RecapCacheRow): RecapCacheEntry => ({
  scopeHash: row.scope_hash,
  renderer: row.renderer as RecapCacheRenderer,
  output: row.output,
  promptVersion: row.prompt_version,
  generatedAt: row.generated_at,
  expiresAt: row.expires_at,
  costUsd: row.cost_usd,
  tokensIn: row.tokens_in,
  tokensOut: row.tokens_out,
});

export interface ReadRecapCacheInput {
  scopeHash: string;
  now: number;
}

// Read-then-evict: if the row is expired we delete it inline and
// return null. This keeps the table from growing without bound in
// the absence of an explicit purge job, and aligns with the
// principle that an expired row is indistinguishable from a miss
// (we always re-render).
export const readRecapCache = (db: DB, input: ReadRecapCacheInput): RecapCacheEntry | null => {
  const row = db
    .query<RecapCacheRow, [string]>(
      `SELECT scope_hash, renderer, output, prompt_version, generated_at,
              expires_at, cost_usd, tokens_in, tokens_out
         FROM recap_cache WHERE scope_hash = ?`,
    )
    .get(input.scopeHash);
  if (row === null) return null;
  if (row.expires_at <= input.now) {
    db.query('DELETE FROM recap_cache WHERE scope_hash = ?').run(input.scopeHash);
    return null;
  }
  return fromRow(row);
};

export interface WriteRecapCacheInput {
  scopeHash: string;
  renderer: RecapCacheRenderer;
  output: string;
  promptVersion: string;
  generatedAt: number;
  ttlMs?: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

// INSERT OR REPLACE: a re-render that lands on the same key
// (same scope, same renderer, same prompt version, same content)
// is a re-write, not an error. This happens when two parallel
// `/recap pr` calls race past a cache miss — both render, both
// write; the second write wins. The result is identical (cache
// is content-keyed) so order does not matter.
export const writeRecapCache = (db: DB, input: WriteRecapCacheInput): RecapCacheEntry => {
  const ttlMs = input.ttlMs ?? DEFAULT_RECAP_CACHE_TTL_MS;
  const expiresAt = input.generatedAt + ttlMs;
  db.query(
    `INSERT OR REPLACE INTO recap_cache
       (scope_hash, renderer, output, prompt_version, generated_at,
        expires_at, cost_usd, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.scopeHash,
    input.renderer,
    input.output,
    input.promptVersion,
    input.generatedAt,
    expiresAt,
    input.costUsd,
    input.tokensIn,
    input.tokensOut,
  );
  return {
    scopeHash: input.scopeHash,
    renderer: input.renderer,
    output: input.output,
    promptVersion: input.promptVersion,
    generatedAt: input.generatedAt,
    expiresAt,
    costUsd: input.costUsd,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
  };
};

// Background purge: deletes all expired rows. Returns the number
// of rows removed so a caller (cron, periodic hook) can log it.
// Not invoked by readRecapCache — that does inline eviction of
// the single row it touched. This helper is for scheduled cleanup.
export const purgeExpiredRecapCache = (db: DB, now: number): number => {
  const result = db.query('DELETE FROM recap_cache WHERE expires_at <= ?').run(now);
  return Number(result.changes);
};

// `recap_mini` rows live in the same `recap_cache` table per
// RECAP §3.1 ("cacheado em recap_cache, TTL 1h"). The `output`
// column holds the JSON of `RecapMini` (not markdown); renderer
// label is `'mini'`. Recomputing a full RecapIntermediate just
// to derive the cache key would defeat the purpose (recap_mini
// exists to be CHEAPER than the full projection), so the key is
// hashed from session-immutable identity + status + endedAt +
// costUsd. Two projections with the same triple collide — which
// is correct, since the deterministic projection is a function
// of those.

export interface RecapMiniCacheKeyInput {
  sessionId: string;
  status: string;
  endedAt: number | null;
  costUsd: number;
  promptVersion: string;
}

export const recapMiniCacheKey = (input: RecapMiniCacheKeyInput): string =>
  sha256Hex(
    [
      'mini',
      input.sessionId,
      input.status,
      input.endedAt === null ? 'null' : String(input.endedAt),
      input.costUsd.toString(),
      input.promptVersion,
    ].join(NUL),
  );
