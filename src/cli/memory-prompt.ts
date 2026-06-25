import {
  type BootContext,
  EMPTY_BOOT_CONTEXT,
  type EagerExposure,
  type MemoryFile,
  type MemoryRegistry,
  type MemoryScope,
  listingScopeOption,
  serializeMemoryFile,
  shouldEagerLoadByTriggers,
} from '../memory/index.ts';
import { hashMemoryContent } from '../storage/repos/memory-provenance.ts';
import { sanitizeForPromptLine } from './prompt-codespan.ts';

// Eager memory index injection into the system prompt.
//
// Spec §4.1: "Index eager, content lazy. Modelo lê o índice,
// decide se vale puxar conteúdo." This module renders the
// per-session merged index as a system-prompt text block. The
// model sees every memory's name + scope + one-line description
// without having to invoke any tool — just like a project
// AGENTS.md sits in context. To inspect a body, the model calls
// `memory_read`.
//
// Output shape:
//
//   # Memory
//
//   Cross-session memories you can use. Call memory_read(name) to
//   load a body, memory_list / memory_search to explore.
//
//   - [project_local] commit-style — Title Case verbs in commits
//   - [project_shared] team-conv — code review conventions
//   - [user] role — full-stack TS dev
//
// Empty registries produce an empty string — no header, no
// scaffolding. The bootstrap composes the section onto the
// existing systemPrompt only when non-empty so callers without
// memories still see `config.systemPrompt === undefined` when no
// other prompt source set it.
//
// Deduplication is on by default: spec §2.4 makes scope
// precedence explicit (project_local > project_shared > user).
// The model learns which scope is "active" for a given name from
// the entry it sees, and shadowed entries from less-specific
// scopes are suppressed. Without dedup, the model would see the
// same name three times in three scopes and have to reason
// about which one wins — wasted tokens, wasted attention.
//
// Trust filtering (spec §7.2 mitigation 2) — memories with
// `trust: untrusted` MUST NOT enter the base context, only on
// demand via `memory_read`. The index file (`MEMORY.md`) has
// no trust column per spec §3.2 ("uma linha por memória, sem
// frontmatter próprio"), so the only way to know a memory's
// trust state is to read the body. We accept the per-session
// boot cost: N small disk reads at session start (memories are
// short and few — typical operator has <50 entries across all
// scopes) is negligible compared to the security win of
// keeping untrusted content out of the eager prompt cache.
// Reads go through `peek` instead of `read` so this filter
// pass doesn't flood `memory_events` with system-internal
// `read` rows.
//
// Failure modes when peek doesn't return a parseable file:
//   - 'missing' / 'malformed' / 'unknown' → INCLUDE the index
//     entry. Defaulting to "exclude on uncertainty" would
//     silently hide hand-edited memories the operator created
//     but couldn't have intended to mark untrusted (since
//     we couldn't read the trust marker). The operator already
//     sees malformed-body diagnostics elsewhere (audit table,
//     /memory list when it lands).
//   - 'present' + frontmatter.trust === 'untrusted' → SKIP.
//   - 'present' + trust absent or 'trusted' → INCLUDE.
//
// Boot-time triggers (spec §4.3) — memories with `triggers:` in
// their frontmatter are conditional eager-loads. The caller passes
// a `BootContext` (built by `evaluateBootTriggers(cwd)`); memories
// match per `shouldEagerLoadByTriggers`. Callers that don't want
// trigger filtering (tests, programmatic SDK use without a cwd)
// pass `EMPTY_BOOT_CONTEXT` — which makes well-known-tagged
// memories invisible until the corresponding context probe fires.
// The default for `bootContext` in this module is the empty
// context, so existing call sites without trigger awareness keep
// their pre-this-slice behavior MODULO the rule-2 escape hatch:
// memories tagged with operator-defined runtime tags pass through
// unconditionally. See `triggers.ts` for the full rule set.

