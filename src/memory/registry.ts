import type { DB } from '../storage/db.ts';
import { type MemoryEventAction, createMemoryEvent } from '../storage/repos/memory-events.ts';
import {
  type MemoryFileResult,
  type ScopeIndexResult,
  loadScopeIndex,
  memoryNameFromPath,
  readMemoryByName,
} from './loader.ts';
import type { ScopeRoots } from './paths.ts';
import type {
  IndexEntry,
  MemoryFile,
  MemoryFrontmatter,
  MemoryScope,
  MemorySource,
} from './types.ts';
import { type WriteMemoryResult, writeMemory } from './writer.ts';

// In-process snapshot of resolved memories across the three scopes.
//
// Spec §4.1 mandates "index eager, content lazy" — we read all three
// MEMORY.md files at construction time (cheap; ~150 lines each at
// most) and keep them in memory. Bodies are loaded on demand via
// `read(name)` and NOT cached: the body cache would have to be
// invalidated on every operator hand-edit, and memories are short
// enough that the disk re-read per call is irrelevant.
//
// Scope precedence (spec §2.4): project_local > project_shared > user.
// `lookup(name)` without an explicit scope returns the most-specific
// scope that has the name. With an explicit scope, the lookup is
// strict — no fallback. Same for `read`.
//
// Audit: `read(name)` writes a `read` event to memory_events when
// the body load succeeds, IF the registry was constructed with a DB
// handle. Tools and CLI surfaces always pass one; tests can
// construct a registry without one to exercise pure functional
// behavior.

export interface MemoryListing {
  scope: MemoryScope;
  name: string;
  // Index entry as parsed. The lookup may use this to display title
  // and hook without loading the body. `entry.href` is NOT trusted
  // for path resolution — see SECURITY CONTRACT in `index-file.ts`.
  entry: IndexEntry;
}

export interface MemoryRegistry {
  // Scope roots the registry was constructed with. Exposed so
  // privileged callers (lifecycle primitives via slash commands)
  // can call `removeMemory` / `moveMemory` against the SAME roots
  // the registry's snapshot was built from. Re-deriving via
  // `resolveScopeRoots(resolveRepoRoot(cwd))` would diverge in
  // tests that use non-canonical fixture paths AND in any future
  // entrypoint that constructs a registry with custom roots
  // (e.g., admin tooling pointing at a backup). Read-only — the
  // registry doesn't mutate roots after construction.
  readonly roots: ScopeRoots;

  // All entries from all three scopes, in precedence order
  // (local first, then shared, then user). When the same `name`
  // exists in multiple scopes, ALL appearances are returned;
  // `list({ deduplicateByName: true })` returns only the most-
  // specific scope per name.
  list(opts?: ListOptions): MemoryListing[];

  // Find the most-specific scope that has `name`, or null. Pass
  // `scope` to limit the search to one scope (no fallback).
  lookup(name: string, opts?: ScopeOption): MemoryListing | null;

  // Lazy-load the body. Emits a `read` event when persistence is
  // configured and the load succeeds. Returns:
  //   - { kind: 'present', scope, file }    — body loaded
  //   - { kind: 'missing' }                  — index entry exists but
  //                                            the file is gone
  //   - { kind: 'malformed', error }         — file exists but failed
  //                                            to parse
  //   - { kind: 'unknown' }                  — no entry in any scope
  //                                            (or the requested scope)
  // `opts.auditSessionId` and `opts.auditCwd` override the
  // constructor-captured values for THIS call's audit row;
  // tools pass these from ToolContext so top-level runs (where
  // bootstrap built the registry before the session existed) get
  // accurate session attribution.
  read(name: string, opts?: ReadOptions): RegistryReadResult;

  // Substring search. Case-insensitive. Matches against name,
  // description, and (when the body is already loaded OR opts.deep
  // is true) the body. By default body matching is shallow — we
  // don't read every memory from disk for one search call. The
  // 5.6 audit surface may pass `deep: true` for forensic queries.
  search(query: string, opts?: SearchOptions): MemorySearchHit[];

  // Reload the indexes from disk. Tests use this; production
  // callers may also use it after a known external mutation
  // (e.g. operator just ran `/memory promote shared` in another
  // session and wants the current session's view to refresh).
  reload(): void;

