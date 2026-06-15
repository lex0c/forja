// First-run privacy banner for input history. Spec: HISTORY.md §3.2.
//
// Discovers whether the operator has already acknowledged that input
// history is being persisted; if not, emits the disclosure as info
// lines on the bus and drops a `.forja/forja-history-acked` marker so
// subsequent boots stay quiet.
//
// Skip rules:
//
//   - `FORJA_NO_HISTORY=1` env: nothing is persisted, so the banner
//     is irrelevant. Disclosure of a non-event would just train
//     operators to ignore the boot prose.
//   - `.forja/no-history` file marker: same shape as above —
//     persistence is permanently off for this project.
//   - `.forja/forja-history-acked` already exists: operator saw
//     this once before; surfacing it on every REPL would erode the
//     "first-run" contract.
//
// All checks are filesystem stat calls scoped to the cwd. We don't
// touch any other path — the marker travels with the project (matches
// how `.forja/forja.db` and `no-history` already work). Marker
// content is irrelevant; existence is the signal.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORY_CAP } from '../storage/history.ts';
import type { Bus } from '../tui/bus.ts';

const ACK_MARKER = 'forja-history-acked';
const NO_HISTORY_MARKER = 'no-history';
const AGENT_DIR = '.forja';

export interface MaybeEmitHistoryBannerOptions {
  bus: Bus;
  cwd: string;
  // Wall-clock ts threaded onto every emitted UIEvent.
  now: () => number;
  // Diagnostic sink for marker-write failures. Mirrors the trust
  // path's `errSink` shape — operators see the warning without
  // crashing the boot.
  warn: (message: string) => void;
  // Test seam: skip the env probe so a developer's shell-level
  // FORJA_NO_HISTORY doesn't suppress the banner during fixture
  // setup. Production never sets this.
  ignoreEnv?: boolean;
}

// Returns true when the banner was emitted (and the marker written),
// false when suppressed by any of the skip rules. Tests assert on
// the boolean to verify behavior without scraping bus events.
export const maybeEmitHistoryBanner = (options: MaybeEmitHistoryBannerOptions): boolean => {
  const { bus, cwd, now, warn } = options;

  // Permanent disables (env / file marker) suppress the banner.
  if (options.ignoreEnv !== true && process.env.FORJA_NO_HISTORY === '1') return false;
  const agentDir = join(cwd, AGENT_DIR);
  if (existsSync(join(agentDir, NO_HISTORY_MARKER))) return false;

  // Already acked: stay quiet.
  const ackPath = join(agentDir, ACK_MARKER);
  if (existsSync(ackPath)) return false;

  // Two info lines per spec §3.2 (storage path + cap, then opt-out
  // hints). Routed as plain `info` (not warn / error) so the boot
  // scrollback's red/yellow palette stays reserved for actual issues
  // — the operator scans color before content.
  bus.emit({
    type: 'info',
    ts: now(),
    message: `history: persisted to ${AGENT_DIR}/forja.db (${HISTORY_CAP} entry cap)`,
  });
  bus.emit({
    type: 'info',
    ts: now(),
    message: '/history off to disable for this session, /history clear to wipe',
  });

  // Write the ack marker so future boots stay quiet. Failure to
  // persist is a warning rather than fatal: the operator already
  // saw the banner this boot; the worst case is they see it again
  // next boot. mkdir -p in case bootstrap hasn't materialized
  // `.forja/` yet (early-stage projects, rare).
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(ackPath, '');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`failed to persist history-banner ack at ${ackPath}: ${msg} (will re-show next boot)`);
  }

  return true;
};
