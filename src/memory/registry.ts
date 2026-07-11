import { redactSecrets } from '../sanitize/secrets.ts';
import type { DB } from '../storage/db.ts';
import { createMemoryEvent, type MemoryEventAction } from '../storage/repos/memory-events.ts';
import {
  type OverrideSignal,
  recordOverrideEvent,
} from '../storage/repos/memory-override-events.ts';
import {
  hashMemoryContent,
  listProvenanceForToolCall,
  listRecentSessionExposures,
  type MemoryProvenanceRow,
  recordProvenance,
} from '../storage/repos/memory-provenance.ts';
import { isExpired } from './expires.ts';
import { serializeMemoryFile } from './frontmatter.ts';
import {
  loadScopeIndex,
  loadSeedsIndex,
  type MemoryFileResult,
  memoryNameFromPath,
  readMemoryByName,
  readSeedByName,
  type ScopeIndexResult,
} from './loader.ts';
import type { ScopeRoots } from './paths.ts';
import { isSeedDisabled, loadDisabledSeeds } from './seeds-disabled.ts';
import type {
  IndexEntry,
  MemoryFile,
  MemoryFrontmatter,
  MemoryScope,
  MemorySource,
  MemoryState,
  MemorySubdir,
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
  // Subdirectory under the scope root, when the body lives in one.
  // Only the user scope has a subdir today (`'seeds'`); the others
  // are flat. Consumers that resolve a listing back to a file path
  // MUST dispatch on this field — e.g., `read(name)` routes via
  // `readSeedByName` when set, `readMemoryByName` otherwise.
  subdir?: MemorySubdir;
  // Index entry as parsed. The lookup may use this to display title
  // and hook without loading the body. `entry.href` is NOT trusted
  // for path resolution — see SECURITY CONTRACT in `index-file.ts`.
  entry: IndexEntry;
  // Frontmatter state at the moment list() was called. Populated
  // ONLY when `list()` already peeked the body for filtering
  // (i.e., `opts.states` or `opts.includeExpired === false` was
  // set). Undefined otherwise — caller that didn't request state
  // filtering shouldn't pay the per-listing peek cost just to read
  // the state field. Consumers that need state must EITHER pass
  // a `states` filter (cheap reuse of the existing peek) OR peek
  // directly. Document on the call site which path was chosen.
  state?: MemoryState;
  // Parsed MemoryFile from the same peek that populated `state`
  // (P1/F3 hardening). Populated alongside `state` when `list()`
  // ran a body peek for filtering — callers that consume the file
  // (e.g., the bulk-invalidate path needs `frontmatter.source`
  // for audit attribution; the stale-invalidated GC needs the
  // full frontmatter to derive `StaleInvalidatedMemory.source`)
  // can read `listing.file` instead of paying a SECOND peek.
  // Undefined when `state` is undefined; reading `file` without
  // setting a `states` filter requires an explicit `peek()` call.
  file?: MemoryFile;
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

  // Attribute an operator override (memory_write reject, permission
  // deny, edit revert — see spec §6.5.2 detector signals) to the
  // factual memories that could have driven the rejected behavior.
  // Inserts one `memory_override_events` row per attributed memory.
  //
  // Resolves the candidate pool via `memory_provenance`:
  //   - `toolCallId` set → memories exposed at that specific call
  //   - `toolCallId` absent → session's most-recent exposures
  // Filters to factual types (project / reference), trust !==
  // untrusted, state === active. Cap at MAX_OVERRIDE_ATTRIBUTION_DEPTH
  // memories per override (bounds amplification).
  //
  // Best-effort — silently no-ops when the registry was constructed
  // without a db handle OR no session is attributed. Per-row INSERT
  // failures stderr-log and continue (mirror of `recordEvent`).
  // Returns the count of attributed rows for tests / forensics.
  recordOverrideSignal(input: RegistryOverrideSignalInput): { attributedCount: number };
}

export interface ListOptions {
  scope?: MemoryScope;
  deduplicateByName?: boolean;
  // When set, restrict to listings whose current frontmatter `state`
  // is in this allow-list (absence in frontmatter ≡ `active`).
  // Default (undefined) returns every listing regardless of state —
  // keeps existing callers (operator-facing `/memory list`, audit
  // surfaces, count for boot banner) unchanged.
  //
  // Production consumers that hand candidates to the model
  // (retrieval views, eager-injection, model-facing search) should
  // pass `['active']` so quarantined / invalidated / proposed /
  // evicted / purged memories never reach the model's view.
  //
  // Cost: filtering triggers one file read per surviving listing
  // (to parse the current frontmatter from disk — the cached
  // snapshot only carries IndexEntry from MEMORY.md, not the .md
  // frontmatter). Tolerable for the dozens-of-memories scale the
  // spec assumes; a future cache layer can promote `state` /
  // `expires` into the snapshot if N grows large enough to matter.
  states?: readonly MemoryState[];
  // When `false`, exclude listings whose frontmatter `expires` is
  // strictly before `nowMs`. Default (undefined) returns every
  // listing regardless of expiration — boot-time GC remains the
  // authoritative sweep; this flag is the at-pull defense for
  // callers (notably retrieval) that should never surface a stale
  // memory to the model between sweeps.
  //
  // Same per-listing file-read cost as `states`. Setting either
  // option triggers the read; setting both shares it.
  includeExpired?: boolean;
  // `nowMs` reference for `includeExpired` evaluation. Default
  // `Date.now()`. Tests pin a fixed value so the filter is
  // deterministic against fixtures that hand-craft `expires`.
  nowMs?: number;
  // Scope-level fail-closed exclusion (S5 retrieval-view review).
  // Listings whose scope is in this list are dropped BEFORE the
  // state/expires peek AND before `deduplicateByName` — order that
  // matters because a higher-precedence shadow in an excluded
  // scope would otherwise suppress an eligible lower-precedence
  // sibling at dedup time, leaving NO candidate for that name even
  // though a trusted one exists in a permitted scope.
  //
  // Mirrors the `excludeScopes` semantic that `assembleMemorySection`
  // applies to the eager-load section: the trust probe's
  // non-confirmed outcomes (`verify_failed` / `deferred` / `revoked`)
  // make the bootstrap caller pass `['project_shared']` here so
  // retrieval and eager-load share the same scope posture — the
  // model can't pull unattested bodies via tool calls when the
  // system prompt was already locked down.
  //
  // Empty / absent ≡ no exclusion. Distinct from the singular
  // `scope` field (which RESTRICTS to one scope); these stack: a
  // caller can pass `scope: 'user'` together with
  // `excludeScopes: ['project_shared']` and the result is just
  // user-scope listings.
  excludeScopes?: readonly MemoryScope[];
}

