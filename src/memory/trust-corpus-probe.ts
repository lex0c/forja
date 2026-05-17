// Boot-time shared-corpus trust probe — orchestrates the
// substrate (`trust-corpus.ts`) + the modal + the bulk-invalidate
// path. MEMORY.md §6.5.2 `trust_revoked` detector, S5/T5.2+T5.3
// + Phase 1 P0/P1 hardening pass.
//
// ────────────────────────────────────────────────────────────────────
// FLOW (post-hardening)
//
//   1. Compute current shared-corpus fingerprint.
//        - null → return `verify_failed`. Caller is expected to
//          fail-closed: exclude the project_shared scope from
//          eager-load so the operator's session doesn't load
//          memories from a corpus whose state is unknown.
//
//   2. Read the stored `shared_corpus_trust` row for this scope-root.
//
//        a. Row absent + corpus is EMPTY (no files at all)
//           → silently SEED the row with EMPTY_CORPUS_HASH. Nothing
//             to consent to; the cwd-trust modal already attests the
//             directory itself.
//
//        b. Row absent + corpus is NON-EMPTY (P0/F2 fix)
//           → fire FIRST-VISIT modal. The cwd-trust modal attested
//             "I trust this directory" — it did NOT attest the
//             current shared-memory content. A fresh clone with
//             cwd-trusted + a malicious pre-populated `.agent/
//             memory/shared/` would otherwise silently bless the
//             attacker's hash. Operator must see the inventory and
//             explicitly confirm.
//
//        c. Row present + hash unchanged
//           → no-op (`unchanged`).
//
//        d. Row present + hash diverged
//           → fire DRIFT modal with the current inventory.
//
//   3. Modal answer (drift OR first-visit):
//        - 'yes' →
//           i.  RE-COMPUTE the fingerprint (P0/F3 TOCTOU close).
//               The modal can sit open for minutes; an attacker
//               who controls disk could swap the corpus during
//               operator deliberation. Operator confirmed what
//               they SAW, not whatever lands during the prompt.
//           ii. If recomputed === presented → stamp the trust row
//               with `presented` and return `reconfirmed`.
//           iii.If recomputed ≠ presented → return `deferred`
//               with no state mutation. Next boot re-prompts.
//
//        - 'no' → REVOKE: bulk-invalidate first, THEN clear the
//          trust row (P0/H1-rob atomicity). If the process crashes
//          between bulk steps, the trust row still pins the OLD
//          hash, so the next boot recomputes, sees divergence
//          (corpus changed), and re-prompts — surviving `active`
//          memories get a second chance to be invalidated. The
//          previous order (clear → bulk) would have left
//          un-invalidated active memories silently re-loadable
//          after a crash because the re-seed of the trust row at
//          the current hash would never fire a re-prompt.
//
//        - 'cancel' (Esc / timeout / signal) → DEFER (P1/M4-rob).
//          Operator-intent ambiguous (they walked away, hit Esc,
//          or the modal timed out). Returning revoke would be
//          destructive on intent we don't have. Leave the trust
//          row pinned to the OLD hash; next boot re-prompts on
//          the persistent divergence. Operator who really wants
//          to revoke can press the explicit "No, revoke trust"
//          option.
//
// ────────────────────────────────────────────────────────────────────
// HOOK FIRING POLICY (deliberate skip)
//
// `transitionMemoryState` fires the `Eviction` hook when both
// `fireHook` AND `sessionId` are wired. The probe runs at boot
// time, BEFORE the harness creates a session — so passing a real
// session id isn't possible without synthesizing one (which would
// give operator hooks a fake "session" with no turns / messages /
// provenance, harder to forensically reason about than a missing
// hook fire).
//
// This matches the precedent set by `gcExpiredMemories` and the
// provenance retention sweep: boot-time consistency actions skip
// hooks. Operators who want to monitor trust revocation rely on
// the durable audit trail (eviction_events row per transition,
// memory_events 'refused' rows for skipped / failed entries, plus
// the stderr summary line emitted by the REPL caller). The hook
// system is reserved for in-session events with full provenance.
//
// If the spec evolves to demand hook fires on boot-time
// detector actions, the probe gains a `fireHook` parameter and
// a synthesized "boot probe" session id — but that's a spec PR,
// not a probe-local decision.
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