  // Sync count of registered entries. O(1) over the cached
  // snapshot — does NOT walk disk. Two consumers today:
  //   1. Boot banner env summary: shows `memory: N` so operators
  //      know how many memories the session loaded (D68
  //      follow-up).
  //   2. Footer tray segment: live "memory N" token in the right
  //      column for at-a-glance presence.
  // Both are pre-trust-filter / pre-trigger-filter counts — i.e.
  // the raw set of entries the registry knows about, NOT the
  // post-filter count that ends up in the eager prompt section.
  // The eager-loaded count is `assembleMemorySection.entryCount`
  // and is plumbed separately when callers need that flavor.
  // Pass `deduplicateByName: true` to collapse same-name shadows
  // across scopes — matches the "active memories" semantic the
  // operator sees in the eager section.
  count(opts?: { deduplicateByName?: boolean }): number;

  // Load a body WITHOUT emitting a `read` audit row. Used by
  // session-internal callers (today: `assembleMemorySection` in
  // memory-prompt.ts, which checks `trust: untrusted` to filter
  // eager-load — spec MEMORY.md §7.2.2). Auditing every system-
  // internal load would flood `memory_events` with rows the
  // operator didn't trigger, defeating the audit table's purpose
  // (signal the operator's interactions). Returns the same
  // discriminated shape as `read()`.
  peek(name: string, opts?: ScopeOption): RegistryReadResult;

  // Persist a new memory after the producer (tool layer) has
  // already gated injection scanning + headless rejection +
  // operator confirmation. Calls `writeMemory` (sandbox-checked,
  // atomic body+index write) and emits `memory_events` with
  // action=`created` on success or `refused` on any non-success
  // outcome (with the kind + reason in `details`). Auto-reloads
  // the in-memory snapshot on success so subsequent `list` /
  // `lookup` / `read` calls see the new entry without an explicit
  // `reload()`.
  //
  // Per-call audit overrides forward `sessionId` / `cwd` like the
  // read path; the tool layer always passes them from ToolContext.
  write(input: WriteOptions): RegistryWriteResult;

  // Emit a `memory_events` row WITHOUT touching disk. Used by the
  // tool layer for events that happen alongside (or instead of) a
  // write: the `proposed` row when the modal opens, the `refused`
  // row when the operator rejects via modal answer, and the
  // `refused` row when the injection scanner / headless gate
  // blocks the write before it reaches `write()`. Best-effort —
  // silently no-ops when the registry was constructed without a
  // db handle.
  recordEvent(input: RegistryEventInput): void;
}

export interface ListOptions {
  scope?: MemoryScope;
  deduplicateByName?: boolean;
}

export interface ScopeOption {
  scope?: MemoryScope;
}

// Audit attribution overrides. When these are set on a per-call
// option object, they win over the registry's constructor-
// captured `sessionId` / `cwd`. Top-level CLI runs must use this
// path because bootstrap creates the registry BEFORE the harness
// creates the session — at construction time the session id
// doesn't exist yet, so the closure-captured value is undefined
// and every `read` row would land with session_id NULL,
// breaking listMemoryEventsBySession queries. The harness threads
// the active session id through ToolContext; the memory_*
// tools forward it on every call.
export interface AuditOverride {
  auditSessionId?: string;
  auditCwd?: string;
}

export interface ReadOptions extends ScopeOption, AuditOverride {}

export interface SearchOptions extends AuditOverride {
  scope?: MemoryScope;
  deep?: boolean;
  limit?: number;
}

// Inputs to `MemoryRegistry.write()`. The registry layer is
// agnostic about whether the proposal came from a tool call,
// `/memory save`, or a future import flow — its only job is to
// dispatch to `writeMemory` and emit the audit row. The tool
// layer (and slash command, when it lands) is responsible for
// any pre-write gating: injection scanner, headless rejection,
// trust-untrusted-cwd guard, modal confirmation. Reaching this
// method without those gates is a programmer bug, not a
// runtime condition the registry can recover from.
export interface WriteOptions extends AuditOverride {
  scope: MemoryScope;
  frontmatter: MemoryFrontmatter;
  body: string;
  // Optional MEMORY.md row overrides; defaults derived from
  // frontmatter.name / frontmatter.description. See
  // writer.ts buildIndexEntry.
  indexTitle?: string;
  indexHook?: string;
}

// Discriminated outcome of `MemoryRegistry.write()`. Mirrors
// `WriteMemoryResult` but is exported under the registry surface
// so callers don't import the writer directly. The tool layer
// uses the `kind` to map onto a model-facing tool error and the
// audit row's `details.reason`.
export type RegistryWriteResult = WriteMemoryResult;

