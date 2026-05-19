// transitionMemoryState — memory's owner of the eviction contract
// (MEMORY.md §6.5 + EVICTION.md §3-§5).
//
// One async function orchestrates a lifecycle transition end-to-end:
//
//   1. Read current state from the frontmatter (default 'active').
//   2. Validate (from, to, motivo) via isLegalTransition.
//   3. If a fireHook callback is wired, fire the Eviction hook and
//      check the chain's blockedBy. If blocked, persist an
//      `outcome: 'blocked_by_hook'` eviction_events row + a
//      memory_events 'refused' row and return without mutating
//      file/index state.
//   4. Apply the transition to file/index per (from, to) — move to
//      tombstone, restore from tombstone, mutate frontmatter,
//      remove index entry, etc.
//   5. Persist the eviction_events 'applied' row + the matching
//      memory_events lifecycle action ('quarantined', 'evicted',
//      etc.) so the audit pair is coherent.
//
// What this slice (1.3.c1) ships: the contract. Wiring callers
// (verify-before-act in 1.3.c2, /memory delete in 1.3.c3, restore
// slash in 1.3.d) lands in subsequent slices.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { HookChainResult, HookEventPayload } from '../hooks/types.ts';
import type { DB } from '../storage/db.ts';
import {
  type EvictionActor,
  type EvictionMotivo,
  appendEvictionEvent,
  getLastQuarantineEvent,
  isLegalTransition,
  preflightValidateEvidence,
} from '../storage/repos/eviction-events.ts';
import { getEarliestMemoryCreatedAt } from '../storage/repos/memory-events.ts';
import { detectMemoryDependents } from './dependents.ts';
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.ts';
import {
  type ParsedIndex,
  parseIndex,
  removeIndexEntry,
  serializeIndex,
  upsertIndexEntry,
} from './index-file.ts';
import { readMemoryByName } from './loader.ts';
import { type ScopeRoots, indexFilePath, memoryFilePath } from './paths.ts';
import type { MemoryRegistry } from './registry.ts';
import { findLatestTombstone, moveToTombstone, removeFromTombstones } from './tombstones.ts';
import type { IndexEntry, MemoryFile, MemoryScope, MemoryState } from './types.ts';

export interface TransitionMemoryStateInput {
  // DB handle for the eviction_events INSERT.
  db: DB;
  // Memory registry — used to record the paired memory_events row
  // (same audit pair the registry already emits for write/promote
  // flows). The registry's recordEvent path silently swallows
  // SQLite errors so audit drift surfaces as stderr, not throw —
  // matches the file/index applied path that propagates io errors.
  registry: MemoryRegistry;
  roots: ScopeRoots;
  scope: MemoryScope;
  name: string;
  toState: MemoryState;
  motivo: EvictionMotivo;
  // §5.1 trigger vocabulary. Free TEXT in the eviction_events
  // schema; caller picks the right canonical name.
  trigger: string;
  actor: EvictionActor;
  // Optional per-motivo evidence payload (§6.1). Will be
  // JSON-serialized + scrubbed (paths/hosts/secrets) before
  // INSERT — the repo's appendEvictionEvent owns redaction.
  evidence?: Record<string, unknown>;
  sessionId?: string | null;
  cwd?: string | null;
  // Optional hook chain. When wired (REPL context, eventually), a
  // blocking hook prevents the transition; the resulting
  // `blocked_by_hook` outcome is audited but no file/index change
  // happens. Headless / tests with no hook engine leave this
  // unset and skip the hook gate entirely.
  fireHook?: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  // Optional retention end for evicted rows. When omitted and
  // toState='evicted', purge_at is left NULL (caller-supplied
  // retention isn't decided yet — the GC sweep that materializes
  // evicted→purged isn't in this slice's scope).
  purgeAt?: number | null;
  // Optional time source — test-only override. Production uses
  // Date.now via moveToTombstone's default.
  now?: () => number;
}

