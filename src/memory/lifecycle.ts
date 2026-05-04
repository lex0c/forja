import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { FrontmatterError } from './frontmatter.ts';
import {
  IndexError,
  type ParsedIndex,
  parseIndex,
  removeIndexEntry,
  serializeIndex,
} from './index-file.ts';
import { ScopeError, indexFilePath, memoryFilePath } from './paths.ts';
import type { ScopeRoots } from './paths.ts';
import type { MemoryRegistry } from './registry.ts';
import type { MemoryScope } from './types.ts';

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

  // Verify body exists before mutating the index. Removing the
  // index entry for a never-existed memory would be a silent
  // operator-confusion — surface as `unknown`.
  let bodyExists = false;
  try {
    const stat = lstatSync(bodyPath);
    bodyExists = stat.isFile();
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'io_error', reason: msg };
    }
  }

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

// Find all expired memories in the registry and remove them. Emits
// a `memory_events` row with `action: 'expired'` per removal so
// `/memory audit` can show the GC trail. Auto-refreshes the
// registry's in-memory snapshot once at the end (single
// reload, not per-removal — saves N filesystem index re-reads in
// the common case).
//
// `auditSessionId` / `auditCwd` forward to the audit rows; the
// caller (bootstrap) is the right place to thread these from the
// active session context.
export interface GcExpiredAuditOverride {
  auditSessionId?: string;
  auditCwd?: string;
}

export const gcExpiredMemories = (
  registry: MemoryRegistry,
  roots: ScopeRoots,
  opts: GcExpiredOptions & GcExpiredAuditOverride = {},
): GcExpiredResult => {
  const expired = findExpiredMemories(registry, opts.today ?? new Date());
  const removed: ExpiredMemory[] = [];
  const failures: { memory: ExpiredMemory; reason: string }[] = [];

  for (const mem of expired) {
    const result = removeMemory({ roots, scope: mem.scope, name: mem.name });
    if (result.kind === 'removed') {
      removed.push(mem);
      registry.recordEvent({
        action: 'expired',
        scope: mem.scope,
        memoryName: mem.name,
        // Source from the frontmatter — `inferred` (likely the
        // +90d default) vs `user_explicit` (operator-set date)
        // is the most useful discriminator for /memory audit
        // pattern detection.
        source: mem.source as 'user_explicit' | 'inferred' | 'imported',
        details: {
          expires: mem.expires,
          bodyPath: result.bodyPath,
        },
        ...(opts.auditSessionId !== undefined ? { auditSessionId: opts.auditSessionId } : {}),
        ...(opts.auditCwd !== undefined ? { auditCwd: opts.auditCwd } : {}),
      });
    } else {
      const reason =
        result.kind === 'sandbox_violation'
          ? result.reason
          : result.kind === 'unknown'
            ? `body and index entry both absent at ${result.bodyPath}`
            : result.reason;
      failures.push({ memory: mem, reason });
      // Audit the failure too (spec §5.3 audit log). `refused`
      // with stage='lifecycle_gc' lets `/memory audit` show
      // "tried to expire but couldn't" alongside the successful
      // `expired` rows. Without this, a failure leaves no trace
      // — the operator only notices via the absence of an
      // `expired` row when they expected one. The stage tag
      // distinguishes from tool-layer `refused` rows which
      // carry stage='tool_gate' / 'scanner' / 'modal' / etc.
      registry.recordEvent({
        action: 'refused',
        scope: mem.scope,
        memoryName: mem.name,
        source: mem.source as 'user_explicit' | 'inferred' | 'imported',
        details: {
          stage: 'lifecycle_gc',
          kind: result.kind,
          reason,
          expires: mem.expires,
        },
        ...(opts.auditSessionId !== undefined ? { auditSessionId: opts.auditSessionId } : {}),
        ...(opts.auditCwd !== undefined ? { auditCwd: opts.auditCwd } : {}),
      });
    }
  }

  // Single snapshot reload after the batch — registry's in-memory
  // listings now match disk.
  if (removed.length > 0) registry.reload();
  return { removed, failures };
};
