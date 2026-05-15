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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HookChainResult, HookEventPayload } from '../hooks/types.ts';
import type { DB } from '../storage/db.ts';
import {
  type EvictionActor,
  type EvictionMotivo,
  appendEvictionEvent,
  isLegalTransition,
} from '../storage/repos/eviction-events.ts';
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
      kind: 'blocked_by_hook';
      fromState: MemoryState;
      toState: MemoryState;
      evictionEventId: string;
      blockedBy: string;
      reason: string | null;
    }
  | { kind: 'illegal_transition'; fromState: MemoryState; toState: MemoryState; reason: string }
  | { kind: 'unknown' }
  | { kind: 'io_error'; reason: string };

// ─── helpers ─────────────────────────────────────────────────────────

const INDEX_HEADER = '# Memory index';

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Atomic file write — mirror of lifecycle.ts/writer.ts shape.
const atomicWrite = (path: string, content: string): void => {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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
// to `kind: 'io_error'`.
const applyTransition = (
  input: TransitionMemoryStateInput,
  current: MemoryFile,
  fromState: MemoryState,
  toState: MemoryState,
): ApplyResult => {
  const { roots, scope, name } = input;
  // Common case: most transitions just update the frontmatter
  // state field. Move/restore/purge paths override below.
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
        // Body is in .tombstones/. Find + remove.
        const tomb = findLatestTombstone(roots, scope, name);
        if (tomb !== null) {
          removeFromTombstones(roots, scope, name, tomb.ts);
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
        // drop the state field (or set state=active explicitly
        // depending on the tombstone's frontmatter), remove
        // tombstone, re-insert index entry.
        const tomb = findLatestTombstone(roots, scope, name);
        if (tomb === null) {
          throw new Error(`no tombstone to restore for ${scope}/${name}`);
        }
        const raw = readFileSync(tomb.path, 'utf-8');
        const tombFile = parseMemoryFile(raw);
        const newFm = { ...tombFile.frontmatter };
        delete newFm.state;
        const restored: MemoryFile = { frontmatter: newFm, body: tombFile.body };
        atomicWrite(memoryFilePath(roots, scope, name), serializeMemoryFile(restored));
        upsertEntry(roots, scope, restored);
        removeFromTombstones(roots, scope, name, tomb.ts);
        return {};
      }
      // From proposed or quarantined: update frontmatter,
      // ensure index entry present (proposed wasn't indexed;
      // quarantined was — upsert is idempotent).
      writeFrontmatterState(roots, scope, name, current, 'active');
      // Build a temp file shape without the `state` field for
      // upsertEntry's index logic. The state field on the index
      // entry doesn't change — upsert reads description/href/hook
      // only.
      const fmActive = { ...current.frontmatter };
      delete fmActive.state;
      upsertEntry(roots, scope, { frontmatter: fmActive, body: current.body });
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
  // The switch is exhaustive over MemoryState; if a new state
  // ever lands without adding a case, control would fall through
  // and TS would warn at the function level (no return).
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

  // Same-state pseudo-transition: nothing to apply, nothing to
  // audit as 'applied'. Caller hit this by mistake; we surface a
  // no-op 'applied' row so the trail records the trigger fire
  // without claiming work happened. Distinct from real applied
  // outcomes via fromState === toState in the audit row.
  if (fromState === toState) {
    const evidenceJson = JSON.stringify(input.evidence ?? {});
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

  // 3. Fire Eviction hook when wired. Skipped when fireHook is
  // unset (headless / tests without hook plumbing) — same pattern
  // memory_write uses for confirmMemoryWrite.
  const evidenceJson = JSON.stringify(input.evidence ?? {});
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

  // 4. Apply transition (file + index). Failures here surface as
  // io_error; the audit row is NOT written because the disk state
  // is in-flight (writing a row that says "applied" while the file
  // is in an unknown state would be worse than no row).
  let applyResult: ApplyResult;
  try {
    applyResult = applyTransition(input, currentFile, fromState, toState);
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
      ...(toState === 'evicted' ? { purgeAt: input.purgeAt ?? null } : {}),
    });
    evictionEventId = ev.id;
  } catch (err) {
    // The file/index already moved. eviction_events write failed
    // — surface but acknowledge the on-disk transition completed.
    // Treat as io_error so caller can audit the drift separately
    // (eventual reconciliation slice will replay from disk shape).
    return {
      kind: 'io_error',
      reason: `eviction_events write failed after file mutation: ${err instanceof Error ? err.message : String(err)}`,
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
