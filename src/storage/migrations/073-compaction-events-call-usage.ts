// compaction_events: record the BILLED usage of the compaction provider
// call (the summary LLM call), not just the context-size estimates.
//
// Why: the harness folds the compaction call's cost into
// `sessions.total_cost_usd` (recoverable) AND its tokens into the run's
// usage — but `compact()` writes NO `messages` row (by design, SESSION.md),
// and migration 072 stored only `tokens_before`/`tokens_after` (context
// estimates, not the call's billed usage). So the compaction tokens were
// persisted nowhere queryable. The usage aggregator (`computeUsageStats`)
// then reported cost INCLUDING compaction but tokens EXCLUDING it —
// internally inconsistent, under-reporting actual token usage on any
// session that crossed a compaction.
//
// These four columns close that gap: the compaction call's input / output /
// cache-read / cache-creation tokens, so the aggregator can sum them and
// the token totals line up with the cost. NULL on rows written before this
// migration and on the relevance-only path (no provider call → zero usage);
// the aggregator COALESCEs NULL to 0.
//
// Named `call_*` to distinguish from `tokens_before`/`tokens_after`, which
// are prompt-size estimates of the CONTEXT, not the summary call's billing.
export const migration073CompactionEventsCallUsage = {
  id: 73,
  name: '073-compaction-events-call-usage',
  sql: `
    ALTER TABLE compaction_events ADD COLUMN call_tokens_in INTEGER;
    ALTER TABLE compaction_events ADD COLUMN call_tokens_out INTEGER;
    ALTER TABLE compaction_events ADD COLUMN call_cache_read INTEGER;
    ALTER TABLE compaction_events ADD COLUMN call_cache_creation INTEGER;
  `,
} as const;
