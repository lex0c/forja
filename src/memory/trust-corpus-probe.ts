// Boot-time shared-corpus trust probe — orchestrates the
// substrate (`trust-corpus.ts`) + the modal + the bulk-quarantine
// path. MEMORY.md §6.5.2 `trust_revoked` detector, S5/T5.2+T5.3.
//
// ────────────────────────────────────────────────────────────────────
// FLOW
//
//   1. Compute current shared-corpus fingerprint.
//   2. Read the stored `shared_corpus_trust` row for this scope-root.
//        - row absent → SEED silently with the current hash; the cwd
//          trust modal that already fired this boot covers the
//          implicit initial trust for whatever currently lives in
//          `.agent/memory/shared/`.
//        - row present + hash unchanged → no-op.
//        - row present + hash diverged → fire `askSharedTrust` modal
//          with the current corpus inventory.
//   3. Modal answer:
//        - 'yes' → re-stamp the trust row with the new hash.
//        - 'no' / 'cancel' → REVOKE: clear the trust row + bulk-
//          transition every state=active shared memory to
//          `invalidated` with motivo=security, trigger=trust_revoked.
//          Per EVICTION.md §4.1, `active → quarantined` admits only
//          `conflict`/`low_roi` while `active → invalidated` admits
//          `shift`/`security` — trust revocation is a security
//          event, so `invalidated` is the canonical target.
//          Already-quarantined shared memories are left alone:
//          `quarantined → invalidated` admits only `shift`, not
//          `security`, and they are already non-retrievable via the
//          Slice 6 penalty. Operator can purge them explicitly via
//          `/memory delete` if they want a hard wipe.
//
// ────────────────────────────────────────────────────────────────────
// WHY ORCHESTRATOR IS SEPARATE FROM `trust-corpus.ts`
//
// `trust-corpus.ts` is pure substrate — fingerprint + DB row CRUD,
// no IO beyond filesystem reads and SQLite. This module COMPOSES
// substrate with `transitionMemoryState` (which writes to disk +
// audits) and a modal callback (TUI). Testing the substrate
// without the orchestrator stays cheap; testing the orchestrator
// uses the substrate's primitives without re-deriving them.
//
// The split also keeps the substrate forward-compatible: a future
// surface that wants the hash check without the modal (e.g., a
// `/memory trust check` slash that JUST reports diverged-or-not)
// imports `trust-corpus.ts` directly and skips this module.
// ────────────────────────────────────────────────────────────────────

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../storage/db.ts';
import type { ScopeRoots } from './paths.ts';
import type { MemoryRegistry } from './registry.ts';
import { transitionMemoryState } from './transitions.ts';
import {
  type SharedTrustRow,
  clearSharedTrust,
  computeSharedFingerprint,
  getSharedTrust,
  setSharedTrust,
} from './trust-corpus.ts';

// Modal answer shape. Inline-declared rather than imported from
// `tui/modal-manager.ts` so the memory layer stays independent of
// the TUI — the caller wraps modalManager.askSharedTrust in a thin
// adapter that matches this union. Keeps the dependency arrow
// pointing the same direction as the rest of the memory subsystem
// (memory → storage; nothing → tui).
export type SharedTrustProbeAnswer = 'yes' | 'no' | 'cancel';

// Modal-arg shape. Re-declared instead of imported from
// `tui/modal-manager.ts` to keep the memory layer's dependency on
// the TUI minimal — the orchestrator's signature accepts the
// callback verbatim, so the modal-manager's `askSharedTrust` type
// flows through structurally.
export interface ProbeCorpusFile {
  name: string;
  bytes: number;
}

export interface ProbeSharedTrustInput {
  db: DB;
  registry: MemoryRegistry;
  roots: ScopeRoots;
  // Caller passes the resolved shared-corpus root explicitly so this
  // module does not depend on `projectScopeRoots` (which would couple
  // the probe to the path-resolution conventions). REPL caller derives
  // it via `projectScopeRoots(repoRoot).shared`.
  sharedRoot: string;
  // Modal hook. When the hash diverges, the caller's modal-manager
  // proxy fires here. Callers without a TUI (subagent boot,
  // headless tests) can pass `() => 'no'` to mean "auto-revoke" or
  // `() => 'yes'` to mean "auto-accept" — both are explicit and
  // auditable, neither is a silent default.
  askSharedTrust: (args: {
    path: string;
    corpusFiles: readonly ProbeCorpusFile[];
  }) => Promise<SharedTrustProbeAnswer>;
  // Audit metadata threaded into transition rows. Optional — the
  // transitions module tolerates null for cwd/sessionId; we let
  // the caller decide whether to attribute the bulk action to the
  // pre-bootstrap session or to leave it unattributed.
  sessionId?: string | null;
  cwd?: string | null;
  // Optional logger. Used to surface per-memory transition failures
  // without aborting the bulk path — a single io_error shouldn't
  // mean other shared memories stay active when the operator just
  // revoked trust. Caller wires their event bus or a stderr stub.
  warn?: (message: string) => void;
  // Test-only time source. Stamps `last_confirmed_at`.
  now?: () => number;
}