// Verify-before-act guidance (spec §6.1). Memories may have been
// written days, weeks, or months ago — code drifts in between.
// Factual claims (file paths, exported names, schema shape) need
// to be re-checked against the current tree before the model acts
// on them; preference claims ("we use Title Case in commits")
// have no "current state" to verify against, so the verification
// step is wasted work.
//
// The guidance lives in the eager prompt section (always loaded
// when memories exist) rather than per-memory: the model needs
// to know the rule before reading any specific memory body, and
// repeating the rule at every memory_read call would burn tokens
// for no incremental signal. Spec's example (`memória diz X
// exporta Y → grep antes de agir`) is preserved verbatim in
// concept; concrete tools (grep, read_file) named so the model
// knows which tool to invoke for verification.
//
// Section text is two paragraphs: tool list + verification rule.
// Tools first because that's what the model needs for orientation
// ("what can I do with these memories?"); verification rule second
// because it's the safety nuance that needs to land BEFORE the
// list of names ("oh, and don't blindly trust the contents").
const MEMORY_SECTION_HEADER = `# Memory

Cross-session memories you can use. Call memory_read(name) to load a body, memory_list / memory_search to explore. Save new ones with memory_write when (and only when) they would carry forward something the next conversation can't derive from the code, git history, or this prompt.

Four types of memory exist; use the type that fits and resist saving anything that doesn't fit one of these:

- **user** — facts about the operator: role, expertise, what they're working on. Saved when learned. Tailors future explanations and tool choice.
- **feedback** — guidance from corrections AND validations. "Don't do X" plus "yes, exactly that approach worked". Save the rule plus a short WHY (the reason the operator gave) so edge cases stay legible.
- **project** — ongoing work, decisions, deadlines, motivations. Convert relative dates ("Thursday") to absolute (\`YYYY-MM-DD\`) at save time so the memory stays interpretable later.
- **reference** — pointers to external systems where current information lives (Linear projects, Grafana dashboards, Slack channels).

Do NOT save: code patterns, conventions, file paths, or architecture (re-read the code); git history or who-changed-what (\`git log\` is authoritative); fix recipes (the fix is in the code); ephemeral session state. These all rot or are reconstructible — saving them grows the index without adding signal.

Entries tagged \`[seed]\` are vendor-curated default disciplines (how to work, not facts to verify). Treat them as operative: when a seed's one-line hook bears on the action at hand, \`memory_read\` its body and apply it — they are defaults an operator memory or explicit instruction can override.

Before acting on a FACTUAL memory (file paths, exported names, schema shape), verify it against the current code with grep / read_file. If reality has drifted from the memory, update or discard the memory rather than acting on stale info. PREFERENCE memories (commit style, naming conventions) have no "current state" to verify against — proceed without re-checking.`;

// Condensed header for tight windows (CONTEXT_TUNING §2.2). On a small window the
// whole memory toolset (memory_read/search/write/list) is off the base surface,
// so the full header's save-taxonomy + verify guidance is teaching tools that
// aren't on the wire — ~510 tokens the window can't spare. Keep only the index
// pointer; the discipline returns with the full header on a larger window.
//
// The tool guidance is CONDITIONAL ("if … isn't in your toolset, reveal via
// tool_search"), NOT an assertion that the tools are off the surface. This
// header is boot-pinned (the `memory` segment is), but the tool list is
// per-turn: after a `/model` swap to a larger window, buildToolDefs re-adds
// memory_read/memory_search to the wire while this header stays put. A hard
// "they're off the surface — use tool_search" claim would then misdirect the
// model into tool_search, which filters the now-undeferred tools out of its
// catalog → a dead-end notFound instead of just calling the visible tool. The
// conditional phrasing stays correct whether or not the tools are on the wire.
const MEMORY_SECTION_HEADER_LEAN = `# Memory

Cross-session memory index below (\`[scope] name — hook\`). Load a body with memory_read, search with memory_search — if a memory tool isn't already in your toolset, reveal it with tool_search first.`;

