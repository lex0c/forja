import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../storage/db.ts';
import { FrontmatterError, serializeMemoryFile } from './frontmatter.ts';
import {
  IndexError,
  type ParsedIndex,
  parseIndex,
  removeIndexEntry,
  serializeIndex,
  upsertIndexEntry,
} from './index-file.ts';
import { readMemoryByName } from './loader.ts';
import { ScopeError, indexFilePath, memoryFilePath } from './paths.ts';
import type { ScopeRoots } from './paths.ts';
import type { MemoryRegistry } from './registry.ts';
import { transitionMemoryState } from './transitions.ts';
import type { MemoryFile, MemoryScope } from './types.ts';
import { type WriteMemoryResult, writeMemory } from './writer.ts';

// Lifecycle primitives for the memory subsystem (spec MEMORY.md §5.5,
// §6.2). This module owns:
//
//   - `removeMemory(roots, scope, name)` — pure file+index deletion,
//     parallel to `writeMemory` in writer.ts. Atomic for the index
//     update (rewrite via temp+rename); body unlink is naturally
//     atomic on POSIX. Discriminated-result return shape, no throws
//     for caller-recoverable conditions.
//
//   - `findExpiredMemories(registry, today)` — scan the registry for
//     memories whose `expires:` frontmatter field is on or before
//     `today` (YYYY-MM-DD lex compare = chrono compare for ISO
//     dates). Body load via `peek` so the audit table doesn't grow
//     `read` rows for every session-start GC pass.
//
//   - `gcExpiredMemories(registry, today, opts)` — orchestrate
//     find+remove+audit for the SessionStart hook. Auto-removes
//     unconditionally per the call site's policy (today: bootstrap
//     auto-removes everything; spec §6.2 flags "com confirmação se
//     houver muitas" as a future modal-gated path — see Decisions
//     in BACKLOG when that lands).
//
// Removal layering rationale: writer.ts owns *creation*; this file
// owns *destruction*. They share the path-validation primitives
// (memoryFilePath / indexFilePath) but have independent atomicity
// concerns and different failure-mode shapes — colocation in writer.ts
// would mix the contracts. Cross-call sharing of helpers (atomicWrite,
// loadOrEmptyIndex) is small enough that duplication beats coupling.

export type RemoveMemoryResult =
  | { kind: 'removed'; bodyPath: string; indexEntryRemoved: boolean }
  | { kind: 'sandbox_violation'; reason: string }
  | { kind: 'unknown'; bodyPath: string }
  | { kind: 'io_error'; reason: string };

export interface RemoveMemoryInput {
  roots: ScopeRoots;
  scope: MemoryScope;
  name: string;
}

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

const INDEX_HEADER = '# Memory index';