export interface ScopeOption {
  scope?: MemoryScope;
  // Strict subdir filter. When set, only snapshots whose
  // `snap.subdir === opts.subdir` are considered by lookup / peek /
  // read. When omitted, the precedence walk includes ALL snapshots
  // matching the scope filter — which is what the current callers
  // that pass only `name` (or `name + scope`) expect.
  //
  // Callers that iterate `registry.list()` and then re-peek by the
  // listing's identity must pass this through, because the user
  // scope carries TWO snapshots (top-level + `seeds`) and a user-
  // top entry shadowing a seed of the same name would otherwise
  // resolve the seed listing's peek back to the user-top body. The
  // `listingScopeOption(listing)` helper below builds the right
  // option object from a listing without any conditional spread
  // gymnastics at call sites.
  subdir?: MemorySubdir;
}

// Build a strict `ScopeOption` from a listing so re-peeks resolve
// to the same snapshot the listing came from. Centralizes the
// conditional spread needed under `exactOptionalPropertyTypes`
// (passing `subdir: undefined` is not the same as omitting the
// key, so callers can't just spread `listing` directly).
export const listingScopeOption = (listing: MemoryListing): ScopeOption => {
  const opt: ScopeOption = { scope: listing.scope };
  if (listing.subdir !== undefined) opt.subdir = listing.subdir;
  return opt;
};

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
  // Slice 1 — provenance. When set, every successful body load
  // through `read()` (and `search(deep)`) ALSO emits a
  // `memory_provenance` row with surface='memory_read', linking
  // the exposure to the originating tool_call. Eager-load
  // exposures (T1.4) and retrieve_context exposures (T1.5) emit
  // through different paths with their own surface. Absent / null
  // means "no provenance row" — the registry skips silently, which
  // matches the registry's audit-best-effort posture.
  auditToolCallId?: string;
}

export interface ReadOptions extends ScopeOption, AuditOverride {}