export interface AssembleMemorySectionInput {
  registry: MemoryRegistry;
  // Boot-time trigger context (spec §4.3). When omitted, the
  // empty context is used: well-known-tagged memories are
  // filtered out, untagged and operator-runtime-tagged memories
  // pass through. Callers (production: bootstrap;
  // production: subagent-child) pass the result of
  // `evaluateBootTriggers(cwd)`.
  bootContext?: BootContext;
  // Per-playbook memory filter (`PLAYBOOKS.md` §1.1
  // `context_recipe.memory_filter`). When provided, the
  // assembled section keeps ONLY entries that match at least one
  // value in the filter list, where a value matches if it is:
  //
  //   - the entry's `frontmatter.type` (`user` / `feedback` /
  //     `project` / `reference`), OR
  //   - present in the entry's `frontmatter.triggers` array
  //     (free-form tags the author declared at memory creation).
  //
  // The filter applies AFTER the trust + boot-trigger pass, so
  // it composes with the existing safety filters rather than
  // replacing them. An empty list is treated as absent (no
  // filter); a non-empty list with no matching entries yields
  // an empty section (same shape as a registry with no
  // memories).
  //
  // Subagent-only surface: bootstrap (the operator-facing root)
  // intentionally does not consume this — the playbook is
  // narrowing the model's view inside a subagent context, not
  // the operator's.
  memoryFilter?: ReadonlyArray<string>;
  // Hard scope exclusion list (S5 P0/H2-rob hardening). When set,
  // every listing whose scope is in this set is dropped BEFORE the
  // per-entry trust / state / trigger filters run — equivalent to
  // "this scope is offline this boot". Use case: the shared-corpus
  // trust probe returned `verify_failed` (filesystem unreadable);
  // the bootstrap MUST fail-closed by excluding `project_shared`
  // so an attacker who renders the corpus unreadable can't keep
  // the previously-loaded shared memories in the model's context.
  // Empty / absent = no exclusion (current behavior).
  excludeScopes?: ReadonlyArray<MemoryScope>;
  // Window-relative cap on rendered index entries (CONTEXT_TUNING §2.2,
  // `memoryMaxEntries`). Applied AFTER trust/state/trigger/playbook filtering
  // and dedupe, keeping the highest-precedence entries. Caps the rendered
  // lines AND the `eagerLoaded` inventory together (consistency by
  // construction). The drop is NOT silent — a visible marker tells the model
  // how many were trimmed and how to reach them. Undefined / non-positive =
  // no cap. Bootstrap passes `memoryMaxEntries(bootWindow)`; the cap is
  // boot-pinned (eager-exposure provenance is a boot concept), not re-applied
  // per turn.
  maxEntries?: number;
  // Condense the section header for a tight window (CONTEXT_TUNING §2.2). When
  // true, the verbose save-taxonomy / verify guidance is replaced by a short
  // index pointer — justified because the memory tools are off the base surface
  // on a small window anyway. Index lines + cap marker are unaffected. Boot-time
  // decision (same window the cap keys off). Default false = full header.
  leanHeader?: boolean;
}

export interface AssembleMemorySectionResult {
  // Formatted block, or empty string when the registry has no
  // entries. Empty string is the "do nothing" signal — bootstrap
  // checks `length > 0` and skips composition entirely.
  text: string;
  // Number of entries rendered. Surfaced for telemetry / logging
  // (the bootstrap doesn't currently log this; future
  // observability can use it to track "memory token cost"
  // ratios).
  entryCount: number;
  // Inventory of memories that landed in the eager-load section,
  // captured at assembly time. The harness loop consumes this
  // right after `createSession` to emit one `memory_provenance`
  // row per (session, memory) with surface='eager' (MEMORY.md
  // §11.2). Hash + state-at-exposure are pinned here, not when
  // the loop emits, because the operator may rewrite the file
  // between assembly and session start — pinning at assembly
  // matches the spec semantic: "the bytes that landed in the
  // model's window at boot".
  //
  // Empty when no memories rendered (matches `entryCount: 0`).
  eagerLoaded: readonly EagerExposure[];
}