export type TransitionMemoryStateResult =
  | {
      kind: 'applied';
      fromState: MemoryState;
      toState: MemoryState;
      evictionEventId: string;
      // Set when the transition materialized a tombstone (active/
      // quarantined/invalidated/proposed → evicted).
      tombstonePath?: string;
      tombstoneTs?: number;
    }
  | {
      kind: 'blocked_by_protection';
      fromState: MemoryState;
      toState: MemoryState;
      evictionEventId: string;
      // Canonical protection name — `'user_explicit_cooldown'`,
      // `'quarantine_min_ttl'`, or future protection slot. Forensic
      // queries pivot on this string.
      protection: string;
      // Operator-facing description with the gauge value (e.g.
      // "created 24h ago; 72h cooldown not yet elapsed").
      reason: string;
    }
  | {
      kind: 'blocked_by_hook';
      fromState: MemoryState;
      toState: MemoryState;
      evictionEventId: string;
      blockedBy: string;
      reason: string | null;
    }
  | { kind: 'illegal_transition'; fromState: MemoryState; toState: MemoryState; reason: string }
  // Evidence shape failed pre-flight schema validation (§6.1).
  // The transition was refused BEFORE any disk mutation — no
  // file moved, no audit row written. Distinct from
  // `illegal_transition` (state machine refused the from/to/motivo
  // tuple) because the failure is in the operator-provided
  // payload, not the requested transition.
  | {
      kind: 'invalid_evidence';
      fromState: MemoryState;
      toState: MemoryState;
      reason: string;
    }
  | { kind: 'unknown' }
  // The on-disk transition completed (file/index mutated) but the
  // eviction_events INSERT failed afterward. Distinct from
  // io_error so callers can render the right copy — the body has
  // already moved, and surfacing "delete failed" would mislead.
  // tombstonePath is set when the transition materialized one
  // (active→evicted) so the caller can point at the partial
  // state for manual reconciliation.
  | {
      kind: 'audit_drift';
      fromState: MemoryState;
      toState: MemoryState;
      reason: string;
      tombstonePath?: string;
      tombstoneTs?: number;
    }
  | { kind: 'io_error'; reason: string };

// ─── helpers ─────────────────────────────────────────────────────────