export interface SearchOptions extends AuditOverride {
  scope?: MemoryScope;
  deep?: boolean;
  limit?: number;
  // Cap on how many deep-match hits emit `read` + provenance
  // events. Defaults to `limit` — every hit returned to the caller
  // is audited, which is the right behavior for callers that don't
  // over-fetch.
  //
  // `memory_search` requests `limit + 1` results to detect
  // truncation (extra row means there's more) but only returns
  // `limit` to the model. Without this knob, the over-fetched row
  // gets a body read + audit + provenance entry as if exposed,
  // inflating exposure counts and skewing detectors that treat
  // provenance as "visible to model" evidence. The tool sets
  // `auditLimit: limit` so the over-fetch sentinel stays purely a
  // truncation signal.
  //
  // Effective only when `deep: true`. Name/description matches do
  // no body reads and emit nothing regardless of this cap.
  auditLimit?: number;
  // Scope-level fail-closed exclusion (S5 retrieval-view review).
  // Listings whose scope is in this list are dropped BEFORE the
  // precedence walk that fills `limit`. Mirrors the same field on
  // `ListOptions` and is enforced for the same reason: a previous
  // shape post-filtered hits after `search` had already short-
  // circuited at the limit, so a higher-precedence excluded match
  // could fill the cap before any allowed-scope sibling was
  // considered — caller saw `[]` (or a too-short list) even when
  // permitted memories matched. With the filter at candidate-
  // build time, the precedence walk operates only over allowed
  // scopes and `limit` covers what actually surfaces.
  //
  // Empty / absent ≡ no exclusion. Distinct from the singular
  // `scope` field (which RESTRICTS to one scope); these stack.
  excludeScopes?: readonly MemoryScope[];
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

export interface RegistryOverrideSignalInput extends AuditOverride {
  signal: OverrideSignal;
  // When the override has a specific causal tool call (signal
  // `permission_denied`, future `edit_reverted`), pass its id to
  // scope attribution to memories exposed at that call. Absent for
  // signals upstream of dispatch (signal `memory_write_rejected`).
  toolCallId?: string | null;
  // Signal-specific opaque context. Persisted verbatim in
  // memory_override_events.details — detector / forensic code OWNS
  // the per-signal schema.
  details?: Record<string, unknown> | null;
  // Scopes to exclude from attribution. Mirrors the
  // `list({excludeScopes})` semantic so the scope-filtered
  // wrapper (S5 trust-probe revoked / verify-failed / deferred)
  // can preserve fail-closed posture symmetrically across
  // read-side methods AND override attribution. Without this,
  // a memory exposed during the trusted window of a session that
  // later revoked could still accumulate override events even
  // though the operator can no longer see / read it. External
  // callers normally omit (no exclusion).
  excludeScopes?: ReadonlyArray<MemoryScope>;
}

// `subdir` propagates from the underlying listing so callers that
// drive mutations (`/memory delete`, future `/memory restore` for
// seeds, etc.) can route disk operations to the right path. Slice-7
// review fix #1 — without this, the delete path lost subdir between
// peek and removeMemory and silently deleted the wrong file (or
// no file).
export type RegistryReadResult =
  | { kind: 'present'; scope: MemoryScope; subdir?: MemorySubdir; file: MemoryFile }
  | { kind: 'missing'; scope: MemoryScope; subdir?: MemorySubdir }
  | { kind: 'malformed'; scope: MemoryScope; subdir?: MemorySubdir; error: string }
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
// The vendor seed catalog (spec §5.7.4) is a sub-location under
// user scope, NOT a 4th scope — it shares scope='user' but lives
// at <user>/seeds/<name>.md. Refresh() builds a fourth snapshot
// for it AFTER the three SCOPE_ORDER entries, so precedence-wise:
//
//   project_local > project_shared > user > user/seeds
//
// An operator-authored memory at <user>/safe-edit.md eclipses a
// vendor seed of the same name. Vendor-curated meta-behavior is
// the fallback layer; operator customization always wins (matches
// the slice-4 upgrade lifecycle's "preserve what the user touched"
// rule, applied here at the lookup boundary rather than at write
// time).
const SCOPE_ORDER: readonly MemoryScope[] = ['project_local', 'project_shared', 'user'];

interface ScopeSnapshot {
  scope: MemoryScope;
  // When set, the snapshot's bodies live in `<scope-root>/<subdir>/`
  // instead of `<scope-root>/`. Only `'seeds'` today, only paired
  // with scope='user'. Distinguishes the user-seeds snapshot from
  // the user-top snapshot at lookup time.
  subdir?: MemorySubdir;
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

// Cap on attribution depth for `recordOverrideSignal`: one operator
// override produces at most K `memory_override_events` rows even
// when more than K factual memories were exposed. Bounds
// amplification; the threshold gate (spec §6.5.2: 3 per memory in
// 24h) still needs multiple overrides per memory to trip,
// regardless of K. Exported so tests can pin the contract.
export const MAX_OVERRIDE_ATTRIBUTION_DEPTH = 5;

export const createMemoryRegistry = (input: CreateMemoryRegistryInput): MemoryRegistry => {
  const { roots, db, sessionId, cwd } = input;

  let snapshots: ScopeSnapshot[] = [];

  const refresh = (): void => {
    const scopeSnapshots: ScopeSnapshot[] = SCOPE_ORDER.map((scope) => {
      const result = loadScopeIndex(roots, scope);
      const entries = result.kind === 'present' ? result.index.entries : [];
      return { scope, entries, diagnostic: result };
    });
    // Slice 7: append the user-seeds snapshot AFTER the user-top
    // entry so a name collision resolves to the operator-authored
    // copy first. `scope: 'user'` matches the eventual audit
    // attribution (seed reads land in `memory_events` against
    // user scope, with `source: 'seed'` carrying the catalog
    // origin signal). The discriminator is `subdir: 'seeds'`.
    const seedResult = loadSeedsIndex(roots);
    if (seedResult.kind === 'malformed') {
      // Operator hand-edited <user>/seeds/MEMORY.md and broke its
      // shape; slice-4's installer rewrites it on every boot so the
      // window is small, but until that next rewrite the model loses
      // every seed for this session. Surface a stderr line so the
      // operator sees the cause instead of "seeds vanished from
      // /memory list silently" (slice-7 review fix #4). Mirrors the
      // slice-4 manifest warn shape.
      process.stderr.write(
        `forja: seed index at <user>/seeds/MEMORY.md malformed (${seedResult.error}); seeds dropped this boot\n`,
      );
    }
    const seedEntries = seedResult.kind === 'present' ? seedResult.index.entries : [];
    // Filter disabled seeds out of the user/seeds snapshot (slice 5b,
    // spec §5.7.6). Defense-in-depth: `installVendorSeeds` already
    // excludes disabled entries from the regenerated `seeds/MEMORY.md`
    // on every install pass, so this filter is usually a no-op — but
    // if the sentinel was just updated by `/memory seeds disable` and
    // the installer hasn't re-run yet (or an operator hand-edited the
    // index, which the slice-7 malformed warn above handles for shape
    // corruption but not for stale entries), this layer still honors
    // the opt-out without waiting for the next install pass. Loading
    // the sentinel inside `refresh` (not at registry construction)
    // means `/memory seeds enable` followed by `registry.refresh()`
    // picks up the change without recreating the registry.
    const disabledSentinel = loadDisabledSeeds(roots);
    const filteredSeedEntries = seedEntries.filter((entry) => {
      try {
        const name = memoryNameFromPath(entry.href);
        return !isSeedDisabled(disabledSentinel, name);
      } catch {
        // Malformed href (e.g. operator-edited index with a non-`.md`
        // url): keep the entry in the snapshot so the malformed
        // shape stays observable on the same code path as the other
        // scope snapshots (allListings/findListing skip it silently
        // via their own try/catch). The authoritative malformed-
        // entry diagnostic lives in `loadSeedsIndex(...).index
        // .malformedLines`, not in the snapshot — filtering here
        // would not change what the audit surface sees, but it
        // would diverge the user/seeds snapshot from the other
        // scope snapshots for no benefit.
        return true;
      }
    });
    scopeSnapshots.push({
      scope: 'user',
      subdir: 'seeds',
      entries: filteredSeedEntries,
      diagnostic: seedResult,
    });
    snapshots = scopeSnapshots;
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
          const listing: MemoryListing = {
            scope: snap.scope,
            name: memoryNameFromPath(entry.href),
            entry,
          };
          if (snap.subdir !== undefined) listing.subdir = snap.subdir;
          out.push(listing);
        } catch {
          // Malformed href; skip silently. See above.
        }
      }
    }
    return out;
  };

  const findListing = (
    name: string,
    scope?: MemoryScope,
    subdir?: MemorySubdir,
  ): MemoryListing | null => {
    // Iterate every snapshot whose scope matches the filter (or all,
    // when scope is undefined). The user scope now contains TWO
    // snapshots (top-level + seeds subdir), so pinning the scope
    // must NOT terminate after the first one — fall through to
    // user-seeds when the top-level user snapshot doesn't carry
    // the name. Precedence is preserved because snapshots are in
    // precedence order (user-top precedes user-seeds).
    //
    // When `subdir` is set, the walk is strict: only snapshots
    // with matching `snap.subdir` qualify. This lets a caller that
    // holds a listing (and therefore knows the snapshot it came
    // from) re-peek the same body even when a higher-precedence
    // snapshot shadows the name. Without the filter, a seed listing
    // whose name collides with a user-top entry would resolve back
    // to the user-top body, defeating the filter-before-dedupe
    // contract that lets a lower-precedence trusted entry survive
    // when the higher-precedence one was filtered out (e.g., an
    // untrusted user-top shadowing a trusted seed).
    for (const snap of snapshots) {
      if (scope !== undefined && snap.scope !== scope) continue;
      if (subdir !== undefined && snap.subdir !== subdir) continue;
      for (const entry of snap.entries) {
        // We compare against the name derived from href (the
        // canonical id), NOT entry.title — title is human-facing
        // display text and may diverge from the file basename per
        // operator-edited indexes.
        try {
          if (memoryNameFromPath(entry.href) === name) {
            const hit: MemoryListing = { scope: snap.scope, name, entry };
            if (snap.subdir !== undefined) hit.subdir = snap.subdir;
            return hit;
          }
        } catch {
          // Malformed href (no .md suffix) — skip silently. The
          // operator can fix the index entry; we don't crash the
          // lookup. Audit-side surfaces these via `loadScopeIndex`'s
          // `parsedIndex.malformedLines`.
        }
      }
    }
    return null;
  };

  // Read a listing's body from disk, dispatching on `subdir`. Slice
  // 7 collapsed the six readMemoryByName call sites here into one
  // helper so adding a new subdir (or a slice-6 team-seeds variant)
  // touches one place instead of six.
  const readForListing = (listing: MemoryListing): MemoryFileResult => {
    if (listing.subdir === 'seeds') {
      return readSeedByName(roots, listing.name);
    }
    return readMemoryByName(roots, listing.scope, listing.name);
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
      // Slice 178 (review — P2). Redact secrets in the audit-drift
      // line — db error messages can include bound parameter values
      // from the memory body (which is operator-authored free text
      // and may contain accidental Bearer tokens / API keys).
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to record read event for ${listing.name} (${listing.scope}): ${redactSecrets(msg)}\n`,
      );
    }
  };

  // Slice 1 / T1.3 — emit a `memory_provenance` row for the
  // exposure. Same best-effort posture as `auditRead`: a DB
  // failure here MUST NOT propagate (the body load already
  // succeeded; the tool's contract to the model is satisfied).
  // The exposure row is the lower bound — "these bytes WERE in
  // the model's window" — and downstream detectors (S2/S3) layer
  // correlation on top.
  //
  // Skipped when:
  //   - no db is wired (headless / one-shot CLI sessions);
  //   - no toolCallId is passed (caller is NOT a per-call surface;
  //     eager-load and retrieve_context emit through their own
  //     paths with the right surface in T1.4 / T1.5);
  //   - no sessionId is resolvable (provenance is session-scoped
  //     by design — see schema header).
  //
  // The hash is computed from the canonical serialization
  // (`serializeMemoryFile`) — same producer the writer uses when
  // it persists a memory, so a memory the system wrote round-trips
  // through hash exactly. Operator-edited files with different
  // whitespace will hash differently, which IS the signal: drift
  // detection.
  const auditExposure = (
    listing: MemoryListing,
    fileResult: MemoryFileResult,
    override: AuditOverride = {},
  ): void => {
    if (db === undefined) return;
    if (fileResult.kind !== 'present') return;
    if (override.auditToolCallId === undefined) return;
    const effectiveSessionId = override.auditSessionId ?? sessionId ?? null;
    if (effectiveSessionId === null) return;
    try {
      const canonical = serializeMemoryFile(fileResult.file);
      const hash = hashMemoryContent(canonical);
      const stateAtExposure = fileResult.file.frontmatter.state ?? 'active';
      recordProvenance(db, {
        sessionId: effectiveSessionId,
        toolCallId: override.auditToolCallId,
        memoryScope: listing.scope,
        memoryName: listing.name,
        surface: 'memory_read',
        memoryContentHash: hash,
        memoryStateAtExposure: stateAtExposure,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `memory: AUDIT DRIFT: failed to record exposure for ${listing.name} (${listing.scope}): ${redactSecrets(msg)}\n`,
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

      // Scope-level fail-closed exclusion. Runs BEFORE the
      // state/expires peek (saves N reads on excluded scopes) AND
      // before `deduplicateByName` (so a shadow in an excluded
      // scope can't suppress an eligible lower-precedence sibling).
      // See ListOptions header for the spec rationale.
      if (opts.excludeScopes !== undefined && opts.excludeScopes.length > 0) {
        const excluded = new Set(opts.excludeScopes);
        filtered = filtered.filter((l) => !excluded.has(l.scope));
      }

      // State / expires filter — gated on the option so callers
      // that don't care don't pay the per-listing file-read cost.
      // The frontmatter lives in the .md file (NOT in the cached
      // IndexEntry snapshot), so we read each surviving listing
      // once. Missing / malformed files are excluded — they
      // belong to /memory audit, not the model. See ListOptions
      // for the rationale and the contract.
      //
      // ORDER MATTERS: this runs BEFORE the dedupe-by-name pass.
      // If we deduplicated first, a higher-precedence shadow
      // (e.g. `project_local/foo` that's quarantined / expired /
      // missing) would WIN the precedence walk and then be
      // dropped here — silently suppressing the lower-precedence
      // ELIGIBLE sibling (`project_shared/foo` or `user/foo`)
      // that should have surfaced for retrieval. Filtering first
      // means precedence operates over the eligible set only,
      // preserving the local > shared > user fallback semantic.
      const needFrontmatter = opts.states !== undefined || opts.includeExpired === false;
      if (needFrontmatter) {
        const nowMs = opts.nowMs ?? Date.now();
        // map() + filter(null) instead of a plain filter so we
        // can attach the read `state` to the surviving listing
        // without a second peek downstream. Each listing's
        // identity is preserved (same scope + name + entry); we
        // just enrich with the state we read for filtering. The
        // null-out form keeps the type narrow (no `MemoryListing
        // | null` array intermediate).
        //
        // Race-window note: `listing.state` reflects state at
        // list-time. If a downstream consumer re-peeks (e.g.,
        // memory view's loadBodies path), the peek may observe a
        // newer state (operator edited the file between list and
        // body-load). The penalty multiplier downstream is tied
        // to LIST-time state by design — a memory that's
        // quarantined when retrieval starts ranks with the
        // penalty for that retrieval, regardless of mid-flight
        // edits. Cross-call consistency is the next list()
        // call's responsibility.
        const enriched: (MemoryListing | null)[] = filtered.map((l) => {
          const fileResult = readForListing(l);
          if (fileResult.kind !== 'present') return null;
          const fm = fileResult.file.frontmatter;
          const state: MemoryState = fm.state ?? 'active';
          if (opts.states !== undefined && !opts.states.includes(state)) return null;
          if (opts.includeExpired === false && isExpired(fm.expires, nowMs)) return null;
          // P1/F3: attach the peeked file so callers (gc sweeps,
          // bulk-invalidate) don't pay a second peek to read the
          // frontmatter.source / body. The file is already in
          // memory from the filter peek above; sharing it costs
          // nothing.
          return { ...l, state, file: fileResult.file };
        });
        filtered = enriched.filter((l): l is MemoryListing => l !== null);
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
      return findListing(name, opts.scope, opts.subdir);
    },

    read(name, opts: ReadOptions = {}): RegistryReadResult {
      const listing = findListing(name, opts.scope, opts.subdir);
      if (listing === null) return { kind: 'unknown' };
      const fileResult = readForListing(listing);
      if (fileResult.kind === 'present') {
        const auditOverride: AuditOverride = {
          ...(opts.auditSessionId !== undefined ? { auditSessionId: opts.auditSessionId } : {}),
          ...(opts.auditCwd !== undefined ? { auditCwd: opts.auditCwd } : {}),
          ...(opts.auditToolCallId !== undefined ? { auditToolCallId: opts.auditToolCallId } : {}),
        };
        auditRead(listing, fileResult, auditOverride);
        auditExposure(listing, fileResult, auditOverride);
        const out: RegistryReadResult = {
          kind: 'present',
          scope: listing.scope,
          file: fileResult.file,
        };
        if (listing.subdir !== undefined) out.subdir = listing.subdir;
        return out;
      }
      if (fileResult.kind === 'missing') {
        const out: RegistryReadResult = { kind: 'missing', scope: listing.scope };
        if (listing.subdir !== undefined) out.subdir = listing.subdir;
        return out;
      }
      const out: RegistryReadResult = {
        kind: 'malformed',
        scope: listing.scope,
        error: fileResult.error,
      };
      if (listing.subdir !== undefined) out.subdir = listing.subdir;
      return out;
    },

    peek(name, opts: ScopeOption = {}): RegistryReadResult {
      // Mirrors `read` but skips `auditRead`. Same lookup
      // semantics (precedence walk if `opts.scope` absent, strict
      // single-scope when set, strict single-subdir when set).
      // Same discriminated outcome shape so callers can branch
      // identically.
      const listing = findListing(name, opts.scope, opts.subdir);
      if (listing === null) return { kind: 'unknown' };
      const fileResult = readForListing(listing);
      if (fileResult.kind === 'present') {
        const out: RegistryReadResult = {
          kind: 'present',
          scope: listing.scope,
          file: fileResult.file,
        };
        if (listing.subdir !== undefined) out.subdir = listing.subdir;
        return out;
      }
      if (fileResult.kind === 'missing') {
        const out: RegistryReadResult = { kind: 'missing', scope: listing.scope };
        if (listing.subdir !== undefined) out.subdir = listing.subdir;
        return out;
      }
      const out: RegistryReadResult = {
        kind: 'malformed',
        scope: listing.scope,
        error: fileResult.error,
      };
      if (listing.subdir !== undefined) out.subdir = listing.subdir;
      return out;
    },

    search(query, opts: SearchOptions = {}): MemorySearchHit[] {
      const q = query.trim();
      if (q.length === 0) return [];
      const limit = opts.limit ?? 50;
      const auditLimit = opts.auditLimit ?? limit;
      const lower = q.toLowerCase();

      // Candidate set. Scope restriction + scope exclusion BOTH
      // happen here, BEFORE the precedence-walk + limit loop below.
      // Filtering at this point is what gives `excludeScopes` its
      // precedence-fallback guarantee: a higher-precedence excluded
      // match never enters the loop, so the limit walks only over
      // permitted scopes. (Mirrors the same invariant `list()`
      // enforces with its own `excludeScopes` filter.)
      let candidates = allListings();
      if (opts.scope !== undefined) {
        candidates = candidates.filter((l) => l.scope === opts.scope);
      }
      if (opts.excludeScopes !== undefined && opts.excludeScopes.length > 0) {
        const excluded = new Set(opts.excludeScopes);
        candidates = candidates.filter((l) => !excluded.has(l.scope));
      }

      const hits: MemorySearchHit[] = [];
      // Body-match audit queue. Each entry captures the data needed
      // to fire `auditRead` + `auditExposure` AFTER the loop has
      // settled which hits actually survive the limit. Deferring
      // is what lets `memory_search` over-fetch (`limit + 1`) for
      // truncation detection without leaking an exposure event for
      // the extra row that the tool then drops from the response.
      const pendingDeepAudits: Array<{
        listing: MemoryListing;
        fileResult: MemoryFileResult;
        hitIndex: number;
      }> = [];

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
          const fileResult = readForListing(listing);
          if (fileResult.kind !== 'present') continue;
          const snippet = matchSnippet(splitBodyLines(fileResult.file.body), q);
          if (snippet === null) continue;
          // Defer the audit emission until we know which hits the
          // caller will keep. See `pendingDeepAudits` header — the
          // emission below the loop respects `auditLimit` so an
          // over-fetched-but-dropped row doesn't get a spurious
          // exposure row.
          pendingDeepAudits.push({ listing, fileResult, hitIndex: hits.length });
          hits.push({
            scope: listing.scope,
            name: listing.name,
            matchedIn: 'body',
            snippet,
            entry: listing.entry,
          });
        }
      }

      // Emit audits for body-match hits whose final index is within
      // `auditLimit`. The model receives a body snippet via the
      // search result, so each surviving hit IS a read for audit
      // purposes — same accountability as a direct memory_read.
      // Mirrors auditRead's best-effort try/catch (DB failures don't
      // deny the search hit). Per-call audit override forwarded so
      // top-level reads get attributed to the active session rather
      // than NULL (the bootstrap-time constructor's sessionId is
      // undefined).
      const auditOverride: AuditOverride = {
        ...(opts.auditSessionId !== undefined ? { auditSessionId: opts.auditSessionId } : {}),
        ...(opts.auditCwd !== undefined ? { auditCwd: opts.auditCwd } : {}),
        ...(opts.auditToolCallId !== undefined ? { auditToolCallId: opts.auditToolCallId } : {}),
      };
      for (const pa of pendingDeepAudits) {
        if (pa.hitIndex >= auditLimit) break;
        auditRead(pa.listing, pa.fileResult, auditOverride);
        auditExposure(pa.listing, pa.fileResult, auditOverride);
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
            `memory: AUDIT DRIFT: failed to record ${result.kind === 'created' ? 'created' : 'refused'} event for ${opts.frontmatter.name} (${opts.scope}): ${redactSecrets(msg)}\n`,
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
          `memory: AUDIT DRIFT: failed to record ${input.action} event for ${input.memoryName} (${input.scope}): ${redactSecrets(msg)}\n`,
        );
      }
    },

    recordOverrideSignal(input: RegistryOverrideSignalInput): { attributedCount: number } {
      if (db === undefined) return { attributedCount: 0 };
      const effectiveSessionId = input.auditSessionId ?? sessionId ?? null;
      if (effectiveSessionId === null) return { attributedCount: 0 };
      // S5 fail-closed posture: when the wrapping `createScope
      // FilteredRegistry` passes `excludeScopes`, the same scopes
      // that read-side methods refuse are also kept out of override
      // attribution. External callers normally omit; the wrapper
      // pre-merges its excluded set before delegating here.
      const excludedScopeSet: ReadonlySet<MemoryScope> =
        input.excludeScopes !== undefined ? new Set(input.excludeScopes) : new Set();
      // Pull a generous candidate pool (3× depth) so the filter has
      // headroom — if the top-N exposures fail the factual / active /
      // trusted filter, K survivors still emerge deeper in the list.
      const limit = MAX_OVERRIDE_ATTRIBUTION_DEPTH * 3;
      let exposures: MemoryProvenanceRow[];
      try {
        if (input.toolCallId !== undefined && input.toolCallId !== null) {
          exposures = listProvenanceForToolCall(db, effectiveSessionId, input.toolCallId, limit);
        } else {
          exposures = listRecentSessionExposures(db, effectiveSessionId, limit);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `memory: AUDIT DRIFT: failed to fetch exposures for override ${input.signal}: ${redactSecrets(msg)}\n`,
        );
        return { attributedCount: 0 };
      }
      if (exposures.length === 0) return { attributedCount: 0 };

      // Filter to factual + active + trusted, deduplicating by
      // (scope, name) so a memory exposed multiple times doesn't
      // double-count toward the threshold from a single override.
      // Exposures in excluded scopes are dropped FIRST (before the
      // peek + frontmatter checks) so the fail-closed posture
      // doesn't depend on disk reads.
      const seen = new Set<string>();
      const attributed: { scope: MemoryScope; name: string }[] = [];
      for (const e of exposures) {
        if (attributed.length >= MAX_OVERRIDE_ATTRIBUTION_DEPTH) break;
        if (excludedScopeSet.has(e.memoryScope)) continue;
        const key = `${e.memoryScope}/${e.memoryName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const listing = findListing(e.memoryName, e.memoryScope);
        if (listing === null) continue;
        const fileResult = readForListing(listing);
        if (fileResult.kind !== 'present') continue;
        const fm = fileResult.file.frontmatter;
        if (fm.type !== 'project' && fm.type !== 'reference') continue;
        if (fm.trust === 'untrusted') continue;
        if ((fm.state ?? 'active') !== 'active') continue;
        attributed.push({ scope: e.memoryScope, name: e.memoryName });
      }

      let attributedCount = 0;
      for (const m of attributed) {
        try {
          recordOverrideEvent(db, {
            sessionId: effectiveSessionId,
            memoryScope: m.scope,
            memoryName: m.name,
            signal: input.signal,
            toolCallId: input.toolCallId ?? null,
            details: input.details ?? null,
          });
          attributedCount++;
        } catch (err) {
          // Best-effort: stderr-log + continue. One bad row never
          // blocks the rest of the attribution chain.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `memory: override_signal_record_failed: ${m.scope}/${m.name} ${input.signal}: ${redactSecrets(msg)}\n`,
          );
        }
      }
      return { attributedCount };
    },
  };
};

// Wrap a `MemoryRegistry` so every read-side method (`list` /
// `lookup` / `read` / `peek` / `search` / `count`) honors a
// fail-closed `excludeScopes` policy. The harness loop applies
// this when the shared-corpus trust probe returns a non-confirmed
// outcome (`verify_failed` / `deferred` / `revoked`); without it,
// `memory_list` / `memory_read` / `memory_search` tools would
// expose the unfiltered registry and let the model enumerate and
// read project_shared bodies the operator already marked offline
// — a direct bypass of the trust gate that the eager-load and
// retrieval surfaces already respect.
//
// Write-side methods (`write`, `recordEvent`) pass through. This
// fix scopes to reads (the bypass the review flagged); whether a
// trust-revoked session should ALSO block new shared writes is a
// separate policy question the writer's own gates can handle.
//
// Read-side semantics:
//   - `list({ scope: excludedScope })` → empty (caller pinned an
//     excluded scope).
//   - `list({})` → underlying ListOptions.excludeScopes is merged
//     with the wrapper's set so the filter runs BEFORE dedup
//     (preserves the precedence-fallback the previous review fix
//     established — see ListOptions header).
//   - `lookup` / `read` / `peek` with `opts.scope` set: excluded
//     scope returns null / `unknown`; allowed scope delegates.
//   - `lookup` / `read` / `peek` without `opts.scope`: walk
//     SCOPE_ORDER, skip excluded scopes, return the first hit (or
//     null / unknown). Audit emission only fires on the successful
//     `present` outcome (same as the underlying registry's
//     contract); intermediate misses across allowed scopes don't
//     emit because the underlying `read`/`peek` skip audit when
//     `kind !== 'present'`.
//   - `search` filters hits AFTER the underlying call. A pinned
//     `opts.scope` in an excluded set short-circuits to []. The
//     `limit` / `auditLimit` semantics are preserved by passing
//     them through; the wrapper's post-filter only removes hits in
//     the excluded scopes (it can't add audit suppression on
//     excluded hits because the underlying registry already
//     audited them — but excluded scopes are blocked before the
//     base call when caller pins them, and the only path that
//     would emit for an excluded scope is when caller didn't pin
//     and the underlying iterator happened to hit one; the
//     wrapper accepts that minor overshoot as the cost of not
//     restructuring SearchOptions to carry excludeScopes natively,
//     since the audit row is operator-forensic and the model
//     never sees the row anyway).
//   - `count({})` excludes filtered scopes by walking `list`.
//
// `excludeScopes` is captured at wrapper-creation time; if the
// trust posture changes mid-session (operator runs
// `/memory trust accept`), the bootstrap re-builds the harness
// config + re-wraps. The wrapper itself doesn't mutate.
export const createScopeFilteredRegistry = (
  base: MemoryRegistry,
  excludeScopes: readonly MemoryScope[],
): MemoryRegistry => {
  // Empty exclusion is a degenerate case; callers should avoid
  // wrapping in that situation, but if they do we just delegate
  // everything to keep the wrapper neutral.
  if (excludeScopes.length === 0) return base;
  const excluded = new Set<MemoryScope>(excludeScopes);
  // Local copy of the precedence order. Module-private constant
  // SCOPE_ORDER inlined here so the wrapper's behavior tracks the
  // registry's scope precedence exactly without exporting an
  // internal symbol.
  const ORDER: readonly MemoryScope[] = ['project_local', 'project_shared', 'user'];

  const mergeListOptions = (opts: ListOptions = {}): ListOptions => {
    const existing = opts.excludeScopes ?? [];
    const combined = new Set<MemoryScope>([...existing, ...excludeScopes]);
    return { ...opts, excludeScopes: Array.from(combined) };
  };

  // Walk the precedence order, skip excluded scopes, return the
  // first result the `sentinel` says is terminal (non-miss). Used
  // by lookup/read/peek so the wrapper preserves "fall through to
  // the next allowed scope when the most-specific scope is
  // excluded" — same fallback the eager-load and retrieval views
  // get via list({ excludeScopes }).
  const tryEachAllowedScope = <T>(
    delegate: (s: MemoryScope) => T,
    sentinel: (result: T) => boolean,
  ): T | null => {
    for (const s of ORDER) {
      if (excluded.has(s)) continue;
      const result = delegate(s);
      if (!sentinel(result)) return result;
    }
    return null;
  };

  return {
    roots: base.roots,

    list(opts: ListOptions = {}): MemoryListing[] {
      if (opts.scope !== undefined && excluded.has(opts.scope)) return [];
      return base.list(mergeListOptions(opts));
    },

    lookup(name: string, opts: ScopeOption = {}): MemoryListing | null {
      if (opts.scope !== undefined) {
        if (excluded.has(opts.scope)) return null;
        return base.lookup(name, opts);
      }
      return (
        tryEachAllowedScope(
          (s) => base.lookup(name, { ...opts, scope: s }),
          (result) => result === null,
        ) ?? null
      );
    },

    read(name: string, opts: ReadOptions = {}): RegistryReadResult {
      if (opts.scope !== undefined) {
        if (excluded.has(opts.scope)) return { kind: 'unknown' };
        return base.read(name, opts);
      }
      const found = tryEachAllowedScope(
        (s) => base.read(name, { ...opts, scope: s }),
        // `unknown` is the keep-walking sentinel — `missing` /
        // `malformed` / `present` are terminal (the listing exists
        // at this scope; surface that outcome).
        (result) => result.kind === 'unknown',
      );
      return found ?? { kind: 'unknown' };
    },

    peek(name: string, opts: ScopeOption = {}): RegistryReadResult {
      if (opts.scope !== undefined) {
        if (excluded.has(opts.scope)) return { kind: 'unknown' };
        return base.peek(name, opts);
      }
      const found = tryEachAllowedScope(
        (s) => base.peek(name, { ...opts, scope: s }),
        (result) => result.kind === 'unknown',
      );
      return found ?? { kind: 'unknown' };
    },

    search(query: string, opts: SearchOptions = {}): MemorySearchHit[] {
      if (opts.scope !== undefined && excluded.has(opts.scope)) return [];
      // Merge the wrapper's excludeScopes into the native field so
      // candidate filtering runs BEFORE the precedence-walk + limit
      // loop. A previous shape post-filtered after `base.search`
      // returned, which meant a higher-precedence excluded match
      // could fill the limit before any allowed-scope sibling was
      // considered (e.g., `excludeScopes: ['project_shared']` +
      // `limit: 1` returning [] even when user/foo would match).
      // Routing into `SearchOptions.excludeScopes` puts the filter
      // at candidate-build time and restores the precedence-fallback
      // contract that `list` already enforces.
      const existing = opts.excludeScopes ?? [];
      const combined = new Set<MemoryScope>([...existing, ...excludeScopes]);
      return base.search(query, { ...opts, excludeScopes: Array.from(combined) });
    },

    count(opts: { deduplicateByName?: boolean } = {}): number {
      // Walk the wrapper's own list() to apply the filter; pass
      // the dedupe flag through. Operator-facing surfaces (boot
      // banner, footer tray) show the model-effective count, so
      // shared-offline sessions surface a reduced number.
      return this.list({
        ...(opts.deduplicateByName === true ? { deduplicateByName: true } : {}),
      }).length;
    },

    reload(): void {
      base.reload();
    },

    write(input: WriteOptions): RegistryWriteResult {
      // Writes pass through; see header for scope rationale.
      return base.write(input);
    },

    recordEvent(input: RegistryEventInput): void {
      base.recordEvent(input);
    },

    recordOverrideSignal(input: RegistryOverrideSignalInput): { attributedCount: number } {
      // S5 fail-closed posture: merge the wrapper's `excluded` set
      // with any caller-supplied `excludeScopes` before delegating.
      // Without this, the base impl's findListing wouldn't filter
      // (it's the unwrapped local closure, not the wrapper's
      // `lookup`) and a memory in an excluded scope still in the
      // session's exposure pool could accumulate override events
      // even though the operator can no longer see / read it
      // through the wrapped read methods.
      const merged = new Set<MemoryScope>(excluded);
      if (input.excludeScopes !== undefined) {
        for (const s of input.excludeScopes) merged.add(s);
      }
      return base.recordOverrideSignal({
        ...input,
        excludeScopes: Array.from(merged),
      });
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
