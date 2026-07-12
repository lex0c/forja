import type { DB } from '../storage/db.ts';
import { getUpdateCheck, markNotified } from '../storage/repos/update-check.ts';
import { decideNotice } from './notice.ts';
import { RELEASES_PAGE_URL, refreshUpdateCache } from './refresh.ts';

export interface UpdateNotice {
  current: string;
  latest: string;
  url: string;
}

// Boot-path decision for the passive "update available" notice
// (SECURITY_GUIDELINE §11.4). Synchronous, local, offline-safe: reads the cache
// and returns the notice to emit if a newer release is known and not yet
// surfaced — otherwise null. Does NOT mark it seen; the caller calls
// markNoticeShown AFTER emitting, so a crash / emit-failure between decide and
// render doesn't durably suppress the notice (mark-before-render would lose it).
//
// Gating (opt-in + REPL + not --json/CI/subagent) is the caller's job, done
// BEFORE calling this.
export const peekUpdateNotice = (db: DB, current: string): UpdateNotice | null => {
  const decision = decideNotice(getUpdateCheck(db), current);
  if (!decision.show || decision.latest === undefined) return null;
  return { current, latest: decision.latest, url: RELEASES_PAGE_URL };
};

// Records that `version` was surfaced, so the notice fires once per release.
// Call AFTER the notice has been emitted/rendered, not before.
export const markNoticeShown = (db: DB, version: string): void => {
  markNotified(db, version);
};

// Fire-and-forget background refresh whose result feeds the NEXT session's
// notice. Never throws and never blocks — callers invoke it WITHOUT awaiting on
// the boot path (the `void` documents the intentional floating promise). Same
// gating as takeUpdateNotice applies at the call site.
export const kickUpdateRefresh = (
  db: DB,
  now: number,
  intervalMs?: number,
  signal?: AbortSignal,
): void => {
  // Build opts without explicit `undefined` props (exactOptionalPropertyTypes).
  // The session signal lets shutdown abort an in-flight probe before it writes
  // to a closing db — the fire-and-forget promise is otherwise untracked.
  const opts: { now: number; intervalMs?: number; signal?: AbortSignal } = { now };
  if (intervalMs !== undefined) opts.intervalMs = intervalMs;
  if (signal !== undefined) opts.signal = signal;
  void refreshUpdateCache(db, opts);
};

// True under a CI system — the de facto `CI` env var that GitHub Actions /
// GitLab / CircleCI / Travis all set. The notice suppresses its network probe in
// CI even under an allocated pty (script/expect smoke tests), which the upstream
// TTY gate does NOT catch (§11.4: no unsolicited network in CI). `false`/`0`/
// empty count as not-CI.
export const isCiEnv = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
};