export type ProbeSharedTrustResult =
  // Stored row absent — first visit OR pre-S5-upgrade. Hash was
  // seeded into the trust row; no modal fired.
  | { kind: 'seeded'; hash: string }
  // Stored row present, hash unchanged. No-op.
  | { kind: 'unchanged'; hash: string }
  // Stored row present, hash differed, operator confirmed. Trust
  // row stamped with the new hash.
  | { kind: 'reconfirmed'; oldHash: string; newHash: string }
  // Stored row present, hash differed, operator revoked. Trust row
  // cleared; `invalidated` carries every shared memory that
  // transitioned active→invalidated, `failed` carries per-memory
  // reasons (io_error, illegal_transition, etc.) for ones that
  // couldn't transition. `failed` is empty in the happy path.
  | {
      kind: 'revoked';
      oldHash: string;
      newHash: string;
      invalidated: { scope: 'project_shared'; name: string }[];
      failed: { name: string; reason: string }[];
    }
  // Fingerprint computation failed (e.g. EACCES on the shared root).
  // Caller should fail-closed — surface a warning and either bail
  // out of REPL boot or run with shared memories filtered out via
  // the registry's state filter (operator-visible degradation).
  | { kind: 'verify_failed'; sharedRoot: string };

// List the current corpus inventory for modal rendering. Returns
// the SAME set the fingerprint hashed over: `.md` files at the
// corpus root, excluding `.tombstones/` and subdirectories. Used
// only for the modal preview — the fingerprint itself is the
// authoritative change detector. Returns an empty array on ENOENT
// (caller still hashes EMPTY_CORPUS_HASH, but the operator sees
// "the corpus is currently empty").
const enumerateCorpus = (sharedRoot: string): ProbeCorpusFile[] => {
  let entries: string[];
  try {
    entries = readdirSync(sharedRoot);
  } catch {
    return [];
  }
  const files: ProbeCorpusFile[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    try {
      const st = statSync(join(sharedRoot, name));
      if (!st.isFile()) continue;
      files.push({ name, bytes: st.size });
    } catch {
      // Same defensive skip as `computeSharedFingerprint` —
      // transient disappearance between readdir and stat is benign.
    }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
};

// Bulk-transition every currently-active shared memory to
// `invalidated`. Used by the revoke path. Per-memory failures are
// collected and surfaced to the caller; one bad memory does NOT
// short-circuit the rest — when the operator just said "I don't
// trust this corpus", we want as many memories invalidated as
// possible.
const bulkInvalidateShared = async (
  input: ProbeSharedTrustInput,
  newHash: string,
): Promise<{
  invalidated: { scope: 'project_shared'; name: string }[];
  failed: { name: string; reason: string }[];
}> => {
  const invalidated: { scope: 'project_shared'; name: string }[] = [];
  const failed: { name: string; reason: string }[] = [];

  // Snapshot the list FIRST. registry.list with states=['active']
  // peeks the body; iterating with mutations in flight would risk
  // partial views. The snapshot is cheap (one file per shared
  // memory) and matches the modal's audit window.
  const activeShared = input.registry.list({
    scope: 'project_shared',
    states: ['active'],
  });

  for (const listing of activeShared) {
    try {
      const result = await transitionMemoryState({
        db: input.db,
        registry: input.registry,
        roots: input.roots,
        scope: listing.scope,
        name: listing.name,
        toState: 'invalidated',
        motivo: 'security',
        trigger: 'trust_revoked',
        actor: 'user',
        evidence: {
          // §6.1 schema admits `trigger_source` for the security
          // motivo. We tag the source with both the detector name
          // and the new hash so audit forensics can correlate the
          // bulk event to the exact corpus state that prompted
          // revocation.
          trigger_source: 'shared_corpus_hash_changed',
          new_corpus_hash: newHash,
        },
        sessionId: input.sessionId ?? null,
        cwd: input.cwd ?? null,
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (result.kind === 'applied') {
        invalidated.push({ scope: 'project_shared', name: listing.name });
      } else {
        // illegal_transition, invalid_evidence, io_error — surface
        // the kind. Caller's warn hook gets the full reason.
        const reason = result.kind === 'io_error' ? result.reason : result.kind;
        failed.push({ name: listing.name, reason });
        input.warn?.(`trust_revoked: failed invalidating ${listing.name}: ${reason}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ name: listing.name, reason });
      input.warn?.(`trust_revoked: threw invalidating ${listing.name}: ${reason}`);
    }
  }

  return { invalidated, failed };
};

export const probeSharedTrust = async (
  input: ProbeSharedTrustInput,
): Promise<ProbeSharedTrustResult> => {
  const currentHash = computeSharedFingerprint(input.sharedRoot);
  if (currentHash === null) {
    return { kind: 'verify_failed', sharedRoot: input.sharedRoot };
  }

  const stored: SharedTrustRow | null = getSharedTrust(input.db, input.sharedRoot);

  if (stored === null) {
    // First visit (or pre-S5 upgrade). Silent seed — the cwd-trust
    // modal that already fired covers the implicit initial trust.
    setSharedTrust(input.db, input.sharedRoot, currentHash, input.now?.());
    return { kind: 'seeded', hash: currentHash };
  }

  if (stored.lastConfirmedHash === currentHash) {
    return { kind: 'unchanged', hash: currentHash };
  }

  // Hash diverged. Prompt the operator.
  const corpusFiles = enumerateCorpus(input.sharedRoot);
  const answer = await input.askSharedTrust({
    path: input.sharedRoot,
    corpusFiles,
  });

  if (answer === 'yes') {
    setSharedTrust(input.db, input.sharedRoot, currentHash, input.now?.());
    return { kind: 'reconfirmed', oldHash: stored.lastConfirmedHash, newHash: currentHash };
  }

  // no / cancel — revoke path. Clear the trust row FIRST so a crash
  // mid-bulk leaves the system in the safer state (next boot
  // re-prompts).
  clearSharedTrust(input.db, input.sharedRoot);
  const { invalidated, failed } = await bulkInvalidateShared(input, currentHash);
  return {
    kind: 'revoked',
    oldHash: stored.lastConfirmedHash,
    newHash: currentHash,
    invalidated,
    failed,
  };
};
