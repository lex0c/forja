import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from './atomic.ts';
import { FrontmatterError, serializeMemoryFile, validateFrontmatter } from './frontmatter.ts';
import {
  INDEX_HEADER,
  IndexError,
  type ParsedIndex,
  parseIndex,
  serializeIndex,
  upsertIndexEntry,
} from './index-file.ts';
import { ScopeError, indexFilePath, memoryFilePath } from './paths.ts';
import type { ScopeRoots } from './paths.ts';
import type { IndexEntry, MemoryFile, MemoryFrontmatter, MemoryScope } from './types.ts';

// Disk-side writer for the memory subsystem (spec MEMORY.md §5.1, §5.3).
//
// Two file mutations per call: the body (`<scope>/<name>.md`) and the
// per-scope index (`<scope>/MEMORY.md`). Both go through validated
// paths via `memoryFilePath` / `indexFilePath`, which re-apply the
// sandbox (spec §7.2 mitigation 6) regardless of how the caller
// constructed the inputs.
//
// Failure modes are returned as a discriminated union, NOT thrown.
// The registry/tool layer maps each variant to an audit row +
// model-facing error; throwing would force every caller to wrap
// the same try/catch and lose the kind discriminator. The single
// exception is `validateFrontmatter` — frontmatter shape errors
// are caller bugs, not runtime conditions, so they propagate.
//
// Atomicity: the body is written to a sibling temp file and
// renamed onto the final path. The index is written via
// `writeFileSync` to a temp + rename sequence too. A crash between
// the body rename and the index update leaves an orphan body
// (visible to `listOrphanFiles`) and no index entry — the
// loader's three-outcome contract (present/missing/malformed)
// already handles this by surfacing the orphan to the operator.
// We do NOT attempt rollback of the body write on index failure;
// rollback would itself fail in the same crash window. Audit
// drift is the operator's recovery path.
//
// Concurrency: this writer is process-local. Two REPLs writing to
// the same scope concurrently CAN corrupt MEMORY.md (read-modify-
// write race). The 5.6 audit slice will add a flock-based guard
// when the operator pattern actually surfaces it; today, the
// "no auto-commit" policy means the operator confirms each write
// interactively, making concurrent writes from the same machine
// vanishingly unlikely. The cross-process write race is documented
// here so the audit slice has the rationale for adding flock.

export type WriteMemoryResult =
  | {
      kind: 'created';
      path: string;
      href: string;
      // Non-fatal warnings collected during the write. Currently
      // populated only for malformed index lines: `parseIndex`
      // silently drops lines that don't match the canonical
      // `- [Title](href.md) — hook` shape, which means the
      // re-serialized MEMORY.md loses operator hand-edits in
      // non-canonical shape. We surface the dropped line numbers
      // so the caller (registry → tool → audit) can warn the
      // operator via stderr; the alternative is silent data loss.
      // Empty array when no warnings were collected.
      warnings: WriteWarning[];
    }
  | { kind: 'exists'; scope: MemoryScope; path: string }
  | { kind: 'shared_forbidden' }
  | { kind: 'sandbox_violation'; reason: string }
  | { kind: 'symlink_refused'; path: string }
  | { kind: 'index_full'; current: number; cap: number }
  | { kind: 'io_error'; reason: string };

export interface WriteWarning {
  kind: 'malformed_index_lines';
  // 1-based line numbers in the source MEMORY.md that didn't
  // match the canonical entry shape and got dropped on re-serialize.
  lines: number[];
}

export interface WriteMemoryInput {
  roots: ScopeRoots;
  // Promotion (`project_local` → `project_shared`) is a separate
  // explicit act per spec §5.1.3 / §5.4. Direct writes to
  // `project_shared` are rejected with `shared_forbidden` so an
  // accidental tool argument can't bypass the promotion review
  // gate.
  scope: MemoryScope;
  frontmatter: MemoryFrontmatter;
  body: string;
  // Optional overrides for the MEMORY.md index entry. When absent,
  // `title` defaults to the frontmatter name (kebab → human is the
  // operator's job; we don't infer) and `hook` defaults to the
  // frontmatter description. These match the canonical shape
  // produced by index-file.ts's serializer.
  indexTitle?: string;
  indexHook?: string;
}

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Read MEMORY.md if present; return an empty index when absent or
// malformed. Malformed indexes are NOT fatal at write time — the
// alternative is refusing to write any new memory until the
// operator hand-fixes the index, which surprises the operator at
// the worst moment (model just proposed a useful memory). We log
// the malformed line count to the result via the caller, not
// here; the writer's contract is "best-effort upsert".
const loadOrEmptyIndex = (path: string): ParsedIndex => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return { entries: [], malformedLines: [] };
    throw err;
  }
  return parseIndex(raw);
};

// Refuse to follow a symlink at the target path. The sandbox check
// in `memoryFilePath` only validates path SHAPE, not the inode it
// resolves to — an attacker who can drop a symlink at
// `~/.config/agent/memory/<name>.md` pointing at `/etc/passwd`
// could otherwise have us "create" that name and silently overwrite
// the linked file (same defense the worktree validator runs in
// subagents/worktree.ts). `lstatSync` does NOT follow symlinks; we
// look at the link itself. ENOENT is fine — we're about to create
// the file. Other errors propagate.
const refuseSymlinkAtPath = (path: string): WriteMemoryResult | null => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { kind: 'symlink_refused', path };
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return null;
};

