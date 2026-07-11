// Shared path-arg resolution for the single-path FS tools (read_file,
// write_file, edit_file).
//
// The permission engine extracts the gated path with `file_path > path`
// precedence (`engine.ts:filePathOf`, `resolvers/fs.ts:filePathOf`), and
// the hook dispatcher matches on `file_path || path`
// (`hooks/dispatcher-matching.ts`). The tool handlers, however, read only
// `args.path` directly. That divergence is a confused-deputy hazard of the
// same class as `_bash-cwd.ts`: the engine classifies one field while the
// tool touches another.
//
// Two concrete failures it caused before this helper:
//   1. `{file_path:'A', path:'B'}` (B a secret) — engine gated A, tool read
//      B. The resolver now REFUSES conflicting values (resolvers/fs.ts), so
//      this shape never reaches the tool; this helper is the matching tool-
//      side contract so the two layers read the same field.
//   2. `{file_path:'A'}` (no `path`) — engine gated A, tool did
//      `isAbsolute(undefined)` → `TypeError: ERR_INVALID_ARG_TYPE`, an
//      opaque internal-error crash instead of reading A.
//
// Resolving here with the SAME precedence the engine uses guarantees the
// tool acts on exactly the path the engine authorized. Returns null when
// neither field is a non-empty string so the caller emits a clean
// invalid-arg error rather than crashing.

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const pathArgOf = (args: { file_path?: unknown; path?: unknown }): string | null => {
  if (isNonEmptyString(args.file_path)) return args.file_path;
  if (isNonEmptyString(args.path)) return args.path;
  return null;
};