const tempPathFor = (finalPath: string): string => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${finalPath}.tmp-${process.pid}-${rand}`;
};

const atomicWrite = (path: string, content: string): void => {
  const tmp = tempPathFor(path);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
};

// Read MEMORY.md, returning empty when absent. Same forgiveness as
// the writer's loader: malformed lines are dropped on re-serialize
// (data-loss tradeoff documented in writer.ts header).
const loadOrEmptyIndex = (path: string): ParsedIndex => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return { entries: [], malformedLines: [] };
    throw err;
  }
  return parseIndex(raw);
};

// Remove a memory file + its MEMORY.md entry. Both operations are
// idempotent: a missing body or absent index entry is fine, the
// caller's audit row reflects what actually changed.
//
// Order: index FIRST, then body. Reverse order would leave a
// dangling body referenced by an entry pointing nowhere — the
// loader's `kind: 'missing'` path handles that, but it's an
// additional state to reconcile. Index-first means a crash between
// writes leaves an orphan body (reachable via `listOrphanFiles`)
// which mirrors the writer's failure shape.
//
// Concurrency: two sessions running GC against the same scope at
// the same time can race index updates. POSIX rename is atomic per-
// filesystem, so the index file never lands half-written, but the
// loser of the race may overwrite the winner's edit with stale
// content. Mitigation: bootstrap GC runs once per session at boot,
// and operators rarely run two sessions racing on the same scope.
// flock-based serialization is the right answer when /memory audit
// or admin tooling makes concurrent GC plausible.
export const removeMemory = (input: RemoveMemoryInput): RemoveMemoryResult => {
  const { roots, scope, name } = input;

  let bodyPath: string;
  try {
    bodyPath = memoryFilePath(roots, scope, name);
  } catch (err) {
    // Promote ScopeError / FrontmatterError into discriminated
    // result. The two reach this catch via memoryFilePath:
    //   - FrontmatterError: name shape rejected by `validateName`
    //     (path traversal in name, leading dot, non-kebab). Maps
    //     to `io_error` — caller-shape failure, not path-shape.
    //   - ScopeError: candidate path resolved outside the scope
    //     root (operator-supplied roots config, or hypothetical
    //     future bypass of validateName). Maps to
    //     `sandbox_violation` so audit can mark it as a security
    //     event rather than a generic input error.
    // Mirrors the writer's discrimination (writer.ts:188); duck-
    // typed checks would conflate the two.
    if (err instanceof ScopeError) {
      return { kind: 'sandbox_violation', reason: err.message };
    }
    if (err instanceof FrontmatterError) {
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  // Classify the inode at the body path. Three outcomes the
  // caller cares about:
  //   - 'absent'   → no inode (ENOENT). Index-only cleanup path.
  //   - 'file'     → regular memory file written by writeMemory.
  //                  unlinkSync removes it.
  //   - 'symlink'  → operator (or an attacker, spec §7.2.6) dropped
  //                  a symlink at the path. Earlier cut treated this
  //                  as 'absent' because `stat.isFile()` returns
  //                  false on symlinks (lstatSync doesn't follow);
  //                  the unlink was skipped, leaving the symlink on
  //                  disk while the index entry was rewritten away.
  //                  Re-creating the same name would then trip the
  //                  writer's `symlink_refused` gate, making the
  //                  name permanently unwritable until manual
  //                  cleanup. Fix: include symlinks in the
  //                  removable set — `unlinkSync` operates on the
  //                  link itself, not the target, so removing it
  //                  is the right cleanup regardless of where the
  //                  link pointed.
  //   - 'other'    → directory, socket, fifo, etc. Refuse up front
  //                  BEFORE mutating the index so we don't leave
  //                  the index half-cleaned with a weird inode
  //                  still occupying the path. lstatSync returning
  //                  these kinds at a memory path means external
  //                  filesystem state has gone weird; surface as
  //                  io_error so the operator investigates.
  let bodyState: 'absent' | 'file' | 'symlink' | 'other' = 'absent';
  try {
    const stat = lstatSync(bodyPath);
    if (stat.isFile()) bodyState = 'file';
    else if (stat.isSymbolicLink()) bodyState = 'symlink';
    else bodyState = 'other';
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'io_error', reason: msg };
    }
  }
  if (bodyState === 'other') {
    return {
      kind: 'io_error',
      reason: `non-file/non-symlink at memory path: ${bodyPath}`,
    };
  }
  const bodyExists = bodyState === 'file' || bodyState === 'symlink';

  // Update the index: remove the entry whose href matches `<name>.md`.
  // Spec §3.2 SECURITY CONTRACT mandates href is a UI hint, not
  // path-bearing — so we match by canonical filename, not by
  // operator-edited href text.
  const indexPath = indexFilePath(roots, scope);
  let parsed: ParsedIndex;
  try {
    parsed = loadOrEmptyIndex(indexPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `read index: ${msg}` };
  }

  const targetHref = `${name}.md`;
  const indexEntryRemoved = parsed.entries.some((e) => e.href === targetHref);
  const nextEntries = removeIndexEntry(parsed.entries, targetHref);

  // Skip the index rewrite if there was nothing to remove AND no
  // body to delete — full no-op.
  if (!indexEntryRemoved && !bodyExists) {
    return { kind: 'unknown', bodyPath };
  }

  // Rewrite the index when something changed, else leave it
  // untouched (avoids a redundant disk write on an already-clean
  // index). Cap check still fires; an existing index that already
  // exceeds the cap won't get worse on removal — but
  // `serializeIndex` enforces it on every write, and a stale index
  // over-cap will surface here. Map IndexError → io_error so the
  // caller doesn't crash on this rare drift.
  if (indexEntryRemoved) {
    let serialized: ReturnType<typeof serializeIndex>;
    try {
      serialized = serializeIndex(nextEntries, { header: INDEX_HEADER });
    } catch (err) {
      if (err instanceof IndexError) {
        return { kind: 'io_error', reason: err.message };
      }
      throw err;
    }
    try {
      atomicWrite(indexPath, serialized.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'io_error', reason: `write index: ${msg}` };
    }
  }

  // Body unlink. ENOENT is fine — index pointed at a missing body,
  // we already wrote the index without the entry.
  if (bodyExists) {
    try {
      unlinkSync(bodyPath);
    } catch (err) {
      if (!isEnoent(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'io_error', reason: `unlink body: ${msg}` };
      }
    }
  }

  return { kind: 'removed', bodyPath, indexEntryRemoved };
};

// One memory whose `expires:` puts it in the past relative to the
// reference date. The caller (gc) consumes these and calls remove
// + audit.
export interface ExpiredMemory {
  scope: MemoryScope;
  name: string;
  expires: string;
  // Frontmatter source is forwarded to the audit row so an
  // operator inspecting `/memory audit` can see whether the
  // expired entry was inferred (likely the +90d default) or
  // user_explicit (operator set the date themselves).
  source: string;
}

// Compare ISO date strings lex-wise. YYYY-MM-DD format makes
// chronological order = lexicographical order, no Date object
// needed.
//
// UTC trade-off — the spec's `expires: YYYY-MM-DD` carries no
// timezone, so there's no canonical answer for "what does
// 2026-05-04 mean across timezones?". Two viable choices:
//
//   A. Operator-local-TZ today: matches the operator's mental
//      model when they typed the date. Drawback — a memory
//      written by operator A in UTC-4 then booted by B in UTC+9
//      sees different "today" values; the same memory expires on
//      different boots depending on whose machine you're on.
//   B. UTC today (chosen): stable across machines and timezones.
//      Drawback — operator in UTC-4 setting `expires: 2026-05-04`
//      based on local calendar may see the memory removed at
//      ~20:00 local on 2026-05-03 (which is 00:00 UTC 2026-05-04).
//      Up to 24h "early" relative to local-calendar expectation.
//
// We pick UTC because cross-machine determinism matters more than
// last-day-of-life precision — operators who care about exact
// timing can subtract a day when setting `expires:` (or wait for
// `/memory expire` slash command to land with explicit TZ
// handling). Audit row carries the literal `expires` string so
// "why did this disappear?" forensic queries get the operator's
// original input, not the comparison date.
const todayIso = (now: Date = new Date()): string => {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

export const findExpiredMemories = (
  registry: MemoryRegistry,
  today: Date = new Date(),
): ExpiredMemory[] => {
  const todayStr = todayIso(today);
  const expired: ExpiredMemory[] = [];
  // Scan ALL listings (no dedupe) — each scope's expiry is
  // independent; an expired user-scope shadow should be removed
  // even if the project_local scope of the same name is fresh.
  for (const listing of registry.list()) {
    // peek (no audit) to get frontmatter. Memory_events shouldn't
    // grow `read` rows for system-internal GC scans.
    const peek = registry.peek(listing.name, { scope: listing.scope });
    if (peek.kind !== 'present') continue;
    const expires = peek.file.frontmatter.expires;
    if (expires === undefined) continue;
    // Lex compare on YYYY-MM-DD: equal-or-past today = expired.
    // Spec doesn't define equality semantics; we expire on the
    // boundary day so an operator's `expires: 2026-05-04` with
    // boot on 2026-05-04 removes the memory the same day they
    // expected it gone.
    if (expires <= todayStr) {
      expired.push({
        scope: listing.scope,
        name: listing.name,
        expires,
        source: peek.file.frontmatter.source,
      });
    }
  }
  return expired;
};

export interface GcExpiredOptions {
  // Reference date for the expiry comparison. Defaults to now.
  // Tests set this to a fixed date for determinism.
  today?: Date;
}

export interface GcExpiredResult {
  // Memories whose remove() succeeded.
  removed: ExpiredMemory[];
  // Expired-but-failed-to-remove (unlink errors, sandbox
  // violations, etc.). Caller decides whether to surface as a
  // hard error or a stderr warning. Empty in the happy path.
  failures: { memory: ExpiredMemory; reason: string }[];
}

// Find all expired memories in the registry and route each through
// the canonical state machine (EVICTION §4.1). Per spec §0.9 — no
// silent GC: every transition lands an `eviction_events` row pair
// (active→quarantined, quarantined→evicted) plus the matching
// `memory_events` audit. The legacy `removeMemory`-shaped path
// (single `expired` row + unlink) was the pre-1.3 surface; it
// shipped before the state machine existed, leaked through the
// audit trail, and produced no `eviction_events` rows so the
// downstream queries (`getLastEvictionForObject`, GC sweep,
// trigger-thrashing detector) couldn't see expirations.
//
// State-machine attribution:
//   - motivo:  'low_roi'    (state machine doesn't admit 'expired'
//                            on active→...→evicted; same trade-off
//                            /memory delete made for user_purge.
//                            Trigger field carries the real
//                            semantics; spec PR to admit 'expired'
//                            on these transitions is declared as
//                            follow-up.)
//   - trigger: 'expired_at' (canonical §5.1 trigger)
//   - actor:   'startup_probe' (bootstrap-time GC)
//   - purgeAt: now + 30d (memory retention per §7.1; 2.3 will
//                         materialize the evicted→purged sweep)
//   - evidence: { expires } — operator-set date preserved for
//                             forensic queries
//
// Async because transitionMemoryState is async (hook fire is
// async, even though bootstrap doesn't pass a dispatcher today).
// The caller (`bootstrap`) is already async, so threading awaits
// is free.
//
// `auditSessionId` / `auditCwd` forward to the audit rows; the
// caller (bootstrap) is the right place to thread these from the
// active session context.
export interface GcExpiredAuditOverride {
  auditSessionId?: string;
  auditCwd?: string;
}

// Memory tombstone retention per EVICTION §7.1. Same constant the
// /memory delete slash uses; duplicated locally to keep this
// module free of slash-layer dependencies. 30d in ms.
const MEMORY_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const gcExpiredMemories = async (
  db: DB,
  registry: MemoryRegistry,
  roots: ScopeRoots,
  opts: GcExpiredOptions & GcExpiredAuditOverride = {},
): Promise<GcExpiredResult> => {
  const today = opts.today ?? new Date();
  const expired = findExpiredMemories(registry, today);
  const removed: ExpiredMemory[] = [];
  const failures: { memory: ExpiredMemory; reason: string }[] = [];

  // Wall-clock anchor for the eviction_events recorded_at field.
  // Using `today.getTime()` keeps tests deterministic (they
  // already pass a fixed `opts.today`); production with no
  // override falls back to `new Date().getTime()`.
  const nowMs = today.getTime();
  const baseTransitionInput = {
    db,
    registry,
    roots,
    motivo: 'low_roi' as const,
    trigger: 'expired_at',
    actor: 'startup_probe' as const,
    ...(opts.auditSessionId !== undefined ? { sessionId: opts.auditSessionId } : {}),
    ...(opts.auditCwd !== undefined ? { cwd: opts.auditCwd } : {}),
  };

  for (const mem of expired) {
    const evidence = { expires: mem.expires };
    // Per-memory now counter so two back-to-back expirations get
    // monotonically distinct recorded_at + tombstone ts values.
    // Without this, all expired rows in one boot would collide
    // on Date.now()-ms granularity in fast loops.
    let perMemNow = nowMs;
    const tickNow = () => ++perMemNow;

    // 1) active → quarantined
    const r1 = await transitionMemoryState({
      ...baseTransitionInput,
      scope: mem.scope,
      name: mem.name,
      toState: 'quarantined',
      evidence,
      now: tickNow,
    });
    if (r1.kind !== 'applied') {
      failures.push({ memory: mem, reason: gcFailureReason(r1, 'active→quarantined') });
      continue;
    }

    // 2) quarantined → evicted (with purgeAt for the retention window)
    const r2 = await transitionMemoryState({
      ...baseTransitionInput,
      scope: mem.scope,
      name: mem.name,
      toState: 'evicted',
      evidence,
      purgeAt: perMemNow + MEMORY_TOMBSTONE_RETENTION_MS,
      now: tickNow,
    });
    if (r2.kind !== 'applied') {
      failures.push({ memory: mem, reason: gcFailureReason(r2, 'quarantined→evicted') });
      // Audit-only attribution: at this point the memory IS in
      // quarantined state (step 1 applied) but the eviction trail
      // is half-baked. transitionMemoryState already lands a
      // refused/audit_drift/io_error row for r2; we surface the
      // failure to the caller (stderr) so the operator knows.
      continue;
    }

    removed.push(mem);
  }

  // Single snapshot reload after the batch — registry's in-memory
  // listings now match disk.
  if (removed.length > 0) registry.reload();
  return { removed, failures };
};

// Translate a non-applied TransitionMemoryStateResult into an
// operator-facing reason string. Mirrors mapTransitionFailure in
// the slash layer but lives here as a private helper because the
// audit chain at this layer is failure-soft (no slash result).
const gcFailureReason = (
  result: Awaited<ReturnType<typeof transitionMemoryState>>,
  step: string,
): string => {
  switch (result.kind) {
    case 'unknown':
      return `${step}: memory not found at transition time`;
    case 'illegal_transition':
      return `${step}: ${result.reason}`;
    case 'blocked_by_hook':
      return `${step}: blocked by Eviction hook (${result.blockedBy})`;
    case 'audit_drift':
      return `${step}: audit drift — disk transition completed but audit row failed: ${result.reason}`;
    case 'io_error':
      return `${step}: ${result.reason}`;
    default:
      return `${step}: unexpected outcome '${(result as { kind: string }).kind}'`;
  }
};

// ─── purge sweep (evicted → purged) ──────────────────────────────────
//
// The consumer side of the retention window EVICTION §7.1 declares.
// `gcExpiredMemories` (boot-time, this module) and `/memory delete`
// (slash) both PRODUCE evicted rows with `purge_at = now + 30d`.
// Without a sweep that materializes `evicted → purged` when the
// window expires, those tombstones accumulate without bound — every
// memory ever evicted lives on disk forever.
//
// Sweep contract:
//   1. Read `listEvictedDueForPurge(db, now)` — rows with
//      `to_state='evicted' AND purge_at <= now`.
//   2. For each row of substrate='memory': verify via
//      getLastEvictionForObject that this is STILL the latest event
//      for the object. If a later row exists (the memory was
//      restored, then maybe re-evicted), skip — the older row's
//      purge_at is no longer load-bearing because the disk state
//      has moved on.
//   3. Resolve scope from objectScope (validated against the
//      MemoryScope enum); call transitionMemoryState with
//      toState='purged', motivo='expired', trigger='expired_at',
//      actor='startup_probe'.
//   4. Transition removes the tombstone file (transitions.ts) +
//      lands the eviction_events purged row + memory_events
//      action='purged' row.
//
// N+1 lookup (getLastEvictionForObject per candidate) is acceptable
// because boot-time sweeps process at most dozens of tombstones —
// the additional cost is dwarfed by the eviction_events INSERT itself.

const MEMORY_SCOPES = new Set<MemoryScope>(['user', 'project_shared', 'project_local']);

const isMemoryScope = (value: string): value is MemoryScope =>
  MEMORY_SCOPES.has(value as MemoryScope);

export interface GcPurgeOptions {
  // Probe time for the retention check. Defaults to Date.now(). Tests
  // pass fixed values for determinism.
  now?: () => number;
  // Audit attribution forwarded to the eviction_events +
  // memory_events rows.
  auditSessionId?: string;
  auditCwd?: string;
}

export interface PurgedTombstone {
  scope: MemoryScope;
  name: string;
  // The eviction_events row id that drove the purge — useful for
  // forensic audit ("which retention window expired?").
  evictionEventId: string;
}

export interface GcPurgeResult {
  purged: PurgedTombstone[];
  failures: { evictionEventId: string; reason: string }[];
  // Candidate rows that were skipped because a newer eviction
  // event exists for the same object (memory was restored after
  // the original eviction). Tracked separately from failures so
  // the boot caller can stay silent on skip (expected control
  // flow) but stderr-log failures.
  skipped: { evictionEventId: string; reason: string }[];
}

export const gcPurgeExpiredTombstones = async (
  db: DB,
  registry: MemoryRegistry,
  roots: ScopeRoots,
  opts: GcPurgeOptions = {},
): Promise<GcPurgeResult> => {
  // Lazy imports to avoid circular dependency with the storage
  // layer (lifecycle.ts is loaded by writer.ts which is loaded by
  // the storage layer's repos for some test fixtures).
  const { getLastEvictionForObject, listEvictedDueForPurge } = await import(
    '../storage/repos/eviction-events.ts'
  );
  const nowMs = opts.now?.() ?? Date.now();
  const candidates = listEvictedDueForPurge(db, nowMs);
  const purged: PurgedTombstone[] = [];
  const failures: { evictionEventId: string; reason: string }[] = [];
  const skipped: { evictionEventId: string; reason: string }[] = [];

  for (const row of candidates) {
    // Filter to memory substrate — other substrates (policy,
    // candidate, slot_item) will run their own sweeps when they
    // ship. The query returns all evicted rows; per-substrate
    // owner decides what to do with them.
    if (row.substrate !== 'memory') continue;

    // Verify recency: a subsequent restore-then-re-evict cycle
    // would have produced a newer eviction event. The OLDER row's
    // purge_at is no longer load-bearing — the disk state moved
    // on. Skip silently.
    const latest = getLastEvictionForObject(db, row.substrate, row.objectId);
    if (latest === null || latest.id !== row.id) {
      skipped.push({
        evictionEventId: row.id,
        reason: 'newer eviction event exists for object (restored or re-evicted since)',
      });
      continue;
    }

    if (!isMemoryScope(row.objectScope)) {
      failures.push({
        evictionEventId: row.id,
        reason: `invalid memory scope '${row.objectScope}' on eviction_events row`,
      });
      continue;
    }
    const scope = row.objectScope;

    const result = await transitionMemoryState({
      db,
      registry,
      roots,
      scope,
      name: row.objectId,
      toState: 'purged',
      motivo: 'expired',
      trigger: 'expired_at',
      actor: 'startup_probe',
      evidence: {
        purged_after_retention_window: true,
        original_eviction_id: row.id,
        original_purge_at: row.purgeAt,
      },
      ...(opts.auditSessionId !== undefined ? { sessionId: opts.auditSessionId } : {}),
      ...(opts.auditCwd !== undefined ? { cwd: opts.auditCwd } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });

    if (result.kind === 'applied') {
      purged.push({ scope, name: row.objectId, evictionEventId: row.id });
    } else {
      failures.push({
        evictionEventId: row.id,
        reason: gcFailureReason(result, 'evicted→purged'),
      });
    }
  }

  // Snapshot reload — purged memories aren't indexed (already
  // cleared on eviction) but a future caller might rely on
  // registry-side state matching disk.
  if (purged.length > 0) registry.reload();
  return { purged, failures, skipped };
};

// ─── moveMemory (promote / demote primitive) ─────────────────────────
//
// Spec MEMORY.md §5.4 (promote local → shared) and §5.5 (demote
// shared → local) both reduce to "atomically relocate a memory
// from one scope to another". This primitive is direction-agnostic
// — promote/demote are thin wrappers over it that pin from/to and
// add direction-specific scanner gates.
//
// Concurrency / atomicity:
//   1. Read source body (`readMemoryByName`). Failures here mean
//      the operator's input is wrong — surface as `unknown` /
//      `malformed`.
//   2. Write target via `writeMemory`. Reuses the writer's
//      sandbox + symlink + index-cap defenses. If the target
//      already exists at the destination scope, writer returns
//      `exists` and we abort BEFORE touching the source — no
//      duplicate, no half-state.
//   3. Remove source via `removeMemory`. Crash between step 2
//      and step 3 leaves a copy at both scopes; the loader's
//      "all listings" output surfaces that, and a re-run of
//      promote/demote is a no-op on the duplicate (writer's
//      `exists` rejects step 2 the second time). Operator can
//      reconcile via `removeMemory`.
//
// Discriminated outcomes mirror writer.ts conventions: `moved`
// on success (with both paths so the caller can audit which
// files were touched), and the failure variants reachable from
// the underlying writer / remover. `source_unknown` is distinct
// from `source_malformed` so the audit row carries actionable
// detail without rerunning a probe.

export interface MoveMemoryInput {
  roots: ScopeRoots;
  fromScope: MemoryScope;
  toScope: MemoryScope;
  name: string;
}

export type MoveMemoryResult =
  | {
      kind: 'moved';
      fromPath: string;
      toPath: string;
      // Frontmatter `source` field, forwarded to the audit row
      // by the caller — the move primitive itself doesn't audit
      // (the slash command does, with promoted/demoted action).
      source: string;
    }
  | { kind: 'source_unknown' }
  | { kind: 'source_malformed'; reason: string }
  | { kind: 'target_exists'; path: string }
  | { kind: 'sandbox_violation'; reason: string }
  | { kind: 'io_error'; reason: string };

export const moveMemory = (input: MoveMemoryInput): MoveMemoryResult => {
  const { roots, fromScope, toScope, name } = input;

  // Step 1: read source body.
  let sourceFile: MemoryFile;
  try {
    const result = readMemoryByName(roots, fromScope, name);
    if (result.kind === 'missing') return { kind: 'source_unknown' };
    if (result.kind === 'malformed') {
      return { kind: 'source_malformed', reason: result.error };
    }
    sourceFile = result.file;
  } catch (err) {
    if (err instanceof ScopeError) {
      return { kind: 'sandbox_violation', reason: err.message };
    }
    if (err instanceof FrontmatterError) {
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  // Step 2: write target. Writer enforces project_shared rejection
  // for direct writes — but `moveMemory` is a privileged caller
  // that legitimately targets shared scope, so we use the writer
  // directly. To bypass the writer's `shared_forbidden` gate when
  // toScope='project_shared', the caller (slash command) must
  // verify the move is intentional (modal confirm + scanner pass).
  // Today the writer hard-rejects shared writes; we work around by
  // using the index-update + body-write path through `writeMemory`
  // for non-shared moves and a direct path for shared.
  //
  // Pragmatic alternative shipped here: writer accepts shared via
  // an opt-in. We don't have that yet, so we structure the move so
  // the writer's reject is treated as a special case the move
  // primitive translates into a direct write. To minimize code
  // duplication, the move primitive bypasses writer.ts when
  // toScope=project_shared — using the same atomic-rename + index
  // upsert pattern in this file.
  if (toScope === 'project_shared') {
    return moveToShared(input, sourceFile);
  }

  // Resolve `fromPath` BEFORE the destructive write so a hypothetical
  // `FrontmatterError` from `validateName` (defense-in-depth — slash
  // command already validated) doesn't leave the target written
  // with no return path tracked. ScopeError / FrontmatterError both
  // map to the discriminated result here; the actual write
  // proceeds only after path resolution succeeds.
  let fromPath: string;
  try {
    fromPath = memoryFilePath(roots, fromScope, name);
  } catch (err) {
    if (err instanceof ScopeError) {
      return { kind: 'sandbox_violation', reason: err.message };
    }
    if (err instanceof FrontmatterError) {
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  const writeResult = writeMemory({
    roots,
    scope: toScope,
    frontmatter: sourceFile.frontmatter,
    body: sourceFile.body,
  });
  if (writeResult.kind !== 'created') {
    return mapWriteFailure(writeResult);
  }

  // Step 3: remove source.
  const removeResult = removeMemory({ roots, scope: fromScope, name });
  if (removeResult.kind === 'sandbox_violation') {
    return { kind: 'sandbox_violation', reason: removeResult.reason };
  }
  if (removeResult.kind === 'io_error') {
    // Body was written to target but source removal failed.
    // Caller will see two copies until they reconcile manually.
    // Surface the io_error so the audit row carries the disk
    // failure detail.
    return {
      kind: 'io_error',
      reason: `target wrote OK, source remove failed: ${removeResult.reason}`,
    };
  }

  return {
    kind: 'moved',
    fromPath,
    toPath: writeResult.path,
    source: sourceFile.frontmatter.source,
  };
};

// Direct shared-scope write path. Mirrors `writeMemory` but
// targets `project_shared` (which writer.ts rejects up front per
// spec §5.1.3). Used only by `moveMemory` when promoting; never
// reachable from the tool surface because tool->writer goes
// through writer.ts and gets the reject. Operator-facing scanner
// gates are the slash command's responsibility (spec §5.4
// "scanner adicional"); this helper just persists.
const moveToShared = (input: MoveMemoryInput, sourceFile: MemoryFile): MoveMemoryResult => {
  const { roots, fromScope, name } = input;
  // We can't call writeMemory(toScope=project_shared) — it rejects.
  // Inline the atomic write + index upsert pattern matching
  // writer.ts. Future refactor: writer.ts accepts an
  // `allowShared: true` flag from privileged callers. Until then
  // this duplication is contained.
  let bodyPath: string;
  try {
    bodyPath = memoryFilePath(roots, 'project_shared', name);
  } catch (err) {
    if (err instanceof ScopeError) {
      return { kind: 'sandbox_violation', reason: err.message };
    }
    if (err instanceof FrontmatterError) {
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  // Symlink + existence checks mirror writer.ts.
  try {
    const stat = lstatSync(bodyPath);
    if (stat.isSymbolicLink()) {
      return { kind: 'sandbox_violation', reason: `target path is a symlink: ${bodyPath}` };
    }
    if (stat.isFile()) return { kind: 'target_exists', path: bodyPath };
    return { kind: 'io_error', reason: `non-file at memory path: ${bodyPath}` };
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'io_error', reason: msg };
    }
  }

  try {
    mkdirSync(dirname(bodyPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `mkdir failed: ${msg}` };
  }

  // Index update. Same pattern as writer.ts buildIndexEntry.
  const indexPath = indexFilePath(roots, 'project_shared');
  let parsed: ParsedIndex;
  try {
    parsed = loadOrEmptyIndex(indexPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `read index: ${msg}` };
  }
  const newEntry = {
    title: sourceFile.frontmatter.name,
    href: `${name}.md`,
    hook: sourceFile.frontmatter.description,
  };
  const nextEntries = upsertIndexEntry(parsed.entries, newEntry);

  let serialized: ReturnType<typeof serializeIndex>;
  try {
    serialized = serializeIndex(nextEntries, { header: '# Memory index' });
  } catch (err) {
    if (err instanceof IndexError) {
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  // Resolve fromPath BEFORE the destructive write — same rationale
  // as the non-shared path above (defense-in-depth against
  // hypothetical FrontmatterError leaving target written with no
  // return path tracked).
  let fromPath: string;
  try {
    fromPath = memoryFilePath(roots, fromScope, name);
  } catch (err) {
    if (err instanceof ScopeError) {
      return { kind: 'sandbox_violation', reason: err.message };
    }
    if (err instanceof FrontmatterError) {
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  // Body serialization.
  let bodyText: string;
  try {
    bodyText = serializeMemoryFile(sourceFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `serialize body: ${msg}` };
  }

  try {
    atomicWrite(bodyPath, bodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `write body: ${msg}` };
  }
  try {
    atomicWrite(indexPath, serialized.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `write index: ${msg}` };
  }

  // Remove source.
  const removeResult = removeMemory({ roots, scope: fromScope, name });
  if (removeResult.kind === 'io_error') {
    return {
      kind: 'io_error',
      reason: `target wrote OK, source remove failed: ${removeResult.reason}`,
    };
  }
  if (removeResult.kind === 'sandbox_violation') {
    return { kind: 'sandbox_violation', reason: removeResult.reason };
  }

  return {
    kind: 'moved',
    fromPath,
    toPath: bodyPath,
    source: sourceFile.frontmatter.source,
  };
};

const mapWriteFailure = (result: WriteMemoryResult): MoveMemoryResult => {
  switch (result.kind) {
    case 'created':
      // Caller already handled this branch — defensive default.
      return { kind: 'io_error', reason: 'unreachable: created passed to mapWriteFailure' };
    case 'exists':
      return { kind: 'target_exists', path: result.path };
    case 'shared_forbidden':
      // moveMemory routes shared targets to moveToShared before
      // calling writeMemory, so this is unreachable in production.
      return {
        kind: 'io_error',
        reason: 'unreachable: shared_forbidden in non-shared move path',
      };
    case 'sandbox_violation':
      return { kind: 'sandbox_violation', reason: result.reason };
    case 'symlink_refused':
      return { kind: 'sandbox_violation', reason: `target path is a symlink: ${result.path}` };
    case 'index_full':
      return {
        kind: 'io_error',
        reason: `MEMORY.md hard cap reached at target (${result.current}/${result.cap})`,
      };
    case 'io_error':
      return { kind: 'io_error', reason: result.reason };
  }
};