// Serialize an entry for upsert. Title/hook fall back to frontmatter
// values; href is canonical (`<name>.md`) regardless of any
// operator-injected entry that might have a different href —
// spec §3.2 SECURITY CONTRACT requires the writer drift toward
// canonical hrefs on every write.
const buildIndexEntry = (input: WriteMemoryInput): IndexEntry => ({
  title: input.indexTitle ?? input.frontmatter.name,
  href: `${input.frontmatter.name}.md`,
  hook: input.indexHook ?? input.frontmatter.description,
});

export const writeMemory = (input: WriteMemoryInput): WriteMemoryResult => {
  const { roots, scope, frontmatter, body } = input;

  // Reject direct writes to project_shared (spec §5.1.3): promotion
  // is a separate act with its own scanner + confirm flow. Bypassing
  // that gate via tool-call is a documented threat vector — making
  // this an early return ensures even a future caller that forgot
  // the gate at the tool layer can't reach disk.
  if (scope === 'project_shared') {
    return { kind: 'shared_forbidden' };
  }

  // Frontmatter shape validation. Throws on shape mismatch — the
  // caller (tool layer) builds the frontmatter from validated
  // schema fields, so any throw here is a programmer bug worth
  // surfacing as an exception, not a tool error. We still wrap the
  // path-level errors below into the discriminated union because
  // those depend on caller-supplied state (scope root config,
  // operator filesystem).
  try {
    validateFrontmatter(frontmatter);
  } catch (err) {
    if (err instanceof FrontmatterError) {
      // Promote to discriminated result — calling code expects a
      // value, not a throw, for any user-reachable error class.
      return { kind: 'io_error', reason: err.message };
    }
    throw err;
  }

  // Resolve and validate the body path. `memoryFilePath` throws
  // FrontmatterError on bad name and ScopeError on path traversal;
  // both map to the discriminated union so the caller's audit row
  // can carry a clean reason string.
  let bodyPath: string;
  try {
    bodyPath = memoryFilePath(roots, scope, frontmatter.name);
  } catch (err) {
    if (err instanceof ScopeError) return { kind: 'sandbox_violation', reason: err.message };
    if (err instanceof FrontmatterError) return { kind: 'io_error', reason: err.message };
    throw err;
  }

  // Symlink defense — refuse if the target exists as a symlink.
  const symlinkResult = refuseSymlinkAtPath(bodyPath);
  if (symlinkResult !== null) return symlinkResult;

  // Existence check — the writer never overwrites. Edits / replaces
  // are a separate operation (5.5). Without this, an inferred
  // memory could silently clobber a user_explicit one of the same
  // name in the same scope; a different code path shouldn't reach
  // this writer for that case but the defense is local and cheap.
  try {
    const stat = lstatSync(bodyPath);
    if (stat.isFile()) return { kind: 'exists', scope, path: bodyPath };
    // A directory or non-file at the path is a fatal config error,
    // not a normal "exists" — surface as io_error.
    return { kind: 'io_error', reason: `non-file at memory path: ${bodyPath}` };
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'io_error', reason: msg };
    }
    // ENOENT is the happy path — file doesn't exist yet.
  }

  // Ensure the scope directory exists. mkdirSync with recursive=true
  // is idempotent on existing dirs and handles fresh installs
  // (~/.config/agent/memory/ created on first user-scope write,
  // .agent/memory/local/ on first project_local write).
  try {
    mkdirSync(dirname(bodyPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `mkdir failed: ${msg}` };
  }

  // Compute the new index BEFORE writing the body so a hard cap
  // failure (200-line MEMORY.md) doesn't leave an orphan body on
  // disk. The cap is enforced in `serializeIndex`; we catch it
  // here, return the discriminated variant, and never touch disk.
  const indexPath = indexFilePath(roots, scope);
  let parsed: ParsedIndex;
  try {
    parsed = loadOrEmptyIndex(indexPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `read index: ${msg}` };
  }

  const newEntry = buildIndexEntry(input);
  const nextEntries = upsertIndexEntry(parsed.entries, newEntry);
  let serialized: ReturnType<typeof serializeIndex>;
  try {
    serialized = serializeIndex(nextEntries, { header: INDEX_HEADER });
  } catch (err) {
    if (err instanceof IndexError) {
      // Pull the cap and current count out of the message-free
      // result so the caller's audit row carries actionable
      // detail. `serializeIndex` throws when (header + entries +
      // blank) exceeds the 200-line hard cap; the count we report
      // is `nextEntries.length` since header+blank are constants.
      return { kind: 'index_full', current: nextEntries.length, cap: 200 };
    }
    throw err;
  }

  // Materialize the body. We serialize through `serializeMemoryFile`
  // so the on-disk shape matches the parser exactly (single blank
  // between fence and body, fields in spec order). A frontmatter-
  // shape error here would be an invariant violation since we
  // validated above; promoted to io_error if it ever fires.
  let bodyText: string;
  try {
    const file: MemoryFile = { frontmatter, body };
    bodyText = serializeMemoryFile(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `serialize body: ${msg}` };
  }

  // Body first, then index. Crash between writes leaves an
  // orphan body — the loader's `listOrphanFiles` surface
  // catches that for the audit slice. Reverse order would leave
  // a dangling index entry, which the loader surfaces as
  // `kind: 'missing'` — also recoverable but uglier on the
  // operator-facing list.
  try {
    atomicWrite(bodyPath, bodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `write body: ${msg}` };
  }
  try {
    atomicWrite(indexPath, serialized.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'io_error', reason: `write index: ${msg}` };
  }

  const warnings: WriteWarning[] = [];
  if (parsed.malformedLines.length > 0) {
    warnings.push({ kind: 'malformed_index_lines', lines: parsed.malformedLines });
  }
  return { kind: 'created', path: bodyPath, href: newEntry.href, warnings };
};
