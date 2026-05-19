// Shared types for the memory subsystem (spec MEMORY.md).

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

// Lifecycle states per spec §3.1.1 — declared subset of EVICTION
// §3's 7-state vocabulary. Memory omits `shadow`: the trust
// field already encodes "loaded but not vinculante" semantics
// for the memory case (see §6.5 rationale and Phase 0 stitching).
// Absence of the field in frontmatter equates to `active`; the
// parser/writer round-trip preserves the field exactly as it
// appears (no canonicalization to `active` on read).
export const MEMORY_STATES = [
  'proposed',
  'active',
  'quarantined',
  'invalidated',
  'evicted',
  'purged',
] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

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
  // Optional lifecycle state per spec §3.1.1. Absence equates to
  // `active`; the parser/writer preserve absence on round-trip
  // (a memory written without `state` doesn't get a serialized
  // `state: active`). Transitions are managed via the eviction
  // contract (EVICTION.md §4); this field is the persisted
  // snapshot the next session reads.
  state?: MemoryState;
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

// Frozen snapshot of one eager-loaded memory at system-prompt
// assembly time. Produced by `assembleMemorySection`, consumed by
// the harness loop right after createSession (the first moment a
// sessionId exists to link against). Hash + state are pinned at
// assembly, not at emit, because the operator may rewrite a file
// between boot and session start — the spec semantic is "the
// bytes the model saw at boot", and that's the moment to freeze.
//
// Lives in `memory/types.ts` (not `cli/memory-prompt.ts`) so the
// harness can carry it through HarnessConfig.eagerExposures
// without dragging a `cli/`-layer dependency into the harness.
export interface EagerExposure {
  scope: MemoryScope;
  name: string;
  // SHA-256 hex of the canonical serialization at assembly time.
  // Null when hashing failed (best-effort; mirrors the schema's
  // nullable column).
  memoryContentHash: string | null;
  // frontmatter.state at assembly time; defaults to 'active' when
  // absent. The MemoryState string is stored as TEXT in the DB so
  // schema-level forward compat works without a CHECK migration.
  memoryStateAtExposure: string;
}
