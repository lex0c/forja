// Scope-aware index for detectTriggerThrashing.
//
// The `idx_evict_thrash` partial index introduced in migration 047
// covered `(substrate, object_id, trigger, recorded_at)`. That keyed
// shape matched the original aggregation, which grouped by
// `(substrate, object_id, trigger)` only. The grouping ignored
// `object_scope`, so a `trigger_fired_no_action` row at
// `(memory, foo, user)` merged with one at `(memory, foo, project_local)`
// — two independent scoped objects with the same name landed in the
// same bucket, distorting counts and producing false-positive
// thrashing hits.
//
// detectTriggerThrashing now groups by `(substrate, object_id,
// object_scope, trigger)`. To keep the query covered (and avoid the
// temp B-tree GROUP BY that the partial index was created to
// eliminate), this migration drops the old index and recreates it
// with `object_scope` slotted between `object_id` and `trigger` —
// exactly the column order GROUP BY expects.
//
// DROP + CREATE is safe: SQLite indexes are append-only data
// derived from the table; dropping costs O(size of index) and
// rebuilding costs the same. Bounded by the partial WHERE
// (`outcome = 'trigger_fired_no_action'`) so even a busy install
// rebuilds quickly.

export const migration052EvictionThrashingScope = {
  id: 52,
  name: '052-eviction-thrashing-scope',
  sql: `
    DROP INDEX IF EXISTS idx_evict_thrash;
    CREATE INDEX idx_evict_thrash
      ON eviction_events(substrate, object_id, object_scope, trigger, recorded_at)
      WHERE outcome = 'trigger_fired_no_action';
  `,
} as const;
