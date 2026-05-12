// Doctor check cache — PERMISSION_ENGINE.md §13.8.
//
// Spec line 944: "Cache de 60s pra checks não-críticos (kernel
// features, pkg versions). Checks críticos (bwrap binary
// presente, policy hash, hash chain integrity) sempre live."
//
// Why cache: §13.8 lists three doctor triggers — SessionStart,
// every N tool calls (default 50), and explicit `forja doctor`.
// In a long-running session, the harness re-runs doctor every
// 50 tool calls; without a cache, every re-run probes ALL checks
// from scratch — including `mac_lsm` (which shells out to
// `aa-status`), `user_namespaces` (reads /proc), `net_filtering`
// (shells out to `nft`). These are stable within a session
// (kernel version doesn't change; nftables version doesn't
// change) and probing them every 50 tool calls is wasted I/O.
//
// Why NOT cache the critical checks: bwrap binary presence,
// policy hash, hash chain integrity, fs writability, sealing —
// each can detect ACTIVE state changes the operator needs to
// react to (operator just `apt remove bwrap`d; policy file got
// renamed mid-session; another forja process re-sealed the
// policy). Caching these would silently mask the regressions.
//
// Cache shape: in-memory only. The 60s TTL window is shorter
// than any process restart, so persistence doesn't buy us
// anything. Process-local cache means each `forja` invocation
// starts fresh; only the long-running harness sees cache hits
// (which is exactly the use case the spec calls out).

import type { DoctorCheck } from './doctor.ts';

// TTL per spec §13.8. Exported for tests.
export const DOCTOR_CACHE_TTL_MS = 60_000;

// Per spec §13.8, the non-critical checks. Kernel/pkg version-
// style probes that DON'T change within a typical session.
// Critical checks (sandbox binary, policy_load, hash_chain, fs
// writable, sealing) are listed by NAME in the spec OR identified
// by their state-validating purpose; they bypass the cache.
export const NON_CRITICAL_CHECK_NAMES: ReadonlySet<string> = new Set([
  'platform',
  'user_namespaces',
  'net_filtering',
  'mac_lsm',
  'git',
]);

export const isCacheable = (name: string): boolean => NON_CRITICAL_CHECK_NAMES.has(name);

export interface DoctorCheckCacheEntry {
  check: DoctorCheck;
  expiresAt: number;
}

// In-memory cache. `now` is passed in by callers so tests can
// pin time deterministically (no `Date.now()` capture inside).
export interface DoctorCheckCache {
  get(name: string, now: number): DoctorCheck | null;
  set(name: string, check: DoctorCheck, ttlMs: number, now: number): void;
  clear(): void;
}

export const createInMemoryDoctorCache = (): DoctorCheckCache => {
  const entries = new Map<string, DoctorCheckCacheEntry>();
  return {
    get(name, now) {
      const e = entries.get(name);
      if (e === undefined) return null;
      if (now >= e.expiresAt) {
        // Expired — drop the entry so subsequent gets are cheap.
        entries.delete(name);
        return null;
      }
      return e.check;
    },
    set(name, check, ttlMs, now) {
      entries.set(name, { check, expiresAt: now + ttlMs });
    },
    clear() {
      entries.clear();
    },
  };
};

// Process-wide singleton. Used by `runDoctor` when no cache is
// explicitly provided. Tests pass a fresh cache via options so
// shared state doesn't leak between tests.
let sharedCache: DoctorCheckCache = createInMemoryDoctorCache();
export const getSharedDoctorCache = (): DoctorCheckCache => sharedCache;

// Test seam: reset the shared cache to a fresh instance. Used by
// the long-lived `agent` process if it ever needs to invalidate
// (e.g., explicit `forja doctor --no-cache` flag, future slice).
// In tests, prefer injecting a per-test cache via runDoctor's
// `cache` option instead of calling this.
export const resetSharedDoctorCache = (): void => {
  sharedCache = createInMemoryDoctorCache();
};

// Cache wrapper: if the check is non-critical AND a fresh entry
// exists, return it; otherwise run the check and cache the
// result. Critical checks bypass entirely — `run()` always
// executes for them.
//
// `now` is captured at the call site (not inside the wrapper)
// so the cache's age semantics align with the snapshot moment
// the runDoctor invocation took. Multiple checks within one
// runDoctor call see the same `now`.
export const withDoctorCache = (
  name: string,
  run: () => DoctorCheck,
  cache: DoctorCheckCache,
  now: number,
): DoctorCheck => {
  if (!isCacheable(name)) return run();
  const cached = cache.get(name, now);
  if (cached !== null) return cached;
  const fresh = run();
  cache.set(name, fresh, DOCTOR_CACHE_TTL_MS, now);
  return fresh;
};