// Generic audit emission. Used by the tool layer for `proposed`
// (modal opened) and `refused` (modal answered no/cancel,
// injection scanner blocked, headless gate blocked) — events
// that are NOT tied to a `write()` call. The registry's `write()`
// method already emits `created` / `refused` for the persist
// path; callers should NOT use `recordEvent` for those cases or
// the row will double-up.
export interface RegistryEventInput extends AuditOverride {
  action: MemoryEventAction;
  scope: MemoryScope;
  memoryName: string;
  source: MemorySource;
  details?: Record<string, unknown>;
}

export type RegistryReadResult =
  | { kind: 'present'; scope: MemoryScope; file: MemoryFile }
  | { kind: 'missing'; scope: MemoryScope }
  | { kind: 'malformed'; scope: MemoryScope; error: string }
  | { kind: 'unknown' };

export interface MemorySearchHit {
  scope: MemoryScope;
  name: string;
  // Why this entry matched. `name` / `description` matches don't
  // require a body load; `body` matches imply the body was either
  // pre-loaded or `deep: true` was set.
  matchedIn: 'name' | 'description' | 'body';
  // Trimmed snippet showing the match. For body matches, the
  // surrounding context (configurable; defaults to the whole
  // matching line). For name / description matches, the field's
  // verbatim content.
  snippet: string;
  entry: IndexEntry;
}

export interface CreateMemoryRegistryInput {
  roots: ScopeRoots;
  // When provided, `read` calls emit a `memory_events` row with
  // action='read'. Optional so unit tests can construct a registry
  // without a DB.
  db?: DB;
  // Anchors the audit row's session_id and cwd columns. Both
  // optional — the tools layer wires them from ToolContext.
  sessionId?: string;
  cwd?: string;
}

// Precedence is: local first (most specific), then shared, then user.
// Used both for the `list()` order and for `lookup` fallback.
const SCOPE_ORDER: readonly MemoryScope[] = ['project_local', 'project_shared', 'user'];

interface ScopeSnapshot {
  scope: MemoryScope;
  // 'absent' / 'malformed' produce empty entries and a separate
  // diagnostic field the audit layer can read.
  entries: IndexEntry[];
  diagnostic: ScopeIndexResult;
}

// Split body into lines for snippet extraction. We keep raw lines
// (no trim) so column offsets in matches stay meaningful when the
// search UI grows column highlights later.
const splitBodyLines = (body: string): string[] => body.split('\n');

const matchSnippet = (lines: string[], query: string): string | null => {
  const q = query.toLowerCase();
  for (const line of lines) {
    if (line.toLowerCase().includes(q)) {
      // Trim aggressive whitespace so a multi-line indented block
      // doesn't blow up the snippet width. Keep at most ~160 chars
      // centered on the match.
      const trimmed = line.trim();
      if (trimmed.length <= 160) return trimmed;
      const idx = trimmed.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 60);
      const end = Math.min(trimmed.length, idx + q.length + 60);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < trimmed.length ? '…' : '';
      return `${prefix}${trimmed.slice(start, end)}${suffix}`;
    }
  }
  return null;
};

