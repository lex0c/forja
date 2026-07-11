import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { parseSkillFile, SkillFrontmatterError } from './frontmatter.ts';
import type { SkillScopeRoots } from './paths.ts';
import { rootForScope, ScopeError, skillFilePath } from './paths.ts';
import type { SkillFile, SkillScope } from './types.ts';

// Disk-side loader for the skills subsystem (spec SKILLS.md §4.1).
//
// Skills have NO index file — unlike the memory subsystem's
// MEMORY.md. Discovery is a glob of `*.md` in each scope directory
// (§4.1): `listSkillNames` enumerates, `readSkillByName` parses one
// file, `scanScope` does both. The catalog layer composes the
// scopes with precedence.
//
// The loader is stateless and does NOT cache — the catalog holds
// the snapshot and owns invalidation. Skill bodies are short and
// few; a disk re-read per `read` is irrelevant and avoids stale-
// cache bugs after an operator hand-edit.

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Pre-read regular-file check. Refuses symlinks BEFORE readFileSync:
// a skill body is injected into the model's context on invocation
// (§4.2), so a symlinked skill file pointing out of scope
// (`~/.ssh/id_rsa`, any host file the agent's UID can read) would
// exfiltrate that file's bytes into the prompt under the guise of a
// skill. Non-regular files (a directory named `foo.md/`, a fifo, a
// socket, a device node) are refused too — `readFileSync` would
// return junk or block indefinitely. Mirrors the memory loader's
// `checkRegularFile`.
type RegularFileCheck =
  | { kind: 'ok' }
  | { kind: 'not_found' }
  | { kind: 'symlink' }
  | { kind: 'non_regular' };

const checkRegularFile = (path: string): RegularFileCheck => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if (isEnoent(err)) return { kind: 'not_found' };
    throw err;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink' };
  if (!stat.isFile()) return { kind: 'non_regular' };
  return { kind: 'ok' };
};

const SYMLINK_REFUSE_MESSAGE =
  'skill file is a symlink — refused by security policy ' +
  '(a skill body is injected into the model context; a symlink could ' +
  'point out of scope — materialize a real file at this path)';

const NON_REGULAR_REFUSE_MESSAGE =
  'skill file is not a regular file (got directory, fifo, socket, or device node)';

export type SkillFileResult =
  | { kind: 'present'; file: SkillFile }
  | { kind: 'missing' }
  | { kind: 'malformed'; error: string };

// Read one skill file by `name` in `scope`. A scope with no root
// (the user scope on a homeless env) yields `missing` — that scope
// simply holds no files. Otherwise the name is resolved through
// `skillFilePath`, which validates it and applies the sandbox
// check — callers may pass model-supplied or directory-listed
// names without re-validating: an invalid name (non-kebab-case, a
// path-traversal attempt) surfaces as `malformed`, not a throw.
export const readSkillByName = (
  roots: SkillScopeRoots,
  scope: SkillScope,
  name: string,
): SkillFileResult => {
  if (rootForScope(roots, scope) === null) return { kind: 'missing' };
  let path: string;
  try {
    path = skillFilePath(roots, scope, name);
  } catch (err) {
    // `skillFilePath` throws for a name that is not a valid skill
    // identifier — a non-kebab-case `.md` filename found on disk,
    // or a model-supplied traversal name. Surface it as `malformed`
    // rather than letting the throw escape: `scanScope` reads every
    // filename a directory listing yields, so a stray `Bad Name.md`
    // must not crash the whole catalog scan.
    if (err instanceof SkillFrontmatterError || err instanceof ScopeError) {
      return { kind: 'malformed', error: err.message };
    }
    throw err;
  }
  const fileCheck = checkRegularFile(path);
  if (fileCheck.kind === 'not_found') return { kind: 'missing' };
  if (fileCheck.kind === 'symlink') return { kind: 'malformed', error: SYMLINK_REFUSE_MESSAGE };
  if (fileCheck.kind === 'non_regular') {
    return { kind: 'malformed', error: NON_REGULAR_REFUSE_MESSAGE };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    // checkRegularFile already absorbed ENOENT; a remaining throw
    // is a real fs error (EACCES, EIO) — surface it unchanged.
    if (isEnoent(err)) return { kind: 'missing' };
    throw err;
  }
  try {
    return { kind: 'present', file: parseSkillFile(raw) };
  } catch (err) {
    if (err instanceof SkillFrontmatterError) {
      return { kind: 'malformed', error: err.message };
    }
    throw err;
  }
};

// Enumerate skill `name`s present in a scope directory. Top-level
// `*.md` only — the spec layout is flat; a `.md` in a subdirectory
// is operator confusion or an attack and is simply not listed. The
// `.md` suffix match is case-sensitive: an `.MD` file is
// intentionally not treated as a skill (canonical skill files are
// lowercase). Dotfiles are excluded (the name validator forbids a
// leading dot, so a `.foo.md` could never be a valid skill). Both a
// missing scope directory AND a null scope root (the user scope on
// a homeless env) are the "no skills here" state, not an error —
// returns []. Sorted for deterministic catalog ordering across runs.
export const listSkillNames = (roots: SkillScopeRoots, scope: SkillScope): string[] => {
  const dir = rootForScope(roots, scope);
  if (dir === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry.startsWith('.')) continue;
    names.push(entry.slice(0, -'.md'.length));
  }
  names.sort();
  return names;
};

// A skill seen by `scanScope`: it was listed by `listSkillNames`,
// so it exists on disk — the result is `present` or `malformed`,
// never `missing` (a missing file can only come from a name that
// `listSkillNames` did not enumerate). A symlinked or non-regular
// `*.md` surfaces here as `malformed` rather than silently
// vanishing, so the catalog can emit a `filtered` audit row for it.
export type ScannedSkill =
  | { name: string; kind: 'present'; file: SkillFile }
  | { name: string; kind: 'malformed'; error: string };

// List + read every skill in a scope. The unit the catalog builds
// its per-scope snapshot from.
export const scanScope = (roots: SkillScopeRoots, scope: SkillScope): ScannedSkill[] => {
  const out: ScannedSkill[] = [];
  for (const name of listSkillNames(roots, scope)) {
    const result = readSkillByName(roots, scope, name);
    if (result.kind === 'present') {
      out.push({ name, kind: 'present', file: result.file });
    } else if (result.kind === 'malformed') {
      out.push({ name, kind: 'malformed', error: result.error });
    }
    // `missing` is the one outcome scanScope does not surface: it
    // means the file `listSkillNames` just enumerated was deleted
    // before `readSkillByName` opened it (a TOCTOU race) — the
    // skill is genuinely gone, so there is no present-or-broken
    // entry to report. `malformed` (a file that exists but won't
    // parse) IS surfaced above, so the catalog still sees every
    // file actually on disk.
  }
  return out;
};
