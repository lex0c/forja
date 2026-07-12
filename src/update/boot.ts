import type { DB } from '../storage/db.ts';
import { getUpdateCheck, markNotified } from '../storage/repos/update-check.ts';
import { decideNotice } from './notice.ts';
import { refreshUpdateCache } from './refresh.ts';

export interface UpdateNotice {
  current: string;
  latest: string;
}

// Boot-path entry point for the passive "update available" notice
// (SECURITY_GUIDELINE §11.4). Synchronous, local, offline-safe: reads the
// cache, and if a newer release is known and not yet surfaced, marks it
// notified and returns the notice to emit — otherwise null. Marking on "take"
// is what makes the banner fire ONCE per release rather than every boot.
//
// Gating (opt-in + REPL + not --json/CI/subagent) is the caller's job, done
// BEFORE calling this; here we only do the cache → decision → mark step.
export const takeUpdateNotice = (db: DB, current: string): UpdateNotice | null => {
  const decision = decideNotice(getUpdateCheck(db), current);
  if (!decision.show || decision.latest === undefined) return null;
  markNotified(db, decision.latest);
  return { current, latest: decision.latest };
};

// Fire-and-forget background refresh whose result feeds the NEXT session's
// notice. Never throws and never blocks — callers invoke it WITHOUT awaiting on
// the boot path (the `void` documents the intentional floating promise). Same
// gating as takeUpdateNotice applies at the call site.
export const kickUpdateRefresh = (db: DB, now: number, intervalMs?: number): void => {
  // Build the opts without an explicit `intervalMs: undefined` — the project's
  // exactOptionalPropertyTypes rejects that in favour of an absent key.
  void refreshUpdateCache(db, intervalMs === undefined ? { now } : { now, intervalMs });
};
