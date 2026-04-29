export const migration003UsageCost = {
  id: 3,
  name: '003-usage-cost',
  // M2 / Step 1 — telemetry. The original schema has tokens_in/tokens_out/
  // cached_tokens but no column for cache *creation* (Anthropic charges a
  // distinct write-through tier) and no per-message cost. Splitting cache
  // reads from cache writes lets the cost computer use each rate
  // honestly; storing cost_usd per turn means `agent audit costs --by ...`
  // doesn't have to re-derive pricing every query.
  //
  // `cost_usd` is intentionally a snapshot of (usage × pricing-at-write-time),
  // not a recomputable derivation. If a provider drops its rate next month
  // the historical row keeps reflecting the rate we were billed at — which
  // is what audit/billing actually want. Don't "recalculate" old rows; if
  // pricing config drifts, write a migration that records the new rate
  // alongside, never one that overwrites.
  sql: `
    ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER;
    ALTER TABLE messages ADD COLUMN cost_usd REAL;
  `,
} as const;
