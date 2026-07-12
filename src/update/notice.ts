import type { UpdateCheckState } from '../storage/repos/update-check.ts';
import { isNewer } from './semver.ts';

// Default throttle between network probes (24h). The boot path reads the cache
// every session, but the network is probed at most once per interval.
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface NoticeDecision {
  show: boolean;
  latest?: string;
}

// Synchronous, local, offline-safe decision made on the boot path: given the
// cached probe result and the running version, should the notice fire — and
// for which version? Fires only when the cached latest is strictly newer than
// current AND hasn't already been surfaced, so it shows once per release, not
// every boot (SECURITY_GUIDELINE §11.4). Because the source is
// `/releases/latest` (stable only), a running prerelease correctly gets nudged
// toward the matching stable (e.g. 0.2.0-rc.1 → 0.2.0) via isNewer.
export const decideNotice = (state: UpdateCheckState, current: string): NoticeDecision => {
  const latest = state.latestSeen;
  if (latest === null) return { show: false };
  if (!isNewer(latest, current)) return { show: false };
  if (state.notifiedVersion === latest) return { show: false };
  return { show: true, latest };
};

// Throttle gate for the async refresh: probe only if we never have, or the
// interval has elapsed since the last SUCCESSFUL probe. A failed probe leaves
// lastCheckedAt untouched, so this returns true again next boot (retry).
export const shouldRefresh = (
  state: UpdateCheckState,
  now: number,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): boolean => {
  if (state.lastCheckedAt === null) return true;
  // Clock moved backward (bad RTC / NTP) after a probe recorded a future
  // timestamp → treat as due, else the throttle stalls until wall-clock catches up.
  if (state.lastCheckedAt > now) return true;
  return now - state.lastCheckedAt >= intervalMs;
};
