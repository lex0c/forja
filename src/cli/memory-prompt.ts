import type { MemoryRegistry } from '../memory/index.ts';

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
// `trust: untrusted` MUST NOT enter the base context. 5.2.c
// does NOT load bodies during section assembly (eager-index
// principle), so we can't read frontmatter to check trust per
// entry. 5.4 lands the trust integration with index-side trust
// markers OR a body preload pass; until then no production path
// writes `trust: untrusted` (only the writer in 5.4 does), so
// the gate is effectively a no-op now. Documented as a known
// limitation in the BACKLOG entry.

const MEMORY_SECTION_HEADER = `# Memory

Cross-session memories you can use. Call memory_read(name) to load a body, memory_list / memory_search to explore.`;

export interface AssembleMemorySectionInput {
  registry: MemoryRegistry;
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
  // Dedup so a `commit-style` shadowed across all three scopes
  // shows up once (most-specific scope only). Model gets a clean
  // view of "what's actually active for this session".
  const listings = input.registry.list({ deduplicateByName: true });
  if (listings.length === 0) {
    return { text: '', entryCount: 0 };
  }

  const lines: string[] = [MEMORY_SECTION_HEADER, ''];
  for (const l of listings) {
    lines.push(`- [${l.scope}] ${l.name} — ${l.entry.hook}`);
  }
  return { text: lines.join('\n'), entryCount: listings.length };
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
