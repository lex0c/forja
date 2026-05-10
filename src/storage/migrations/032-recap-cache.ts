export const migration032RecapCache = {
  id: 32,
  name: '032-recap-cache',
  // RECAP.md §8.3 — cache for LLM-rendered recap output.
  //
  // The deterministic projection path is fast (~10ms for a typical
  // session) and free; the cache exists only for the LLM render
  // path, which costs a Haiku call (~$0.001, ~1.5s wall-clock).
  // Hitting the cache replaces both the cost and the latency with a
  // single SQL read.
  //
  // Schema rationale:
  // - scope_hash (TEXT PK). sha256 over scope_kind, sorted
  //   session_ids, renderer, prompt_version, AND a content hash of
  //   the canonical RecapIntermediate. The content hash is the
  //   correctness leg: without it, an active session would serve a
  //   stale render after new steps land. With it, any projection
  //   change produces a fresh miss. The cache key spec lives in
  //   `src/storage/repos/recap-cache.ts::canonicalScopeHash`.
  // - renderer. Stored alongside the hash so the row is debuggable
  //   in isolation — an operator inspecting `recap_cache` rows
  //   should be able to read "this is a `pr` render" without
  //   recomputing the hash. Redundant with the hash composition
  //   but cheap (a renderer label is at most ~10 chars).
  // - output. The rendered markdown / JSON itself, stored verbatim.
  //   Reads return this as-is; no post-processing on hit.
  // - prompt_version (TEXT). E.g. 'pr-v1'. Bumping a prompt is a
  //   filesystem rename plus an eval pass; this column is part of
  //   the cache key composition (above) so the rename automatically
  //   produces misses against rows written by the prior version.
  //   Stored separately for read-side filtering ("show me cached
  //   renders still on the old prompt") without re-deriving from
  //   the hash.
  // - generated_at / expires_at INTEGER (epoch ms). expires_at is
  //   `generated_at + ttl_ms` (default 1h); the TTL is eviction,
  //   not correctness — the content hash already prevents stale
  //   data from being served. Read path evicts rows where
  //   expires_at < now() before falling through to a miss.
  // - cost_usd / tokens_in / tokens_out. Cost accounting for the
  //   render that filled this cache slot. Aggregating across the
  //   table answers "how much have we spent on /recap renders this
  //   month"; per-row gives "what did THIS render cost" for
  //   anomaly detection (a 50k-token recap is suspicious).
  //
  // No FK to session_ids: the cache is forensic only — a session
  // that has since been purged is still allowed to leave a cache
  // row behind (the row will simply expire and be evicted on next
  // miss). Same trade-off as `recap_runs`.
  //
  // Indexes:
  // - (expires_at) supports the eventual purge job ("DELETE FROM
  //   recap_cache WHERE expires_at < ?") and the read-time eviction
  //   that keeps the table from growing unbounded if the purge job
  //   is offline.
  sql: `
    CREATE TABLE recap_cache (
      scope_hash      TEXT PRIMARY KEY,
      renderer        TEXT    NOT NULL,
      output          TEXT    NOT NULL,
      prompt_version  TEXT    NOT NULL,
      generated_at    INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      cost_usd        REAL    NOT NULL DEFAULT 0,
      tokens_in       INTEGER NOT NULL DEFAULT 0,
      tokens_out      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_recap_cache_expires ON recap_cache(expires_at);
  `,
} as const;
