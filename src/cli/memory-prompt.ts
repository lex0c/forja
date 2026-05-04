import {
  type BootContext,
  EMPTY_BOOT_CONTEXT,
  type MemoryRegistry,
  shouldEagerLoadByTriggers,
} from '../memory/index.ts';

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

const MEMORY_SECTION_HEADER = `# Memory

Cross-session memories you can use. Call memory_read(name) to load a body, memory_list / memory_search to explore.`;

export interface AssembleMemorySectionInput {
  registry: MemoryRegistry;
  // Boot-time trigger context (spec §4.3). When omitted, the
  // empty context is used: well-known-tagged memories are
  // filtered out, untagged and operator-runtime-tagged memories
  // pass through. Callers (production: bootstrap;
  // production: subagent-child) pass the result of
  // `evaluateBootTriggers(cwd)`.
  bootContext?: BootContext;
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
  const all = input.registry.list();
  if (all.length === 0) {
    return { text: '', entryCount: 0 };
  }
  const bootContext = input.bootContext ?? EMPTY_BOOT_CONTEXT;
  // Combined per-memory filter: spec §7.2.2 trust + spec §4.3
  // boot-time triggers. Single peek per memory delivers both
  // pieces of state (frontmatter.trust + frontmatter.triggers),
  // saving disk reads vs filtering in two passes. See module
  // header for failure-mode rationale (uncertain peek → include).
  const eligible = all.filter((l) => {
    const peek = input.registry.peek(l.name, { scope: l.scope });
    if (peek.kind !== 'present') return true; // uncertainty → include
    if (peek.file.frontmatter.trust === 'untrusted') return false;
    return shouldEagerLoadByTriggers(peek.file.frontmatter.triggers, bootContext);
  });
  if (eligible.length === 0) {
    // Every memory was filtered out. Same empty-shape as a
    // registry that never had entries — bootstrap's length-zero
    // check passes through cleanly.
    return { text: '', entryCount: 0 };
  }
  // Dedupe by name on the eligible list. precedence order is
  // preserved (most-specific surviving scope wins).
  const seen = new Set<string>();
  const lines: string[] = [MEMORY_SECTION_HEADER, ''];
  let included = 0;
  for (const l of eligible) {
    if (seen.has(l.name)) continue;
    seen.add(l.name);
    lines.push(`- [${l.scope}] ${l.name} — ${l.entry.hook}`);
    included++;
  }
  return { text: lines.join('\n'), entryCount: included };
};

// Compose the memory section onto an optional base prompt. The
// memory section is appended after the base (spec §4.1: memory
// index sits AFTER project context / AGENTS.md). When the base
// is undefined and there are memories, the section becomes the
// system prompt by itself. When the section is empty, the
// existing base passes through unchanged — including `undefined`,
// which preserves the "no prompt" semantics existing tests rely
// on.
export const composeSystemPrompt = (
  basePrompt: string | undefined,
  memorySection: string,
): string | undefined => {
  if (memorySection.length === 0) return basePrompt;
  if (basePrompt === undefined || basePrompt.length === 0) return memorySection;
  return `${basePrompt}\n\n${memorySection}`;
};
