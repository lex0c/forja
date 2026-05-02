// Shared types for the memory subsystem (spec MEMORY.md).
//
// Step 5.1 lands the storage primitives: types, frontmatter
// parser/writer, scope/path resolver, MEMORY.md index handling,
// memory_events audit table, and the auto-generated
// .agent/.gitignore. Tools (memory_read/write/list/search), TUI
// confirmation, trust integration, promote/demote, and lifecycle
// arrive in later slices (5.2–5.6). This file holds the type
// vocabulary the rest of the slice (and future slices) builds on.

// The four memory categories defined in spec §1. Validation gates
// reject anything else — categorising memory is the first defense
// against "every interesting thing becomes a memory" rot.
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

// Provenance of a memory entry per spec §5.2. `user_explicit`
// means the human asked for it; `inferred` means the model
// proposed it (highest injection-risk path, requires confirmation
// + extra mitigations in 5.4); `imported` means it came from an
// export of another tool or scope (e.g. promoted from local to
// shared).
export type MemorySource = 'user_explicit' | 'inferred' | 'imported';

// Trust marker on a memory file. Default `trusted` when the
// frontmatter omits the field — i.e. the memory was created in a
// trusted cwd. `untrusted` means the memory was accepted in a
// non-trusted directory (spec §7.2 mitigation 2): such memories
// do NOT enter the base context, only on demand via memory_read.
// 5.4 enforces the read-side contract; 5.1 only models the field
// so the parser/writer round-trip honors operator edits.
export type MemoryTrust = 'trusted' | 'untrusted';

// Three concrete scopes (spec §2). User scope is global per
// machine; project scope is split into shared (committed,
// team-wide) and local (gitignored, per-user). Reference is a
// `MemoryType`, not a scope — it can live in any of the three.
export type MemoryScope = 'user' | 'project_shared' | 'project_local';

// Parsed frontmatter block. All optional fields preserve their
// absence on round-trip — `trust` omitted on input means `trust`
// omitted on output, NOT a serialized `trust: trusted`. The
// caller treats absence as 'trusted' at decision time.
export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  source: MemorySource;
  // ISO date YYYY-MM-DD when the memory should be cleaned up by
  // the lifecycle pass (5.6). Optional; project-scope inferred
  // memories without an explicit value get a default +90d in 5.6.
  expires?: string;
  // Default `trusted` when absent. See MemoryTrust above.
  trust?: MemoryTrust;
  // Optional auto-injection tags (spec §4.3). 5.1 just preserves
  // these on round-trip; the eager-injection logic lives in 5.2.
  triggers?: string[];
}

// A single memory file: frontmatter + raw markdown body. The
// body is whatever follows the closing `---` delimiter, with one
// leading blank line stripped (the canonical writer always emits
// a single blank between frontmatter and body, so the parser
// undoes it on read for clean round-trips).
export interface MemoryFile {
  frontmatter: MemoryFrontmatter;
  body: string;
}

// One entry in the per-scope MEMORY.md index. The shape is
// trivial — title (display text inside `[...]`), href (filename
// inside `(...)`, always relative to the scope root), and hook
// (the trailing description after the em dash).
export interface IndexEntry {
  title: string;
  href: string;
  hook: string;
}
