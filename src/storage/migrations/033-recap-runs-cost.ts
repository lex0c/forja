export const migration033RecapRunsCost = {
  id: 33,
  name: '033-recap-runs-cost',
  // RECAP.md §6.3 — extend `recap_runs` with cost / cache / prompt
  // columns the M4.2 LLM render path needs to record.
  //
  // M4.1 wrote rows with `used_llm = 0` always; the column was
  // pinned then so this slice is a code change, not a migration of
  // semantics. M4.2 (a) adds the LLM render path, which means a
  // run can now have a real cost, real token counts, a prompt
  // version, and a cache-hit signal — those are the five columns
  // here.
  //
  // Why ALTER instead of a new table:
  // - `recap_runs` is already the audit pointer for "this recap
  //   was generated with these settings". Cost / tokens / cache
  //   status are properties OF that single recap, not separate
  //   facts that deserve their own table. A side table would
  //   duplicate (id, created_at) for one row of metadata each.
  // - Cardinality stays 1:1 with `recap_runs` rows; SQLite ALTER
  //   ADD COLUMN is O(1) and does not rewrite the table.
  //
  // Backward compat:
  // - All five columns have NOT NULL DEFAULT, so existing M4.1
  //   rows survive without backfill (cost_usd=0, tokens=0,
  //   prompt_version=NULL, cache_hit=0 — which describes those
  //   rows accurately: deterministic render, no prompt, no cache).
  // - prompt_version is the only nullable column. NULL means
  //   "no prompt was rendered" (deterministic path, or json
  //   renderer); it's distinct from an empty string, which would
  //   imply a prompt with an empty version label.
  //
  // CHECK constraint on cache_hit mirrors the used_llm pattern from
  // migration 030 — pin the 0/1 vocabulary at the SQL boundary.
  sql: `
    ALTER TABLE recap_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
    ALTER TABLE recap_runs ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE recap_runs ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE recap_runs ADD COLUMN prompt_version TEXT;
    ALTER TABLE recap_runs ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0
      CHECK (cache_hit IN (0, 1));
  `,
} as const;
