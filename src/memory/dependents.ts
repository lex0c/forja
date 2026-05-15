// Cascading detection (EVICTION §6.4) — memory × memory.
//
// When a memory is evicted, OTHER memories that reference it by
// name may become semantically stale: a `[[orphan]]` wiki-link or a
// `[link](orphan.md)` markdown reference still resolves syntactically
// but the target is gone (now in `.tombstones/`, soon `purged`).
// Spec §6.4 says EVICTION does NOT auto-cascade — instead the
// dependents are RECORDED in `eviction_events.dependents_json` so
// the future loop frio (re-evaluation slice, not yet built) can
// process them with fresh evidence. This module owns the detection
// for the memory substrate.
//
// What this slice covers (memory × memory only):
//   - `[[memory-name]]` wiki-style references in body
//   - `[link text](memory-name.md)` markdown links to a file in the
//     same scope's directory
//
// Out of scope (declared spec dependents that need other subsystems):
//   - Policy P referencing memory M — no FEEDBACK_ADAPTATION substrate
//   - Memory M citing CODE_INDEX symbol S — no code index
//   - Slot item I derived from memory M — no context engine
//
// Cross-scope detection: a memory in `user` referencing
// `[[project_local_mem]]` IS detected because matching is by name.
// Operators who scope-shadow a name intentionally accept this:
// the dependent reference might point at the user-scope version
// or the project-scope version; the detector flags both.

import type { MemoryRegistry } from './registry.ts';
import type { MemoryScope } from './types.ts';

export interface MemoryDependent {
  // Scope of the dependent (the memory whose body references the
  // evicted one).
  scope: MemoryScope;
  // Name of the dependent.
  name: string;
  // How the dependency was detected — useful for forensic
  // queries ("which dependents came via wiki vs md link?").
  refKind: 'wiki' | 'md_link';
}

// Match `[[name]]` — wiki-style cross-reference. Name capture
// follows the same lowercase + digits + hyphen + underscore
// vocabulary memory names use. Anchored to non-bracket characters
// inside the wiki brackets so `[[a]][[b]]` correctly extracts both.
const WIKI_LINK_RE = /\[\[([a-z0-9][a-z0-9_-]*)\]\]/g;

// Match `[any link text](memory-name.md)` — markdown link to a
// memory file. The capture is the name without the `.md` extension
// so it matches the wiki capture's vocabulary. Excluding fully-
// qualified paths (`./foo.md`, `/abs/path.md`, `http://...`) keeps
// the matcher focused on intra-scope refs the operator most likely
// intends as memory dependencies.
const MD_LINK_RE = /\]\(([a-z0-9][a-z0-9_-]*)\.md\)/g;

// Walk the body for references to `targetName`. Returns the kinds
// detected (each reference contributes a refKind). A body that
// references the target via BOTH `[[target]]` and `[link](target.md)`
// yields two refKinds — caller decides whether to dedupe.
const collectRefsToTarget = (body: string, targetName: string): ('wiki' | 'md_link')[] => {
  const kinds: ('wiki' | 'md_link')[] = [];
  for (const match of body.matchAll(WIKI_LINK_RE)) {
    if (match[1] === targetName) kinds.push('wiki');
  }
  for (const match of body.matchAll(MD_LINK_RE)) {
    if (match[1] === targetName) kinds.push('md_link');
  }
  return kinds;
};

// Detect every memory in the registry whose body references
// `evictedName`. Excludes the evicted memory itself (a body that
// references its own name shouldn't appear in its own dependents
// list). Same name across scopes is reported separately — the
// caller (transitionMemoryState) ships the full list so each
// dependent gets its own decision in the future loop frio.
//
// Returns deduplicated by (scope, name): a body referencing the
// target via both wiki and md_link gets ONE entry with refKind
// reflecting the first detected reference (wiki takes precedence
// alphabetically, but for the spec contract a single entry per
// dependent is enough — the refKind is informational).
export const detectMemoryDependents = (
  registry: MemoryRegistry,
  evictedScope: MemoryScope,
  evictedName: string,
): MemoryDependent[] => {
  const seen = new Set<string>(); // `scope/name` keys for dedupe
  const dependents: MemoryDependent[] = [];

  for (const listing of registry.list()) {
    // Skip the evicted memory itself.
    if (listing.scope === evictedScope && listing.name === evictedName) continue;

    // Use peek (no audit row emitted; this is a system-internal
    // scan). A malformed / missing body silently contributes no
    // dependents — the operator-side fix is independent of
    // eviction.
    const peek = registry.peek(listing.name, { scope: listing.scope });
    if (peek.kind !== 'present') continue;

    const refs = collectRefsToTarget(peek.file.body, evictedName);
    if (refs.length === 0) continue;

    const key = `${listing.scope}/${listing.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Wiki refs take precedence over md_link when both exist —
    // alphabetical, deterministic, the choice doesn't carry
    // semantic weight (the spec doesn't care which kind ranked
    // first; the forensic surface is "this memory referenced the
    // evicted one").
    const refKind = refs.includes('wiki') ? 'wiki' : 'md_link';
    dependents.push({ scope: listing.scope, name: listing.name, refKind });
  }

  return dependents;
};
