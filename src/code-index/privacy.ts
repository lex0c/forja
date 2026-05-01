// Default exclude patterns for the code-index scanner
// (CODE_INDEX.md §8.1). Operator config can EXTEND this list but
// not shrink it — the defaults guard against accidental indexing
// of secrets, build artifacts, and dependency dirs that bloat the
// index without semantic value.
//
// Overlap with `subagents/sensitive-paths.ts` is intentional: the
// worktree validator's deny-list and the index exclude list both
// derive from the same threat model (don't expose credentials to
// the model). Keeping them in separate modules avoids coupling —
// the worktree validator's removal semantics and the indexer's
// skip semantics are different concerns even when the patterns
// overlap.
//
// Patterns are glob-style, evaluated by the future scanner via
// Bun.Glob (no regex per CLAUDE.md's hard rule). The slice that
// adds the actual scanner (4.3.1) wires the matcher.
export const CODE_INDEX_DEFAULT_EXCLUDES: readonly string[] = [
  // Dependency / vendor trees — large, third-party, indexed at
  // upstream's whim, not the operator's.
  'node_modules/**',
  '.venv/**',
  'venv/**',
  '__pycache__/**',
  'vendor/**',
  // Build artifacts — generated, not source-of-truth. Indexing
  // these wastes tokens and surfaces stale references.
  'dist/**',
  'build/**',
  'target/**',
  'out/**',
  '.next/**',
  // VCS internals — not source code.
  '.git/**',
  '.hg/**',
  '.svn/**',
  // Credential conventions — same surface as
  // SECURITY_GUIDELINE.md §8.4.
  '.env',
  '.env.*',
  '.envrc',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/secrets/**',
  '**/credentials/**',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
];

// Files larger than this size are skipped regardless of pattern.
// Justification: tree-sitter parse cost is roughly linear in file
// size; 5 MB is well past anything an operator would reasonably
// edit by hand. Larger files (generated SQL dumps, embedded
// binaries-as-text) consume parser budget without semantic value.
// Configurable per-project via `[code_index] max_file_size_mb`
// (slice 4.3.1+).
export const CODE_INDEX_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