import type { DB } from '../storage/db.ts';
import type { ScopeRoots } from './paths.ts';
import type { MemoryRegistry } from './registry.ts';
import { transitionMemoryState } from './transitions.ts';
import {
  type CorpusSnapshot,
  EMPTY_CORPUS_HASH,
  type SharedTrustRow,
  computeSharedFingerprint,
  computeSharedFingerprintWithSnapshot,
  getSharedTrust,
  listSharedCorpusFiles,
  recomputeSharedFingerprintIfStale,
  setSharedTrust,
} from './trust-corpus.ts';

// Modal answer shape. Inline-declared rather than imported from
// `tui/modal-manager.ts` so the memory layer stays independent of
// the TUI — the caller wraps modalManager.askSharedTrust in a thin
// adapter that matches this union. Keeps the dependency arrow
// pointing the same direction as the rest of the memory subsystem
// (memory → storage; nothing → tui).
export type SharedTrustProbeAnswer = 'yes' | 'no' | 'cancel';

// Modal flavor passed to the renderer. `first-visit` triggers the
// "this repo ships a shared corpus you haven't reviewed" prose;
// `drift` triggers the "corpus changed since last confirm" prose.
// The same answer space ('yes' / 'no' / 'cancel') applies to both.
export type SharedTrustModalMode = 'first-visit' | 'drift';

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
  // Modal hook. Receives both the corpus inventory AND the modal mode
  // ('first-visit' vs 'drift') so the renderer can frame the question
  // appropriately. Callers without a TUI pass an explicit policy
  // (`() => 'yes'` for auto-accept, `() => 'no'` for auto-revoke);
  // neither is a silent default of the substrate.
  askSharedTrust: (args: {
    path: string;
    corpusFiles: readonly ProbeCorpusFile[];
    mode: SharedTrustModalMode;
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
  // Test-only time source. Stamps `last_confirmed_at` AND threads
  // into `transitionMemoryState` for the per-memory audit rows.
  now?: () => number;
}

export type ProbeSharedTrustResult =
  // First visit AND corpus was empty → row silently seeded with
  // EMPTY_CORPUS_HASH. No modal fired.
  | { kind: 'seeded' }
  // Stored row present, hash unchanged. No-op.
  | { kind: 'unchanged' }
  // Modal answered 'yes' AND the re-computed fingerprint matches the
  // hash the operator was shown. Trust row stamped with the
  // confirmed hash. Per-transition hash/mode forensic detail lives
  // in the durable audit trail (memory_events, eviction_events,
  // shared_corpus_trust) — the probe result carries only the
  // discriminator the REPL caller needs to render a summary line.
  | { kind: 'reconfirmed' }
  // Modal answered 'no'. Bulk-invalidate ran. `invalidated` carries
  // the names that transitioned (REPL renders the count); `failed`
  // carries per-memory reasons (REPL renders the per-name line).
  | {
      kind: 'revoked';
      invalidated: { scope: 'project_shared'; name: string }[];
      failed: { name: string; reason: string }[];
    }
  // Modal answered 'cancel' (P1/M4-rob) OR re-fingerprint after
  // 'yes' detected drift during the prompt window (P0/F3 TOCTOU).
  // No state mutation; next boot re-prompts on persistent
  // divergence. `cause` distinguishes the two so the caller can
  // surface a clear stderr line.
  | {
      kind: 'deferred';
      hash: string;
      cause: 'modal_cancel' | 'tocttou_during_prompt';
    }
  // Fingerprint computation failed (e.g. EACCES on the shared root).
  // Caller MUST fail-closed — exclude the project_shared scope from
  // eager-load entirely. The system has no way to tell whether the
  // corpus is trustworthy when it can't even be read.
  | { kind: 'verify_failed'; sharedRoot: string };

// Stderr inventory dump emitted right before the trust modal opens
// (S5 IMP/F5). The modal preview caps at 8 files for layout
// stability; this dump gives the operator the FULL list so they
// can review out-of-band without canceling the modal. The
// warn-callback shape matches every other boot-time stderr emitter
// in the bootstrap (gc failures, provenance sweep, etc.) so
// `forja:` greps are uniform.
const dumpInventoryToStderr = (
  warn: ProbeSharedTrustInput['warn'],
  sharedRoot: string,
  mode: SharedTrustModalMode,
  corpusFiles: readonly ProbeCorpusFile[],
): void => {
  if (warn === undefined) return;
  const label = mode === 'first-visit' ? 'first-visit prompt' : 'drift prompt';
  warn(`${label} at ${sharedRoot} — full corpus inventory (${corpusFiles.length} files):`);
  if (corpusFiles.length === 0) {
    warn('  (corpus is currently empty)');
    return;
  }
  for (const f of corpusFiles) {
    // Two-space indent matches the audit/list slash output
    // convention; size in bytes for parity with the modal preview.
    warn(`  ${f.name} — ${f.bytes} bytes`);
  }
};

// List the current corpus inventory for modal rendering. Delegates
// to the shared `listSharedCorpusFiles` so the modal preview, the
// fingerprint, AND the `/memory trust status` slash all agree on
// what counts as "in the corpus" (including the symlink rejection
// imported from the substrate). For `absent` and `unreadable`
// listings the modal preview just renders an empty inventory; the
// caller already knows about verify_failed via the upstream hash
// path.
// Conditional spreads for the `recordEvent` audit-attribution
// fields. The substrate API needs `auditCwd?: string` and
// `sessionId?: string` (NOT `string | null`), while the probe's
// `ProbeSharedTrustInput` admits null on both. Inline spreads
// were repeated 3× in `bulkInvalidateShared`; centralized here
// for readability and so a future API tightening (e.g.,
// accepting null at the substrate) is one-line.
const auditAttribution = (
  input: ProbeSharedTrustInput,
): { auditCwd?: string; sessionId?: string } => ({
  ...(input.cwd != null ? { auditCwd: input.cwd } : {}),
  ...(input.sessionId != null ? { sessionId: input.sessionId } : {}),
});

const enumerateCorpus = (sharedRoot: string): ProbeCorpusFile[] => {
  const listing = listSharedCorpusFiles(sharedRoot);
  if (listing.kind !== 'present') return [];
  return listing.files;
};

// Bulk-transition every currently-`active` shared memory to
// `invalidated`. Used by the revoke path. Per-memory failures are
// collected and surfaced to the caller; one bad memory does NOT
// short-circuit the rest — when the operator just said "I don't
// trust this corpus", we want as many memories invalidated as
// possible.
//
// Hardening notes:
//   - P1/H2-rel: `actor: 'startup_probe'`. The bulk is fired by a
//     boot probe, not by `/memory <cmd>` — the `user` actor in the
//     audit row would mis-attribute to "operator typed a slash" in
//     `/memory audit` forensics. `motivo: security` already bypasses
//     cooldown/TTL gates per transitions.ts §gates so the functional
//     impact of the actor swap is nil; the attribution is the fix.
//   - P1/M3-rob: re-peek each memory's current state before the
//     transition. Concurrent boots can race past the initial
//     `registry.list({states:['active']})` snapshot; the second
//     process would otherwise hit `illegal_transition` against
//     memories the first process just invalidated. Skipping when
//     state ≠ 'active' converts the race into a silent no-op
//     rather than a failed audit row.
//   - P1/M1-rel: pre-flight failures (`illegal_transition`,
//     `invalid_evidence`, thrown errors) now ALSO emit a
//     `refused` memory_events row so `/memory audit` can surface
//     them. Stderr alone is not durable audit.
const bulkInvalidateShared = async (
  input: ProbeSharedTrustInput,
  presentedHash: string,
): Promise<{
  invalidated: { scope: 'project_shared'; name: string }[];
  failed: { name: string; reason: string }[];
}> => {
  const invalidated: { scope: 'project_shared'; name: string }[] = [];
  const failed: { name: string; reason: string }[] = [];

  // Initial snapshot under the registry's state filter — covers the
  // happy path where no other process is competing. The per-memory
  // re-peek below handles the concurrent-boot race.
  const candidates = input.registry.list({
    scope: 'project_shared',
    states: ['active'],
  });

  for (const listing of candidates) {
    // Re-peek state immediately before the transition. Another
    // process (concurrent boot, manual /memory write) may have
    // changed the memory's state since the candidate snapshot. If
    // it's no longer active, skip silently — the operator's revoke
    // intent is already satisfied for this memory by whoever
    // touched it.
    const peek = input.registry.peek(listing.name, { scope: listing.scope });
    if (peek.kind !== 'present') continue;
    const currentState = peek.file.frontmatter.state ?? 'active';
    if (currentState !== 'active') {
      // IMP/M3-rel hardening: skipping silently was a forensic
      // blind spot. Emit a `refused` row so /memory audit can
      // explain "why didn't memory FOO get invalidated when I
      // revoked trust at T?". The most common cause is a
      // concurrent boot or a slash command racing with the probe;
      // recording the observed state at skip-time gives the
      // operator a starting trail.
      input.registry.recordEvent({
        action: 'refused',
        scope: listing.scope,
        memoryName: listing.name,
        source: peek.file.frontmatter.source,
        details: {
          stage: 'trust_revoked_bulk',
          reason: 'state_changed_concurrently',
          previous_state: currentState,
          trigger: 'trust_revoked',
        },
        ...auditAttribution(input),
      });
      continue;
    }

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
        actor: 'startup_probe',
        evidence: {
          // §6.1 schema admits `trigger_source` for the security
          // motivo. We tag the source with both the detector name
          // and the hash so audit forensics can correlate the bulk
          // event to the exact corpus state that prompted
          // revocation. The hash is NOT a secret — it lands
          // verbatim through the audit redaction layer.
          trigger_source: 'shared_corpus_hash_changed',
          new_corpus_hash: presentedHash,
        },
        sessionId: input.sessionId ?? null,
        cwd: input.cwd ?? null,
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (result.kind === 'applied') {
        invalidated.push({ scope: 'project_shared', name: listing.name });
      } else {
        // Non-applied result kinds (illegal_transition,
        // invalid_evidence, io_error) get a durable audit row in
        // addition to the in-memory `failed` array and the stderr
        // warning. /memory audit surfaces these so the operator
        // can forensically reconstruct "why didn't this memory
        // get invalidated when I revoked trust?".
        const reason = result.kind === 'io_error' ? result.reason : result.kind;
        failed.push({ name: listing.name, reason });
        input.registry.recordEvent({
          action: 'refused',
          scope: listing.scope,
          memoryName: listing.name,
          source: peek.file.frontmatter.source,
          details: { stage: 'trust_revoked_bulk', reason, trigger: 'trust_revoked' },
          ...auditAttribution(input),
        });
        input.warn?.(`trust_revoked: failed invalidating ${listing.name}: ${reason}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ name: listing.name, reason });
      // Same audit-row treatment for thrown errors. Source comes
      // from the peek we already have on hand.
      input.registry.recordEvent({
        action: 'refused',
        scope: listing.scope,
        memoryName: listing.name,
        source: peek.file.frontmatter.source,
        details: { stage: 'trust_revoked_bulk', reason, trigger: 'trust_revoked' },
        ...auditAttribution(input),
      });
      input.warn?.(`trust_revoked: threw invalidating ${listing.name}: ${reason}`);
    }
  }

  return { invalidated, failed };
};

// Reusable shape: "operator was shown PRESENTED hash; modal returned
// 'yes'; check that the corpus didn't drift during the prompt window
// before stamping". Returns the path the probe should take.
//
// 'confirmed' → re-fingerprint matches presented; safe to stamp.
// 'drift'     → re-fingerprint differs OR substrate read failed
//               during the post-modal check. Defer with `tocttou`
//               cause.
type PostConfirmCheck = { kind: 'confirmed' } | { kind: 'drift' };

// P1/F1: takes the pre-modal `CorpusSnapshot` so the fast-path
// (stat-compare) can skip re-reading bodies when nothing on disk
// changed. Falls back to full re-fingerprint on any deviation;
// no security weakening (see CorpusSnapshot header).
const verifyConfirmedHash = (
  input: ProbeSharedTrustInput,
  presentedSnapshot: CorpusSnapshot,
): PostConfirmCheck => {
  const recomputed = recomputeSharedFingerprintIfStale(input.sharedRoot, presentedSnapshot);
  if (recomputed === null) return { kind: 'drift' };
  if (recomputed.hash !== presentedSnapshot.hash) return { kind: 'drift' };
  return { kind: 'confirmed' };
};

export const probeSharedTrust = async (
  input: ProbeSharedTrustInput,
): Promise<ProbeSharedTrustResult> => {
  // P1/F1: compute the snapshot once. `verifyConfirmedHash` will
  // re-use this snapshot's `(size, mtime)` per-file vector for a
  // stat-only fast-path; only the post-bulk re-fingerprint
  // (mandatory full recompute — frontmatter changed) reads bytes
  // again.
  const presented = computeSharedFingerprintWithSnapshot(input.sharedRoot);
  if (presented === null) {
    return { kind: 'verify_failed', sharedRoot: input.sharedRoot };
  }
  const presentedHash = presented.hash;

  const stored: SharedTrustRow | null = getSharedTrust(input.db, input.sharedRoot);

  // First-visit branch (P0/F2 hardening). If no trust row exists,
  // distinguish:
  //   - Empty corpus → silent seed. Nothing to consent to; the
  //     cwd-trust modal already covers the directory.
  //   - Non-empty corpus → modal in 'first-visit' mode. The operator
  //     must SEE the inventory and confirm. Silent-seeding a fresh
  //     clone of a poisoned repo would otherwise bless attacker-
  //     planted shared memories on the very first agent invocation.
  if (stored === null) {
    if (presentedHash === EMPTY_CORPUS_HASH) {
      setSharedTrust(input.db, input.sharedRoot, presentedHash, input.now?.());
      return { kind: 'seeded' };
    }
    const firstVisitCorpus = enumerateCorpus(input.sharedRoot);
    // IMP/F5 hardening: dump the full inventory to stderr BEFORE
    // the modal opens. The modal caps the visible list at 8; the
    // operator can switch terminals and read every file by name
    // without canceling (which would defer + re-prompt next boot).
    dumpInventoryToStderr(input.warn, input.sharedRoot, 'first-visit', firstVisitCorpus);
    const answer = await input.askSharedTrust({
      path: input.sharedRoot,
      corpusFiles: firstVisitCorpus,
      mode: 'first-visit',
    });
    if (answer === 'yes') {
      const check = verifyConfirmedHash(input, presented);
      if (check.kind === 'drift') {
        return { kind: 'deferred', hash: presentedHash, cause: 'tocttou_during_prompt' };
      }
      setSharedTrust(input.db, input.sharedRoot, presentedHash, input.now?.());
      return { kind: 'reconfirmed' };
    }
    if (answer === 'cancel') {
      return { kind: 'deferred', hash: presentedHash, cause: 'modal_cancel' };
    }
    // First-visit 'no': operator wants the corpus to NOT load.
    // Bulk-invalidate every active shared memory, then STAMP the
    // trust row with the post-invalidate hash so subsequent boots
    // recognize "we know about this state" and don't re-prompt
    // (CRIT/F2 hardening: prior behavior left the trust row null,
    // and the next boot's listing still found the same `.md`
    // files — only the frontmatter changed — producing a fresh
    // first-visit modal every boot, forever).
    //
    // The post-invalidate hash differs from `presentedHash`
    // because each invalidated body has its frontmatter `state:`
    // field flipped. Recompute after bulk; stamp the actual final
    // state.
    //
    // PARTIAL-FAILURE GATE: stamp ONLY when every memory
    // transitioned cleanly. If `failed.length > 0`, some active
    // shared memories survived (io_error, illegal_transition,
    // hook block, etc.). Stamping the new hash would let the
    // next boot's `unchanged` path re-enable the scope and
    // surface those survivors — exactly the content the operator
    // explicitly rejected. Leave the trust row untouched (still
    // null on first-visit) so the next boot fires the prompt
    // again and the operator can retry.
    const { invalidated, failed } = await bulkInvalidateShared(input, presentedHash);
    if (failed.length === 0) {
      const postRevokeHash = computeSharedFingerprint(input.sharedRoot) ?? presentedHash;
      setSharedTrust(input.db, input.sharedRoot, postRevokeHash, input.now?.());
    }
    return { kind: 'revoked', invalidated, failed };
  }

  if (stored.lastConfirmedHash === presentedHash) {
    return { kind: 'unchanged' };
  }

  // Drift branch — stored row exists but hash changed.
  const driftCorpus = enumerateCorpus(input.sharedRoot);
  // IMP/F5: see header on the first-visit dump above.
  dumpInventoryToStderr(input.warn, input.sharedRoot, 'drift', driftCorpus);
  const answer = await input.askSharedTrust({
    path: input.sharedRoot,
    corpusFiles: driftCorpus,
    mode: 'drift',
  });

  if (answer === 'yes') {
    const check = verifyConfirmedHash(input, presented);
    if (check.kind === 'drift') {
      // P0/F3 TOCTOU: operator confirmed the hash they SAW, but the
      // corpus changed during the prompt window. Don't stamp the
      // unconfirmed new state. Leave trust row pinned to OLD hash;
      // next boot re-prompts on the persistent divergence.
      return { kind: 'deferred', hash: presentedHash, cause: 'tocttou_during_prompt' };
    }
    setSharedTrust(input.db, input.sharedRoot, presentedHash, input.now?.());
    return { kind: 'reconfirmed' };
  }

  if (answer === 'cancel') {
    // P1/M4-rob: Esc / timeout / signal abort. Operator-intent is
    // ambiguous; we don't treat this as a destructive revoke.
    // Leave trust row pinned to OLD hash; next boot re-prompts.
    return { kind: 'deferred', hash: presentedHash, cause: 'modal_cancel' };
  }

  // Explicit 'no' — revoke path.
  //
  // P0/H1-rob ATOMICITY: bulk-invalidate FIRST, stamp trust row
  // AFTER. The previous (pre-hardening) order was clear → bulk,
  // which had a crash-window where active memories survived AND
  // the next boot re-seeded the row at current hash → no
  // re-prompt → surviving actives silently re-loaded.
  //
  // CRIT/F2 hardening adjusts the AFTER step from
  // `clearSharedTrust` to `setSharedTrust(post-invalidate-hash)`.
  // Clearing made the next boot fire the first-visit modal again
  // (corpus non-empty + null row), which is the same perpetual-
  // prompt loop the first-visit-no branch hit. Stamping the
  // POST-invalidate hash means subsequent boots see `unchanged`
  // (no modal); the invalidated frontmatter is the persistent
  // record of decline, and eager-load / retrieval already filter
  // it out.
  //
  // Crash-recovery semantics remain safe: if the process dies
  // mid-bulk, the trust row still pins the OLD hash (we haven't
  // stamped yet). Next boot recomputes — sees divergence (some
  // memories invalidated, some still active) — fires the modal
  // again; operator can re-revoke and the surviving actives get
  // a second chance.
  //
  // PARTIAL-FAILURE GATE (mirrors the first-visit-no path above):
  // when `failed.length > 0`, leave the trust row pinned to its
  // OLD hash. Surviving active shared memories (io_error,
  // illegal_transition, hook block) would otherwise be re-
  // exposed on the next boot's `unchanged` outcome. Keeping the
  // old hash forces a drift re-prompt next boot so the operator
  // can retry.
  const { invalidated, failed } = await bulkInvalidateShared(input, presentedHash);
  if (failed.length === 0) {
    const postRevokeHash = computeSharedFingerprint(input.sharedRoot) ?? presentedHash;
    setSharedTrust(input.db, input.sharedRoot, postRevokeHash, input.now?.());
  }
  return {
    kind: 'revoked',
    invalidated,
    failed,
  };
};
