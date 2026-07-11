export const migration004SessionUsageComplete = {
  id: 4,
  name: '004-session-usage-complete',
  // Telemetry hardening. `sessions.total_cost_usd` was always written
  // as the sum of measured turns; sessions where some turn skipped
  // telemetry (compat endpoints, mid-stream aborts, provider errors)
  // were silently persisted as if the number were authoritative. Add a
  // boolean column so downstream queries (`agent audit costs`) can
  // tell complete totals from lower bounds.
  //
  // Default 1 keeps pre-M2 rows classified as complete — before this
  // migration there was no concept of "incomplete", and rewriting old
  // history as suspect would be worse than letting it stand. New rows
  // inherit the runtime flag from the harness.
  sql: `
    ALTER TABLE sessions ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 1
      CHECK (usage_complete IN (0, 1));
  `,
} as const;