export const assembleMemorySection = (
  input: AssembleMemorySectionInput,
): AssembleMemorySectionResult => {
  // Order matters: filter trust BEFORE dedupe. Spec §7.2.2 marks
  // trust per-MEMORY (not per-name), so an untrusted entry in
  // `project_local` should NOT eclipse a trusted entry of the
  // same name in `user`. Reversing the order (dedupe first) would
  // keep the most-specific scope, drop it as untrusted, and
  // silently lose the trusted shadow — wrong per spec.
  //
  // The non-deduped list comes back in precedence order
  // (project_local → project_shared → user), so filtering then
  // deduping by name keeps the first SURVIVING scope per name —
  // which is the most-specific TRUSTED scope. That matches the
  // user's intent: "promote the trusted shadow to active when the
  // more-specific scope is marked untrusted".
  const header = input.leanHeader === true ? MEMORY_SECTION_HEADER_LEAN : MEMORY_SECTION_HEADER;
  const all = input.registry.list();
  if (all.length === 0) {
    // Header-only render. The save-criteria + 4-type semantics +
    // "DO NOT save" list are load-bearing on FRESH sessions —
    // exactly the moment the model is most likely to propose a
    // bad inferred save (no precedent to look at, no operator
    // shadow to imitate). Pre-fix, the early-return shipped an
    // empty string and the model saw only the tool description's
    // one-line summary; the full taxonomy + anti-list lived
    // behind an "only when at least one memory exists" gate that
    // inverted the need (more memories = more orientation; zero
    // memories = no orientation). +~250 prompt tokens accepted as
    // the cost of consistent save guidance across all sessions.
    return { text: header, entryCount: 0, eagerLoaded: [] };
  }
  // Scope-level fail-closed exclusion (S5 P0/H2-rob). Applied BEFORE
  // the per-memory peek so an unreadable scope doesn't cost N extra
  // disk reads just to drop every memory in it.
  const excludeScopes =
    input.excludeScopes !== undefined && input.excludeScopes.length > 0
      ? new Set(input.excludeScopes)
      : null;
  const bootContext = input.bootContext ?? EMPTY_BOOT_CONTEXT;
  // Combined per-memory filter: spec §7.2.2 trust + spec §4.3
  // boot-time triggers. Single peek per memory delivers both
  // pieces of state (frontmatter.trust + frontmatter.triggers),
  // saving disk reads vs filtering in two passes. See module
  // header for failure-mode rationale (uncertain peek → include).
  //
  // The peek's MemoryFile is carried alongside the listing so the
  // dedupe/render loop can derive eager-exposure metadata without
  // a second peek. `null` when peek returned anything other than
  // `present` (matches the "uncertainty → include" branch).
  const eligible: Array<{ listing: (typeof all)[number]; file: MemoryFile | null }> = [];
  for (const l of all) {
    // Hard scope exclusion fires first. When the shared-corpus
    // trust probe returned verify_failed, this branch drops every
    // project_shared listing — even the "uncertain peek → include"
    // path that normally serves resilience would be wrong here
    // (we don't know what's in the file system, so we must NOT
    // surface ANYTHING from that scope to the model).
    if (excludeScopes?.has(l.scope)) continue;
    // Pass the full listing identity (scope + subdir) so a seed
    // listing whose name collides with a user-top entry resolves
    // to the seed body, not the shadowing top-level file. Without
    // this, the trust / state / trigger filters below would drop
    // both the shadow AND the seed, even when the seed itself
    // satisfies the eager-load contract — defeating the filter-
    // before-dedupe behavior the prompt assembly depends on.
    const peek = input.registry.peek(l.name, listingScopeOption(l));
    if (peek.kind !== 'present') {
      eligible.push({ listing: l, file: null }); // uncertainty → include
      continue;
    }
    if (peek.file.frontmatter.trust === 'untrusted') continue;
    // State-based filter for non-retrievable lifecycle states
    // (MEMORY.md §6): `invalidated` is "invariant broken" — kept on
    // disk for audit but explicitly NOT eligible for retrieval or
    // eager-load. Bulk-applied by the S5 `trust_revoked` detector
    // (every active shared memory transitions to invalidated when
    // operator revokes the shared corpus' trust). Without this
    // skip, the system prompt would continue including those
    // memories until the session restarted, defeating the
    // revocation. `shadow` is similarly non-retrievable per spec
    // but the shadow detector hasn't shipped — when it does, this
    // is the call site to extend. `quarantined` deliberately stays
    // eligible (visible with `[memory: quarantined]` flag per S6).
    if (peek.file.frontmatter.state === 'invalidated') continue;
    if (!shouldEagerLoadByTriggers(peek.file.frontmatter.triggers, bootContext)) continue;
    // Per-playbook memory filter (slice 9). When the playbook's
    // context_recipe.memory_filter is set, keep only entries
    // whose `type` matches any filter value OR whose triggers
    // intersect with one. Absent / empty filter is a no-op.
    if (input.memoryFilter !== undefined && input.memoryFilter.length > 0) {
      const ftype = peek.file.frontmatter.type;
      const fTriggers = peek.file.frontmatter.triggers ?? [];
      const matches = input.memoryFilter.some((f) => f === ftype || fTriggers.includes(f));
      if (!matches) continue;
    }
    eligible.push({ listing: l, file: peek.file });
  }
  if (eligible.length === 0) {
    // Every memory was filtered out (trust / triggers / state /
    // playbook filter dropped everything). Still emit the header
    // so save guidance is present — same rationale as the
    // registry-empty branch above. The eagerLoaded inventory
    // stays empty because no entries actually shipped.
    return { text: header, entryCount: 0, eagerLoaded: [] };
  }
  // Dedupe by name on the eligible list. precedence order is
  // preserved (most-specific surviving scope wins).
  //
  // Visual flag for quarantined memories (S6/T6.2, MEMORY.md §6.5.2):
  // a `[memory: quarantined]` marker appears between the scope tag
  // and the description so the model sees the state inline. Motivo
  // + date enrichment (`[memory: quarantined — conflict 2026-04-15]`
  // per spec) is deferred — same shape as T0.2's `/memory list`
  // deferral — and requires a JOIN against `eviction_events` that
  // isn't worth the wire-up complexity until operators ask for it.
  // The flag without motivo+date still delivers the load-bearing
  // signal: "model, this memory is under review; be cautious".
  const seen = new Set<string>();
  const deduped: typeof eligible = [];
  for (const e of eligible) {
    if (seen.has(e.listing.name)) continue;
    seen.add(e.listing.name);
    deduped.push(e);
  }
  // Window-relative cap (CONTEXT_TUNING §2.2). Keep the highest-precedence
  // entries (the deduped list is already in precedence order — most-specific
  // surviving scope first), trim the tail. Applied here so the rendered lines
  // and the eagerLoaded inventory stay consistent by construction. The cap is
  // a small-window guardrail; a non-positive / undefined cap means no trim.
  const cap =
    input.maxEntries !== undefined && input.maxEntries > 0 ? input.maxEntries : deduped.length;
  const rendered = deduped.slice(0, cap);
  const dropped = deduped.length - rendered.length;
  const lines: string[] = [header, ''];
  const eagerLoaded: EagerExposure[] = [];
  for (const { listing, file } of rendered) {
    const state = file?.frontmatter.state;
    const stateFlag = state === 'quarantined' ? ' [memory: quarantined]' : '';
    // Spec §5.7.3: "UI mostrar `[seed]` discreto na lista —
    // transparência." The model should know which entries come
    // from the vendor catalog vs operator-authored memories so it
    // can weight their authority appropriately. The marker is
    // visible per-listing without changing the scope tag (the
    // body still lives in user scope per slice-7 design).
    const seedFlag = listing.subdir === 'seeds' ? ' [seed]' : '';
    // name + hook are author-controlled (a shared-corpus memory a teammate
    // wrote, trusted coarsely at the corpus modal) and render into the eager
    // prompt. Sanitize the single-line markdown so a crafted hook can't smuggle
    // control bytes or — defense-in-depth past the line-structured index — a
    // newline that injects a fresh line. The system flags (seed/state) are
    // harness-generated, not sanitized.
    lines.push(
      `- [${listing.scope}] ${sanitizeForPromptLine(listing.name)}${seedFlag}${stateFlag} — ${sanitizeForPromptLine(listing.entry.hook)}`,
    );
    eagerLoaded.push(toEagerExposure(listing.scope, listing.name, file));
  }
  // No silent caps (principle: log what was dropped). The model sees the
  // elision and how to reach the trimmed memories, mirroring the project
  // guide's truncation marker.
  if (dropped > 0) {
    lines.push(
      `- … and ${dropped} more ${dropped === 1 ? 'memory' : 'memories'} trimmed to fit the context window — use memory_list / memory_search to reach them.`,
    );
  }
  return { text: lines.join('\n'), entryCount: rendered.length, eagerLoaded };
};

