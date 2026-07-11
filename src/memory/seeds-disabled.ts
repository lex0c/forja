import { readFileSync } from 'node:fs';
import { atomicWrite } from './atomic.ts';
import type { ScopeRoots } from './paths.ts';
import { disabledSeedsPath } from './paths.ts';

// Operator opt-out sentinel for individual vendor seeds (spec
// MEMORY.md §5.7.6).
//
// Persisted shape (JSON, at `<user>/seeds/.disabled.json`):
//
//   {
//     "<seed-name>": { "disabled_at": "<ISO-8601-string>" },
//     ...
//   }
//
// The sentinel is consulted by two surfaces:
//
//   1. `installVendorSeeds` — a disabled seed routes through the
//      `disabled` action: the body on disk is NOT touched, the prior
//      manifest entry is preserved, and the entry is excluded from
//      the regenerated `seeds/MEMORY.md` index. Survives a vendor
//      catalog bump (the sentinel is checked BEFORE the state-machine
//      branches), so an operator's opt-out doesn't regress when the
//      binary upgrades.
//
//   2. `createMemoryRegistry.refresh` — the user-seeds snapshot
//      filters disabled entries OUT, so the model never sees them in
//      the assembled system prompt or in `/memory list` / `/memory
//      show` resolution. The body is preserved on disk for future
//      `/memory seeds enable` re-inclusion.
//
// The `disabled_at` timestamp is opaque metadata — the agent does not
// consult it for any decision today. It exists to give an operator a
// minimal audit trail when troubleshooting "why is this seed gone?"
// without needing to grep session logs.

export interface DisabledSeedEntry {
  disabled_at: string;
}

export type DisabledSeeds = Record<string, DisabledSeedEntry>;

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Load the disabled-seeds sentinel. Absent file → empty map (no
// opt-outs configured). Malformed JSON collapses to empty with a
// stderr warning: we refuse to silently treat "every seed disabled"
// as the safer default — operators expect their opt-outs to persist,
// not to silently broaden into a no-op when the file rots. Treating
// a corrupt sentinel as "no opt-outs" means the worst case is that a
// previously-disabled seed reappears once (which the operator can
// notice and re-disable), not that the entire catalog vanishes.
export const loadDisabledSeeds = (roots: ScopeRoots): DisabledSeeds => {
  const path = disabledSeedsPath(roots);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `forja: disabled-seeds sentinel at ${path} malformed (${msg}); treating as empty — all seeds will load this boot\n`,
    );
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: DisabledSeeds = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // Per-entry corruption: warn the operator naming the key (same
      // shape as the install-manifest's per-entry warn). Without
      // this, a hand-edited sentinel that introduces a malformed row
      // silently treats the named seed as "not opted out" and the
      // operator wonders why their `/memory seeds disable` no longer
      // sticks.
      process.stderr.write(
        `forja: disabled-seeds sentinel at ${path}: dropping entry ${JSON.stringify(key)} (value not a plain object)\n`,
      );
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.disabled_at !== 'string') {
      process.stderr.write(
        `forja: disabled-seeds sentinel at ${path}: dropping entry ${JSON.stringify(key)} (disabled_at must be a string)\n`,
      );
      continue;
    }
    out[key] = { disabled_at: v.disabled_at };
  }
  return out;
};

// Atomic-write the sentinel with sorted keys. Same canonical-JSON
// shape as the install manifest so diffs across boots only reflect
// real opt-out / opt-in changes, not insertion-order noise.
export const writeDisabledSeeds = (roots: ScopeRoots, disabled: DisabledSeeds): void => {
  const sortedKeys = Object.keys(disabled).sort();
  const ordered: DisabledSeeds = {};
  for (const k of sortedKeys) {
    const entry = disabled[k];
    if (entry !== undefined) ordered[k] = entry;
  }
  const json = `${JSON.stringify(ordered, null, 2)}\n`;
  atomicWrite(disabledSeedsPath(roots), json);
};

// O(1) membership check. Object.hasOwn() rejects prototype chain
// lookups so a seed named `__proto__` cannot masquerade as disabled
// through a hand-edited sentinel (defense-in-depth — validateName at
// the slash-command surface should already reject it, but the loader
// stays correct even if a future caller forgets to validate).
export const isSeedDisabled = (disabled: DisabledSeeds, name: string): boolean =>
  Object.hasOwn(disabled, name);
