// FIFO-bounded Map cache. Module-level caches in the permission
// engine (compiled globs, regex sets, resolved protected-paths
// tuples) grow append-only across a session; without a bound, memory
// creeps in long-lived REPLs that absorb operator session-allow
// promotions, hot-reloaded policy snapshots, or many distinct
// home/cwd combos in test runs.
//
// FIFO over LRU on purpose: the hot path is matcher lookup against
// operator-stable patterns. Cache hit/miss is dominated by "is this
// pattern in the active policy" — not by temporal locality. FIFO is
// cheap (insertion-order Map.keys().next()) and gives near-LRU shape
// in practice because the patterns that churn the most are also the
// ones evicted first.
//
// Cap defaults are calibrated for the patterns each consumer sees:
// matcher.ts globs + regexes top out at ~10s in realistic policies +
// session-allows; we set the floor much higher to absorb pathological
// inputs without rejecting them. The cap is the operator's safety
// valve, not the policy author's design constraint.

export interface BoundedCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  size(): number;
  // Test-only — clears all entries. Production callers don't need to
  // reset; the FIFO eviction handles long-lived growth.
  clear(): void;
}

export const createBoundedCache = <K, V>(cap: number): BoundedCache<K, V> => {
  if (cap <= 0) {
    throw new Error(`createBoundedCache: cap must be > 0 (got ${cap})`);
  }
  const map = new Map<K, V>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      // If the key is already present, just overwrite — Map keeps
      // insertion order on first insert; an in-place update does
      // NOT promote the key to "most recent" (we want FIFO, not
      // LRU). Eviction only fires when adding a NEW key would
      // exceed the cap; at that point map.size >= cap >= 1, so
      // `keys().next()` always yields a real entry.
      if (!map.has(key) && map.size >= cap) {
        map.delete(map.keys().next().value as K);
      }
      map.set(key, value);
    },
    size: () => map.size,
    clear: () => map.clear(),
  };
};
