// compaction_events: record the MODEL that billed each compaction call.
//
// Why: an `llm`/`fallback` compaction makes a provider call that BILLS — its cost folds into
// `sessions.total_cost_usd` (migration 073) and `/stats` counts its tokens — but it writes NO
// `messages` row, so the model is absent from the per-turn provenance (migration 077). A
// session whose assistant turns ran on an unmetered model but that compacted on a metered one
// (a `/model` switch then `/compact`) would then read as wholly unmetered, hiding the metered
// compaction spend. Recording the model here lets the metering resolver fold it in.
//
// Nullable: `relevance` / `skipped` strategies make no provider call (NULL — nothing billed),
// and rows written before this migration carry NULL. The read path attributes a NULL-model
// BILLED compaction to `sessions.model` — the same fallback as migration 077's NULL message
// rows — so pre-migration compaction spend is not dropped from the metering set.
export const migration078CompactionEventsModel = {
  id: 78,
  name: '078-compaction-events-model',
  sql: `
    ALTER TABLE compaction_events ADD COLUMN model TEXT;
  `,
} as const;