// Snapshot one eager-loaded entry. `file === null` happens for the
// "uncertainty → include" path (peek returned missing / malformed):
// the listing still ships in the index, but we have no body to
// hash and no frontmatter.state to snapshot. Provenance row still
// emits with NULL hash + 'active' default — the operator can
// reconcile via the audit log seeing both the index entry and the
// missing-body record.
const toEagerExposure = (
  scope: MemoryScope,
  name: string,
  file: MemoryFile | null,
): EagerExposure => {
  if (file === null) {
    return { scope, name, memoryContentHash: null, memoryStateAtExposure: 'active' };
  }
  let memoryContentHash: string | null;
  try {
    memoryContentHash = hashMemoryContent(serializeMemoryFile(file));
  } catch {
    // Best-effort: a hash failure (e.g., FIPS-restricted host)
    // must not block the eager render or the provenance emit.
    memoryContentHash = null;
  }
  return {
    scope,
    name,
    memoryContentHash,
    memoryStateAtExposure: file.frontmatter.state ?? 'active',
  };
};

// Compose the memory section onto an optional base prompt. The
// memory section is appended after the base (spec §4.1: memory
// index sits AFTER project context / AGENTS.md). When the base
// is undefined and there are memories, the section becomes the
// system prompt by itself. When the section is empty (caller
// explicitly passed ""), the existing base passes through
// unchanged — including `undefined`, preserving the "no prompt"
// semantics. Note: assembleMemorySection NEVER returns ""
// today; even a registry with zero entries renders the
// MEMORY_SECTION_HEADER so the model gets save-criteria
// guidance on fresh sessions. The empty-string branch here is
// preserved as the contract surface for programmatic callers
// that want to suppress the section explicitly.
export const composeSystemPrompt = (
  basePrompt: string | undefined,
  memorySection: string,
): string | undefined => {
  if (memorySection.length === 0) return basePrompt;
  if (basePrompt === undefined || basePrompt.length === 0) return memorySection;
  return `${basePrompt}\n\n${memorySection}`;
};