const INDEX_HEADER = '# Memory index';

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Atomic file write — mirror of lifecycle.ts/writer.ts shape.
// crypto.randomUUID() for tmp suffix (uniform with
// appendEvictionEvent + memory_events id generation; the older
// process.pid + Math.random() shape collides if two processes
// share pid % 2^16 and produce the same Math.random() slice,
// which is theoretical but Math.random() seeded the same on
// process clone is real on some platforms).
const atomicWrite = (path: string, content: string): void => {
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

const loadOrEmptyIndex = (path: string): ParsedIndex => {
  try {
    return parseIndex(readFileSync(path, 'utf-8'));
  } catch (err) {
    if (isEnoent(err)) return { entries: [], malformedLines: [] };
    throw err;
  }
};

// Write the file's frontmatter back to disk with `state` set to
// `nextState`. Omits the field when `nextState === 'active'` and
// the file's source didn't carry it — keeps the canonical "no
// state field == active" convention. Both signals from the file
// matter: a user-edited file that explicitly wrote `state: active`
// retains the field for round-trip stability.
const writeFrontmatterState = (
  roots: ScopeRoots,
  scope: MemoryScope,
  name: string,
  current: MemoryFile,
  nextState: MemoryState,
): void => {
  const newFm = { ...current.frontmatter };
  if (nextState === 'active' && current.frontmatter.state === undefined) {
    // Source had no state field and the target is the default —
    // preserve absence.
    delete newFm.state;
  } else {
    newFm.state = nextState;
  }
  atomicWrite(
    memoryFilePath(roots, scope, name),
    serializeMemoryFile({ frontmatter: newFm, body: current.body }),
  );
};

const indexEntryForFile = (file: MemoryFile): IndexEntry => ({
  title: file.frontmatter.description,
  href: `${file.frontmatter.name}.md`,
  hook: file.frontmatter.description,
});

const upsertEntry = (roots: ScopeRoots, scope: MemoryScope, file: MemoryFile): void => {
  const indexPath = indexFilePath(roots, scope);
  const parsed = loadOrEmptyIndex(indexPath);
  const next = upsertIndexEntry(parsed.entries, indexEntryForFile(file));
  const serialized = serializeIndex(next, { header: INDEX_HEADER });
  atomicWrite(indexPath, serialized.text);
};

const removeEntryFromIndex = (roots: ScopeRoots, scope: MemoryScope, name: string): boolean => {
  const indexPath = indexFilePath(roots, scope);
  const parsed = loadOrEmptyIndex(indexPath);
  const href = `${name}.md`;
  const had = parsed.entries.some((e) => e.href === href);
  if (!had) return false;
  const next = removeIndexEntry(parsed.entries, href);
  const serialized = serializeIndex(next, { header: INDEX_HEADER });
  atomicWrite(indexPath, serialized.text);
  return true;
};

// Result shape for the per-transition handlers.
interface ApplyResult {
  tombstonePath?: string;
  tombstoneTs?: number;
}

// Apply the file/index mutation for a (from, to) tuple. Throws on
// I/O errors so transitionMemoryState's outer try/catch maps them
// to `kind: 'io_error'`. `cachedTombstone` is the result of the
// findLatestTombstone scan the caller already performed (in stage
// 1) — passed through so we don't re-scan `.tombstones/` from the
// purged/active branches.
const applyTransition = (
  input: TransitionMemoryStateInput,
  current: MemoryFile,
  fromState: MemoryState,
  toState: MemoryState,
  cachedTombstone: ReturnType<typeof findLatestTombstone>,
): ApplyResult => {
  const { roots, scope, name } = input;
  switch (toState) {
    case 'evicted': {
      // Write frontmatter with state=evicted (so the tombstone
      // carries the correct state), then rename body into
      // .tombstones/, then drop the index entry.
      writeFrontmatterState(roots, scope, name, current, 'evicted');
      const r = moveToTombstone(roots, scope, name, {
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      removeEntryFromIndex(roots, scope, name);
      return { tombstonePath: r.tombstonePath, tombstoneTs: r.ts };
    }
    case 'purged': {
      if (fromState === 'evicted') {
        // Body is in .tombstones/. Caller-cached tombstone is
        // authoritative — same scan that derived fromState.
        if (cachedTombstone !== null) {
          removeFromTombstones(roots, scope, name, cachedTombstone.ts);
        }
        // Index already cleared on active→evicted. No-op here.
        return {};
      }
      // Direct purge (bypass tombstone) for user_purge/security
      // from active/quarantined/invalidated/proposed.
      const bodyPath = memoryFilePath(roots, scope, name);
      try {
        unlinkSync(bodyPath);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      removeEntryFromIndex(roots, scope, name);
      return {};
    }
    case 'active': {
      if (fromState === 'evicted') {
        // Restore: copy tombstone content back to body path,
        // remove tombstone, re-insert index entry.
        //
        // Idempotency on retry: if the scope-root body file
        // ALREADY exists, a prior restore attempt landed the body
        // but failed before tombstone removal / index upsert.
        // Re-reading the tombstone now would overwrite operator
        // edits made between the partial restore and this retry
        // — instead, treat the existing body as authoritative,
        // skip the body write, finalize the index entry, and
        // clean up the stale tombstone. The transition still
        // reaches the canonical end state (body at scope root,
        // tombstone gone, index entry present, state=active).
        if (cachedTombstone === null) {
          throw new Error(`no tombstone to restore for ${scope}/${name}`);
        }
        const bodyPath = memoryFilePath(roots, scope, name);
        const bodyAlreadyExists = existsSync(bodyPath);
        let restoredFile: MemoryFile;
        if (bodyAlreadyExists) {
          // Re-read scope-root body — operator edits since the
          // partial restore are authoritative. Frontmatter `state`
          // (which would be 'evicted' if untouched from the prior
          // attempt) gets normalized below.
          restoredFile = parseMemoryFile(readFileSync(bodyPath, 'utf-8'));
        } else {
          const raw = readFileSync(cachedTombstone.path, 'utf-8');
          restoredFile = parseMemoryFile(raw);
        }
        // Strip `state` field on the restored frontmatter. Per
        // the spec convention (absence === active), the canonical
        // restored shape has no state field. Edge case: a
        // future caller that bypasses transitionMemoryState
        // could land a tombstone with non-'evicted' state in the
        // frontmatter; we still normalize to "absent" here
        // because the canonical restored shape is unambiguous.
        // An operator who wants an explicit `state: active`
        // marker can hand-edit after restore.
        const newFm = { ...restoredFile.frontmatter };
        delete newFm.state;
        const finalFile: MemoryFile = { frontmatter: newFm, body: restoredFile.body };
        atomicWrite(bodyPath, serializeMemoryFile(finalFile));
        upsertEntry(roots, scope, finalFile);
        removeFromTombstones(roots, scope, name, cachedTombstone.ts);
        return {};
      }
      // From proposed or quarantined: strip the state field on
      // disk (canonical active shape has no state — absence
      // equals active per MEMORY §3.1.1) and ensure index entry
      // present (proposed wasn't indexed; quarantined was —
      // upsert is idempotent). Symmetric with the evicted→active
      // branch above; an explicit `state: active` left on the
      // file after restore would be redundant noise.
      const fmActive = { ...current.frontmatter };
      delete fmActive.state;
      const restoredQuar: MemoryFile = { frontmatter: fmActive, body: current.body };
      atomicWrite(memoryFilePath(roots, scope, name), serializeMemoryFile(restoredQuar));
      upsertEntry(roots, scope, restoredQuar);
      return {};
    }
    case 'quarantined': {
      // Update frontmatter; KEEP index entry (visible with flag
      // per spec §6.5.2; the rendering layer adds the marker).
      writeFrontmatterState(roots, scope, name, current, 'quarantined');
      // Ensure index entry still reflects the description (it
      // might have been edited mid-quarantine in a future flow).
      upsertEntry(roots, scope, {
        frontmatter: { ...current.frontmatter, state: 'quarantined' },
        body: current.body,
      });
      return {};
    }
    case 'invalidated': {
      // Update frontmatter, remove from index (not visible per
      // §3.1.1). File stays on disk so operator can investigate.
      writeFrontmatterState(roots, scope, name, current, 'invalidated');
      removeEntryFromIndex(roots, scope, name);
      return {};
    }
    case 'proposed': {
      // State machine doesn't admit any FROM-state into proposed
      // — proposed is admission-only, created at write time.
      // isLegalTransition would have already refused; this branch
      // is defensive.
      throw new Error(`proposed is admission-only; transition from ${fromState} not supported`);
    }
  }
};

// Map (fromState, toState) → MemoryEventAction. Returns null for
// transitions that don't have a meaningful action in the
// memory_events vocabulary (none today — all canonical transitions
// map). Future state addition without a matching action would
// surface here as null and skip the audit row, but the
// eviction_events row still lands.
const mapToMemoryAction = (
  fromState: MemoryState,
  toState: MemoryState,
):
  | 'created'
  | 'quarantined'
  | 'invalidated'
  | 'evicted'
  | 'restored'
  | 'purged'
  | 'refused'
  | null => {
  if (fromState === 'proposed' && toState === 'active') return 'created';
  if (fromState === 'proposed' && toState === 'evicted') return 'refused';
  if (toState === 'quarantined') return 'quarantined';
  if (toState === 'invalidated') return 'invalidated';
  if (toState === 'evicted') return 'evicted';
  if (toState === 'purged') return 'purged';
  if (toState === 'active' && (fromState === 'quarantined' || fromState === 'evicted')) {
    return 'restored';
  }
  return null;
};

// ─── protection gates (EVICTION §6.2) ────────────────────────────────
//
// Implemented gates (memory-applicable):
//   - user_explicit cooldown: memory with `source: user_explicit`
//     created < 72h ago can't be evicted via `low_roi` or
//     `irrelevant` motivos. Premise: operator just authored it,
//     sample size is insufficient.
//   - quarantine min TTL: `quarantined → evicted` blocked until
//     the memory has been quarantined > 7d. Premise: re-promotion
//     gate (1.3.c2 once verify-before-act ships) needs dwell time
//     to gather evidence; a faster eviction bypasses the gate.
//
// Deferred (spec §6.2, depends on missing subsystems):
//   - Pinned items (context engine slot pinning)
//   - Active session-scope policy (adaptation subsystem)
//
// Bypass rules:
//   - `actor: 'user'` ALWAYS bypasses both gates. Operator typed
//     `/memory delete` or `/memory restore`; they're overriding
//     the automated protection.
//   - motivos `user_purge` and `security` bypass cooldown (the
//     spec lists `low_roi` / `irrelevant` explicitly; security
//     purge is a deliberate operator/hook action).
//   - motivos `user_purge` and `security` bypass quarantine TTL
//     (a security-driven eviction can't wait for the dwell
//     window to expire).
//   - `trigger: 'expired_at'` bypasses cooldown. Premise: the
//     operator authored both the memory AND its `expires` date —
//     when the calendar date arrives, expiry is the second
//     explicit consent, not a sample-size-insufficient automated
//     decision. The cooldown protects against `low_roi` firing
//     too early on fresh memories; an explicit expiry that
//     happens to fall inside the 72h window was deliberately set
//     short by the operator and must still fire. `motivo` stays
//     `low_roi` because the state machine doesn't admit `expired`
//     on active→quarantined (closest-fit per lifecycle.ts §357
//     comment); the trigger field carries the real semantics.

const USER_EXPLICIT_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const QUARANTINE_MIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ProtectionCheck = { blocked: false } | { blocked: true; protection: string; reason: string };

const checkProtectionGates = (
  db: DB,
  input: TransitionMemoryStateInput,
  currentFile: MemoryFile,
  fromState: MemoryState,
  toState: MemoryState,
  nowMs: number,
): ProtectionCheck => {
  // Operator-driven actor always bypasses — `/memory delete` and
  // `/memory restore` are the operator's explicit override.
  if (input.actor === 'user') return { blocked: false };

  // Short-circuit: neither gate fires unless the transition targets
  // a state where eviction-side protection makes sense. `active →
  // shadow`, `quarantined → active` (restore), `evicted → active`
  // (restore), `proposed → active` (admission) etc. don't carry
  // cooldown / TTL semantics — the gates are eviction-shaped.
  const targetsEvictionShape =
    toState === 'quarantined' || toState === 'evicted' || toState === 'purged';
  if (!targetsEvictionShape) return { blocked: false };

  // Cooldown bypass: security + user_purge motivos can't wait;
  // expired_at trigger represents the operator's explicit calendar
  // consent and must fire even inside the 72h window (see
  // checkProtectionGates header).
  const motivoCanWaitCooldown = input.motivo !== 'security' && input.motivo !== 'user_purge';
  const triggerCanWaitCooldown = input.trigger !== 'expired_at';

  // Gate 1: user_explicit cooldown
  if (
    motivoCanWaitCooldown &&
    triggerCanWaitCooldown &&
    currentFile.frontmatter.source === 'user_explicit' &&
    (input.motivo === 'low_roi' || input.motivo === 'irrelevant') &&
    (toState === 'quarantined' || toState === 'evicted' || toState === 'purged')
  ) {
    const createdAt = getEarliestMemoryCreatedAt(db, input.scope, input.name);
    if (createdAt !== null) {
      const ageMs = nowMs - createdAt;
      if (ageMs < USER_EXPLICIT_COOLDOWN_MS) {
        const hoursElapsed = Math.floor(ageMs / 3_600_000);
        return {
          blocked: true,
          protection: 'user_explicit_cooldown',
          reason: `user_explicit memory created ${hoursElapsed}h ago; 72h cooldown not yet elapsed (eviction by '${input.motivo}' blocked)`,
        };
      }
    }
  }

  // Gate 2: quarantine min TTL
  const motivoCanWaitTtl = input.motivo !== 'security' && input.motivo !== 'user_purge';
  if (fromState === 'quarantined' && toState === 'evicted' && motivoCanWaitTtl) {
    const quarantineEv = getLastQuarantineEvent(db, 'memory', input.name, input.scope);
    if (quarantineEv !== null) {
      // Same-chain bypass: when the quarantine event was emitted
      // by the SAME (actor, trigger) tuple as the current
      // transition attempt, the two transitions are one decision
      // (e.g., gcExpiredMemories's active→quarantined→evicted is
      // a single boot-time GC decision with
      // actor='startup_probe' + trigger='expired_at'). The TTL
      // protects against DIFFERENT automated processes
      // fast-evicting memories someone else just quarantined —
      // not against decomposed pipelines from the same source.
      const sameChain =
        quarantineEv.actor === input.actor && quarantineEv.trigger === input.trigger;
      if (!sameChain) {
        const dwellMs = nowMs - quarantineEv.recordedAt;
        if (dwellMs < QUARANTINE_MIN_TTL_MS) {
          const daysElapsed = Math.floor(dwellMs / 86_400_000);
          return {
            blocked: true,
            protection: 'quarantine_min_ttl',
            reason: `quarantined ${daysElapsed}d ago by ${quarantineEv.actor}/${quarantineEv.trigger}; 7d min TTL not yet elapsed (eviction by '${input.motivo}' blocked)`,
          };
        }
      }
    }
  }

  return { blocked: false };
};

// ─── public API ──────────────────────────────────────────────────────

export const transitionMemoryState = async (
  input: TransitionMemoryStateInput,
): Promise<TransitionMemoryStateResult> => {
  // 1. Read current memory + derive fromState. For evicted-source
  // transitions (restore / purge), the body lives in .tombstones/
  // — readMemoryByName looks at the body path which has been
  // moved, so we need a different source-of-truth.
  let currentFile: MemoryFile;
  let fromState: MemoryState;

  const tomb = findLatestTombstone(input.roots, input.scope, input.name);
  const tombExists = tomb !== null;

  const fileResult = readMemoryByName(input.roots, input.scope, input.name);
  if (fileResult.kind === 'present') {
    currentFile = fileResult.file;
    fromState = currentFile.frontmatter.state ?? 'active';
  } else if (tombExists) {
    // Body lives in .tombstones/ — read from there. fromState is
    // derived as 'evicted' (the tombstone carries the moment of
    // eviction; further evolution from tombstone is purge or
    // restore).
    try {
      const raw = readFileSync(tomb.path, 'utf-8');
      currentFile = parseMemoryFile(raw);
      fromState = 'evicted';
    } catch (err) {
      return {
        kind: 'io_error',
        reason: `failed reading tombstone for ${input.scope}/${input.name}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    return { kind: 'unknown' };
  }

  const { toState } = input;

  // 2. Validate transition via the canonical state machine.
  const check = isLegalTransition(fromState, toState, input.motivo);
  if (!check.ok) {
    return { kind: 'illegal_transition', fromState, toState, reason: check.reason };
  }

  // 2b. Pre-flight evidence schema validation (§6.1). Refuse
  // malformed evidence BEFORE applyTransition so a caller bug
  // doesn't produce file/index mutations that the audit row
  // would never witness (the in-repo validation in
  // appendEvictionEvent runs at stage 5, AFTER applyTransition,
  // which would surface a real audit_drift). Same outcome=applied
  // gate the repo applies — non-applied paths (blocked_by_hook,
  // protection blocks, same-state pseudo) record an attempted
  // gate not real evidence, so they skip pre-flight too.
  // Same-state (trigger_fired_no_action) lands as outcome !=
  // 'applied' downstream; skip pre-flight here so the early
  // return for same-state doesn't trip evidence checks.
  if (fromState !== toState) {
    const evidenceJsonForPreflight = JSON.stringify(input.evidence ?? {});
    const evCheck = preflightValidateEvidence(input.motivo, evidenceJsonForPreflight);
    if (!evCheck.ok) {
      return {
        kind: 'invalid_evidence',
        fromState,
        toState,
        reason: evCheck.reason ?? 'evidence validation failed',
      };
    }
  }

  // Same-state pseudo-transition: nothing to apply, nothing to
  // audit as 'applied'. Caller hit this by mistake; we surface a
  // no-op 'applied' row so the trail records the trigger fire
  // without claiming work happened. Distinct from real applied
  // outcomes via fromState === toState in the audit row.
  //
  // recordedAt is derived from input.now() when supplied so two
  // back-to-back transitions in the same test fixture (with
  // different `now()` values) land deterministically ordered. In
  // production where input.now is unset, appendEvictionEvent
  // falls back to Date.now(); same-ms collisions tie-break by
  // SQLite rowid DESC (monotonic on INSERT for this append-only
  // table) per the query layer.
  const recordedAt = input.now !== undefined ? input.now() : undefined;
  if (fromState === toState) {
    // Inject the trigger name as `trigger_source` marker so the
    // repo-side non-applied marker gate (eviction-events §6.1)
    // accepts the row. Forensic queries can match on
    // `evidence_json->>'$.trigger_source'` without joining the
    // `trigger` column. Caller-supplied `trigger_source` (rare —
    // explicit override) wins.
    const baseEvidence =
      input.evidence !== undefined && input.evidence !== null ? input.evidence : {};
    const withMarker =
      typeof baseEvidence === 'object' && !Array.isArray(baseEvidence)
        ? { trigger_source: input.trigger, ...(baseEvidence as Record<string, unknown>) }
        : baseEvidence;
    const evidenceJson = JSON.stringify(withMarker);
    try {
      const ev = appendEvictionEvent(input.db, {
        substrate: 'memory',
        objectId: input.name,
        objectScope: input.scope,
        fromState,
        toState,
        trigger: input.trigger,
        motivo: input.motivo,
        evidenceJson,
        outcome: 'trigger_fired_no_action',
        actor: input.actor,
        sessionId: input.sessionId ?? null,
        ...(recordedAt !== undefined ? { recordedAt } : {}),
      });
      return {
        kind: 'applied',
        fromState,
        toState,
        evictionEventId: ev.id,
      };
    } catch (err) {
      return {
        kind: 'io_error',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 3a. Protection gates (EVICTION §6.2). Run BEFORE hook fire so a
  // protection refusal lands before any hook side-effect. Hook
  // gating layers on top of protection — protection is structural
  // (cooldown / TTL math), hook is policy-driven. Bypass rules
  // declared in checkProtectionGates' header: actor=user always
  // bypasses; motivos user_purge / security bypass too.
  const evidenceJson = JSON.stringify(input.evidence ?? {});
  const nowMsForGates = input.now !== undefined ? input.now() : Date.now();
  const protectionCheck = checkProtectionGates(
    input.db,
    input,
    currentFile,
    fromState,
    toState,
    nowMsForGates,
  );
  if (protectionCheck.blocked) {
    let evId: string;
    try {
      const ev = appendEvictionEvent(input.db, {
        substrate: 'memory',
        objectId: input.name,
        objectScope: input.scope,
        fromState,
        toState: fromState, // refused — state didn't change
        trigger: input.trigger,
        motivo: input.motivo,
        evidenceJson,
        outcome: 'blocked_by_protection',
        blockedBy: protectionCheck.protection,
        actor: input.actor,
        sessionId: input.sessionId ?? null,
        ...(recordedAt !== undefined ? { recordedAt } : {}),
      });
      evId = ev.id;
    } catch (err) {
      return {
        kind: 'io_error',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    input.registry.recordEvent({
      action: 'refused',
      scope: input.scope,
      memoryName: input.name,
      source: currentFile.frontmatter.source,
      details: {
        stage: 'eviction_protection',
        proposed_to_state: toState,
        motivo: input.motivo,
        trigger: input.trigger,
        protection: protectionCheck.protection,
        reason: protectionCheck.reason,
      },
      ...(input.sessionId !== undefined && input.sessionId !== null
        ? { auditSessionId: input.sessionId }
        : {}),
      ...(input.cwd !== undefined && input.cwd !== null ? { auditCwd: input.cwd } : {}),
    });
    return {
      kind: 'blocked_by_protection',
      fromState,
      toState,
      evictionEventId: evId,
      protection: protectionCheck.protection,
      reason: protectionCheck.reason,
    };
  }

  // 3b. Fire Eviction hook when wired. Skipped when fireHook is
  // unset (headless / tests without hook plumbing) — same pattern
  // memory_write uses for confirmMemoryWrite.
  if (input.fireHook !== undefined && input.sessionId !== undefined && input.sessionId !== null) {
    const sessionIdForHook = input.sessionId;
    const chain = await input.fireHook({
      schema: 'v1',
      event: 'Eviction',
      sessionId: sessionIdForHook,
      data: {
        substrate: 'memory',
        objectId: input.name,
        objectScope: input.scope,
        fromState,
        toState,
        trigger: input.trigger,
        motivo: input.motivo,
        actor: input.actor,
        evidenceJson,
      },
    });
    if (chain !== null && chain.blockedBy !== null) {
      const block = chain.blockedBy;
      const blockedByStr = `${block.spec.layer}:${block.spec.sourcePath}#${block.spec.entryIndex}`;
      let evId: string;
      try {
        const ev = appendEvictionEvent(input.db, {
          substrate: 'memory',
          objectId: input.name,
          objectScope: input.scope,
          fromState,
          toState: fromState, // state didn't change — the proposed transition was refused
          trigger: input.trigger,
          motivo: input.motivo,
          evidenceJson,
          outcome: 'blocked_by_hook',
          blockedBy: blockedByStr,
          actor: input.actor,
          sessionId: input.sessionId ?? null,
          ...(recordedAt !== undefined ? { recordedAt } : {}),
        });
        evId = ev.id;
      } catch (err) {
        return {
          kind: 'io_error',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      input.registry.recordEvent({
        action: 'refused',
        scope: input.scope,
        memoryName: input.name,
        source: currentFile.frontmatter.source,
        details: {
          stage: 'eviction_hook',
          proposed_to_state: toState,
          motivo: input.motivo,
          trigger: input.trigger,
          blocked_by: blockedByStr,
          ...(block.message !== null ? { message: block.message } : {}),
        },
        ...(input.sessionId !== undefined && input.sessionId !== null
          ? { auditSessionId: input.sessionId }
          : {}),
        ...(input.cwd !== undefined && input.cwd !== null ? { auditCwd: input.cwd } : {}),
      });
      return {
        kind: 'blocked_by_hook',
        fromState,
        toState,
        evictionEventId: evId,
        blockedBy: blockedByStr,
        reason: block.message,
      };
    }
  }

  // 4a. Detect dependents BEFORE applyTransition. The cascading
  // detector (EVICTION §6.4) walks every memory in the registry
  // looking for `[[evictedName]]` or `[link](evictedName.md)`
  // references. Detection must precede the file mutation because
  // the registry's in-memory snapshot is what we walk — running
  // after the eviction would still work (the function skips the
  // evicted memory itself) but the registry state is consistent
  // with the audit trail this way. Only fires for *→evicted
  // transitions; restore / quarantine / invalidated transitions
  // don't carry cascade semantics per §6.4.
  let dependentsJson: string | null = null;
  if (toState === 'evicted') {
    const dependents = detectMemoryDependents(input.registry, input.scope, input.name);
    if (dependents.length > 0) {
      dependentsJson = JSON.stringify(dependents);
    }
  }

  // 4b. Apply transition (file + index). Failures here surface as
  // io_error; the audit row is NOT written because the disk state
  // is in-flight (writing a row that says "applied" while the file
  // is in an unknown state would be worse than no row).
  let applyResult: ApplyResult;
  try {
    applyResult = applyTransition(input, currentFile, fromState, toState, tomb);
  } catch (err) {
    return {
      kind: 'io_error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // 5. Persist audit pair: eviction_events 'applied' + memory_events
  // lifecycle row. The recordEvent path is fail-soft (registry's
  // recordEvent swallows SQLite errors with stderr "AUDIT DRIFT")
  // so we don't bail when only the memory_events write fails.
  let evictionEventId: string;
  try {
    const ev = appendEvictionEvent(input.db, {
      substrate: 'memory',
      objectId: input.name,
      objectScope: input.scope,
      fromState,
      toState,
      trigger: input.trigger,
      motivo: input.motivo,
      evidenceJson,
      outcome: 'applied',
      actor: input.actor,
      sessionId: input.sessionId ?? null,
      dependentsJson,
      ...(recordedAt !== undefined ? { recordedAt } : {}),
      ...(toState === 'evicted' ? { purgeAt: input.purgeAt ?? null } : {}),
    });
    evictionEventId = ev.id;
  } catch (err) {
    // The file/index already moved. eviction_events INSERT failed
    // afterwards — distinct surface from io_error so callers can
    // render the right copy ("file moved, audit trail missing —
    // manual reconciliation needed") instead of misleading the
    // operator with "delete failed."
    return {
      kind: 'audit_drift',
      fromState,
      toState,
      reason: `eviction_events write failed after file mutation: ${err instanceof Error ? err.message : String(err)}`,
      ...(applyResult.tombstonePath !== undefined
        ? { tombstonePath: applyResult.tombstonePath }
        : {}),
      ...(applyResult.tombstoneTs !== undefined ? { tombstoneTs: applyResult.tombstoneTs } : {}),
    };
  }

  const action = mapToMemoryAction(fromState, toState);
  if (action !== null) {
    input.registry.recordEvent({
      action,
      scope: input.scope,
      memoryName: input.name,
      source: currentFile.frontmatter.source,
      details: {
        from_state: fromState,
        to_state: toState,
        motivo: input.motivo,
        trigger: input.trigger,
        eviction_event_id: evictionEventId,
        ...(applyResult.tombstoneTs !== undefined ? { tombstone_ts: applyResult.tombstoneTs } : {}),
      },
      ...(input.sessionId !== undefined && input.sessionId !== null
        ? { auditSessionId: input.sessionId }
        : {}),
      ...(input.cwd !== undefined && input.cwd !== null ? { auditCwd: input.cwd } : {}),
    });
  }

  return {
    kind: 'applied',
    fromState,
    toState,
    evictionEventId,
    ...(applyResult.tombstonePath !== undefined
      ? { tombstonePath: applyResult.tombstonePath }
      : {}),
    ...(applyResult.tombstoneTs !== undefined ? { tombstoneTs: applyResult.tombstoneTs } : {}),
  };
};