export const createMemoryRegistry = (input: CreateMemoryRegistryInput): MemoryRegistry => {
  const { roots, db, sessionId, cwd } = input;

  let snapshots: ScopeSnapshot[] = [];

  const refresh = (): void => {
    snapshots = SCOPE_ORDER.map((scope) => {
      const result = loadScopeIndex(roots, scope);
      const entries = result.kind === 'present' ? result.index.entries : [];
      return { scope, entries, diagnostic: result };
    });
  };
  refresh();

  // For each (name, scope) pair, return the registered listing.
  // Iteration order = precedence order (local → shared → user).
  //
  // Index entries whose `href` doesn't end in `.md` (parser accepts
  // any non-paren content per the SECURITY CONTRACT in
  // `index-file.ts` — operators can hand-edit the file with
  // arbitrary URLs or typos) are silently skipped here. Without the
  // skip, `memoryNameFromPath` would throw and the whole list /
  // search call would crash, taking the model's tool call with it.
  // The malformed-entry diagnostic is reachable via
  // `loadScopeIndex(...).index.malformedLines` for the future
  // /memory audit surface (5.6); this layer just keeps the read
  // path crash-free.
  const allListings = (): MemoryListing[] => {
    const out: MemoryListing[] = [];
    for (const snap of snapshots) {
      for (const entry of snap.entries) {
        try {
          out.push({ scope: snap.scope, name: memoryNameFromPath(entry.href), entry });
        } catch {
          // Malformed href; skip silently. See above.
        }
      }
    }
    return out;
  };

  const findListing = (name: string, scope?: MemoryScope): MemoryListing | null => {
    for (const snap of snapshots) {
      if (scope !== undefined && snap.scope !== scope) continue;
      for (const entry of snap.entries) {
        // We compare against the name derived from href (the
        // canonical id), NOT entry.title — title is human-facing
        // display text and may diverge from the file basename per
        // operator-edited indexes.
        try {
          if (memoryNameFromPath(entry.href) === name) {
            return { scope: snap.scope, name, entry };
          }
        } catch {
          // Malformed href (no .md suffix) — skip silently. The
          // operator can fix the index entry; we don't crash the
          // lookup. Audit-side surfaces these via `loadScopeIndex`'s
          // `parsedIndex.malformedLines`.
        }
      }
      // No match in this scope. If the caller pinned a scope, stop
      // here — strict lookup, no fallback.
      if (scope !== undefined) return null;
    }
    return null;
  };

  const auditRead = (
    listing: MemoryListing,
    fileResult: MemoryFileResult,
    override: AuditOverride = {},
  ): void => {
    if (db === undefined) return;
    if (fileResult.kind !== 'present') return;
    // Per-call override wins over constructor capture. Top-level
    // bootstrap can't know the session id at construction time
    // (session is created later by the harness loop), so it
    // builds the registry without one and the tool layer passes
    // ctx.sessionId on every call. Subagent-child knows the id
    // at construction AND tools still pass it — both end at the
    // same value, override is harmless.
    //
    // Source of the read event mirrors the source of the read
    // memory itself. Without a frontmatter source field the audit
    // would lie about provenance.
    //
    // The DB write itself is wrapped: a SQLite failure (disk full,
    // FK lock, corruption) MUST NOT propagate as an exception
    // because the body load already succeeded — the contract is
    // that a successful read returns the body. Audit drift is
    // surfaced to the operator via stderr, mirroring the bg-reaper
    // pattern (subagents/runtime.ts D9: "AUDIT DRIFT" warnings)
    // where disk-side work is trusted over audit consistency.
    const effectiveSessionId = override.auditSessionId ?? sessionId ?? null;
    const effectiveCwd = override.auditCwd ?? cwd ?? null;
    try {
      createMemoryEvent(db, {
        scope: listing.scope,
        action: 'read',
        memoryName: listing.name,
        source: fileResult.file.frontmatter.source,
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to record read event for ${listing.name} (${listing.scope}): ${msg}\n`,
      );
    }
  };

  return {
    roots,
    list(opts: ListOptions = {}): MemoryListing[] {
      const all = allListings();
      let filtered = all;
      if (opts.scope !== undefined) {
        filtered = filtered.filter((l) => l.scope === opts.scope);
      }
      if (opts.deduplicateByName === true) {
        const seen = new Set<string>();
        filtered = filtered.filter((l) => {
          if (seen.has(l.name)) return false;
          seen.add(l.name);
          return true;
        });
      }
      return filtered;
    },

    lookup(name, opts: ScopeOption = {}): MemoryListing | null {
      return findListing(name, opts.scope);
    },

    read(name, opts: ReadOptions = {}): RegistryReadResult {
      const listing = findListing(name, opts.scope);
      if (listing === null) return { kind: 'unknown' };
      const fileResult = readMemoryByName(roots, listing.scope, name);
      if (fileResult.kind === 'present') {
        auditRead(listing, fileResult, {
          ...(opts.auditSessionId !== undefined ? { auditSessionId: opts.auditSessionId } : {}),
          ...(opts.auditCwd !== undefined ? { auditCwd: opts.auditCwd } : {}),
        });
        return { kind: 'present', scope: listing.scope, file: fileResult.file };
      }
      if (fileResult.kind === 'missing') {
        return { kind: 'missing', scope: listing.scope };
      }
      return { kind: 'malformed', scope: listing.scope, error: fileResult.error };
    },

    peek(name, opts: ScopeOption = {}): RegistryReadResult {
      // Mirrors `read` but skips `auditRead`. Same lookup
      // semantics (precedence walk if `opts.scope` absent, strict
      // single-scope when set). Same discriminated outcome shape
      // so callers can branch identically.
      const listing = findListing(name, opts.scope);
      if (listing === null) return { kind: 'unknown' };
      const fileResult = readMemoryByName(roots, listing.scope, name);
      if (fileResult.kind === 'present') {
        return { kind: 'present', scope: listing.scope, file: fileResult.file };
      }
      if (fileResult.kind === 'missing') {
        return { kind: 'missing', scope: listing.scope };
      }
      return { kind: 'malformed', scope: listing.scope, error: fileResult.error };
    },

    search(query, opts: SearchOptions = {}): MemorySearchHit[] {
      const q = query.trim();
      if (q.length === 0) return [];
      const limit = opts.limit ?? 50;
      const lower = q.toLowerCase();

      const candidates =
        opts.scope === undefined
          ? allListings()
          : allListings().filter((l) => l.scope === opts.scope);

      const hits: MemorySearchHit[] = [];

      // Pass 1: cheap matches against name and description (no body
      // load required). The hit list grows in precedence order.
      // Limit check is at the top so a full hit list short-circuits
      // before any further disk reads in the deep branch.
      for (const listing of candidates) {
        if (hits.length >= limit) break;
        if (listing.name.toLowerCase().includes(lower)) {
          hits.push({
            scope: listing.scope,
            name: listing.name,
            matchedIn: 'name',
            snippet: listing.name,
            entry: listing.entry,
          });
          continue;
        }
        if (listing.entry.hook.toLowerCase().includes(lower)) {
          hits.push({
            scope: listing.scope,
            name: listing.name,
            matchedIn: 'description',
            snippet: listing.entry.hook,
            entry: listing.entry,
          });
          continue;
        }
        // Body match — only when the caller opted into deep search.
        // This branch reads the file from disk; for a 50-entry
        // registry that's 50 small reads, but we still gate behind
        // an explicit flag so the default `memory_search` tool call
        // stays cheap.
        if (opts.deep === true) {
          const fileResult = readMemoryByName(roots, listing.scope, listing.name);
          if (fileResult.kind !== 'present') continue;
          const snippet = matchSnippet(splitBodyLines(fileResult.file.body), q);
          if (snippet === null) continue;
          // Audit emission for body-match hits. The model receives
          // a snippet of the body content via the search result, so
          // for audit purposes this IS a read — same accountability
          // as a direct memory_read call. Without this, an attacker
          // monitoring memory_events for content exposure would
          // miss search-deep hits entirely. Mirrors auditRead's
          // best-effort try/catch (DB failures don't deny the
          // search hit). Per-call audit override forwarded so
          // top-level reads get attributed to the active session
          // rather than NULL (the bootstrap-time constructor's
          // sessionId is undefined).
          auditRead(listing, fileResult, {
            ...(opts.auditSessionId !== undefined ? { auditSessionId: opts.auditSessionId } : {}),
            ...(opts.auditCwd !== undefined ? { auditCwd: opts.auditCwd } : {}),
          });
          hits.push({
            scope: listing.scope,
            name: listing.name,
            matchedIn: 'body',
            snippet,
            entry: listing.entry,
          });
        }
      }
      return hits.slice(0, limit);
    },

    reload(): void {
      refresh();
    },

    count(opts: { deduplicateByName?: boolean } = {}): number {
      // Reuse `list()` so the dedupe logic stays single-source:
      // future changes to scope precedence / filtering live in
      // one place.
      return this.list({ deduplicateByName: opts.deduplicateByName === true }).length;
    },

    write(opts: WriteOptions): RegistryWriteResult {
      // Dispatch to the writer. All path / sandbox / atomic-write
      // logic lives there; the registry only adds audit + snapshot
      // refresh.
      const result = writeMemory({
        roots,
        scope: opts.scope,
        frontmatter: opts.frontmatter,
        body: opts.body,
        ...(opts.indexTitle !== undefined ? { indexTitle: opts.indexTitle } : {}),
        ...(opts.indexHook !== undefined ? { indexHook: opts.indexHook } : {}),
      });

      // Audit emission. Same defensive try/catch as `auditRead`:
      // an audit failure must not invalidate a successful write
      // (the body + index already hit disk). For `refused`
      // outcomes the audit IS the operator's only signal, but
      // the writer also returned the result to the caller so the
      // tool layer can still surface a model-facing error if the
      // db write fails. AUDIT DRIFT mirrors the same stderr
      // pattern.
      const effectiveSessionId = opts.auditSessionId ?? sessionId ?? null;
      const effectiveCwd = opts.auditCwd ?? cwd ?? null;
      if (db !== undefined) {
        try {
          if (result.kind === 'created') {
            createMemoryEvent(db, {
              scope: opts.scope,
              action: 'created',
              memoryName: opts.frontmatter.name,
              source: opts.frontmatter.source,
              sessionId: effectiveSessionId,
              cwd: effectiveCwd,
              details: {
                path: result.path,
                href: result.href,
                type: opts.frontmatter.type,
                ...(opts.frontmatter.expires !== undefined
                  ? { expires: opts.frontmatter.expires }
                  : {}),
                ...(opts.frontmatter.trust !== undefined ? { trust: opts.frontmatter.trust } : {}),
              },
            });
          } else {
            // Every non-success outcome lands as `refused` with the
            // kind discriminator + a human-readable reason. The
            // alternative was a per-kind action (`exists` →
            // `refused_exists`, etc.) but `MemoryEventAction` is a
            // closed union and adding entries is a migration; the
            // discriminator in `details.reason` carries the same
            // information without schema churn.
            const reason = describeWriteFailure(result);
            createMemoryEvent(db, {
              scope: opts.scope,
              action: 'refused',
              memoryName: opts.frontmatter.name,
              source: opts.frontmatter.source,
              sessionId: effectiveSessionId,
              cwd: effectiveCwd,
              details: { kind: result.kind, reason },
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `memory: AUDIT DRIFT: failed to record ${result.kind === 'created' ? 'created' : 'refused'} event for ${opts.frontmatter.name} (${opts.scope}): ${msg}\n`,
          );
        }
      }

      // Refresh the in-memory snapshot on success so the new
      // entry shows up in subsequent `list` / `lookup` calls
      // within the same session. On failure the snapshot is
      // unchanged.
      if (result.kind === 'created') {
        refresh();
        // Non-fatal warnings (today: malformed MEMORY.md lines that
        // were dropped on re-serialize) go to stderr so the operator
        // sees them. Silent drop would be data loss; failing the
        // write would surprise the operator at the worst moment
        // (model just proposed a useful memory). The audit row's
        // `details` doesn't carry these because the warning is
        // about lines OPERATOR wrote, not about this write — but
        // the stderr line gives the line numbers for hand-fix.
        for (const warning of result.warnings) {
          if (warning.kind === 'malformed_index_lines') {
            process.stderr.write(
              `memory: index drift: dropped malformed lines ${warning.lines.join(', ')} in ${opts.scope}/MEMORY.md while upserting ${opts.frontmatter.name}; hand-fix the file shape\n`,
            );
          }
        }
      }

      return result;
    },

    recordEvent(input: RegistryEventInput): void {
      if (db === undefined) return;
      const effectiveSessionId = input.auditSessionId ?? sessionId ?? null;
      const effectiveCwd = input.auditCwd ?? cwd ?? null;
      try {
        createMemoryEvent(db, {
          scope: input.scope,
          action: input.action,
          memoryName: input.memoryName,
          source: input.source,
          sessionId: effectiveSessionId,
          cwd: effectiveCwd,
          ...(input.details !== undefined ? { details: input.details } : {}),
        });
      } catch (err) {
        // Same defensive pattern as auditRead — audit failures
        // must not throw past this seam. The caller has no
        // recovery path; surfacing on stderr is the convention.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `memory: AUDIT DRIFT: failed to record ${input.action} event for ${input.memoryName} (${input.scope}): ${msg}\n`,
        );
      }
    },
  };
};

// Map a `WriteMemoryResult` non-success variant to a one-line
// reason string. Stable across releases — UI / audit consumers
// may match on these strings. Hoisted out of the closure so
// tests can import it.
const describeWriteFailure = (result: WriteMemoryResult): string => {
  switch (result.kind) {
    case 'created':
      return 'created';
    case 'exists':
      return `memory already exists at ${result.path}`;
    case 'shared_forbidden':
      return 'direct writes to project_shared are forbidden; use /memory promote';
    case 'sandbox_violation':
      return result.reason;
    case 'symlink_refused':
      return `target path is a symlink: ${result.path}`;
    case 'index_full':
      return `MEMORY.md hard cap reached (${result.current}/${result.cap}); evict before writing`;
    case 'io_error':
      return result.reason;
  }
};
