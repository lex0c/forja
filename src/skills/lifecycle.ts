import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SkillFrontmatterError, serializeSkillFile, validateName } from './frontmatter.ts';
import { readSkillByName } from './loader.ts';
import { ScopeError, rootForScope, skillFilePath } from './paths.ts';
import type { SkillScopeRoots } from './paths.ts';
import type { SkillScope } from './types.ts';

// Skill-file lifecycle operations (spec SKILLS.md §6) — create, move
// between scopes, delete. The `/skill` slash command is the operator
// surface; these functions own the disk mutations so the file ops
// are testable without the REPL and the command stays a thin
// dispatch + presentation layer.
//
// Every op is "measure twice": it validates the name, confirms the
// scope root resolves, and probes the target BEFORE writing — and
// returns a discriminated result rather than throwing, so the caller
// renders a clean operator message for each failure.

export type SkillLifecycleError =
  | 'invalid_name'
  | 'scope_unavailable'
  | 'not_found'
  | 'already_exists'
  | 'malformed'
  | 'io_error';

// Outcome of a completed lifecycle op: `path` is the file written /
// moved-to / removed.
export type SkillLifecycleResult =
  | { ok: true; path: string }
  | { ok: false; reason: SkillLifecycleError; message: string };

// Outcome of `resolvePath` — distinct from SkillLifecycleResult so
// the two `ok: true` meanings don't blur: here it means only "the
// name is valid and the path resolved", NOT "the operation ran".
type ResolvedPath =
  | { ok: true; path: string }
  | { ok: false; reason: SkillLifecycleError; message: string };

// Validate `name` and resolve `<scope>/<name>.md`. The failure arm is
// already a SkillLifecycleResult-shaped error the caller returns
// verbatim. A null scope root (user scope on a host with no
// resolvable config dir) and a traversal-shaped name both surface
// here, before any disk write.
//
// `allowAnyName` skips the kebab-case `validateName` gate — for
// `deleteSkill`, which removes a file ALREADY on disk whose filename
// may not be kebab (`Bad Name.md`, `Upper.md`). The path sandbox in
// `skillFilePath` still runs, so a traversal name is still refused.
const resolvePath = (
  roots: SkillScopeRoots,
  scope: SkillScope,
  name: string,
  allowAnyName = false,
): ResolvedPath => {
  if (!allowAnyName) {
    try {
      validateName(name);
    } catch (err) {
      if (err instanceof SkillFrontmatterError) {
        return { ok: false, reason: 'invalid_name', message: err.message };
      }
      throw err;
    }
  }
  if (rootForScope(roots, scope) === null) {
    return {
      ok: false,
      reason: 'scope_unavailable',
      message: `scope '${scope}' has no resolvable root on this host`,
    };
  }
  try {
    return { ok: true, path: skillFilePath(roots, scope, name, { allowAnyName }) };
  } catch (err) {
    // The null-root case already returned above, so a ScopeError
    // here is `skillFilePath` rejecting the NAME — an escape or an
    // unsafe component — not the scope being unavailable.
    if (err instanceof ScopeError || err instanceof SkillFrontmatterError) {
      return { ok: false, reason: 'invalid_name', message: err.message };
    }
    throw err;
  }
};

// Template for `/skill new` — valid frontmatter (so the catalog
// admits the skill the moment the file lands) with placeholder
// description + body the operator fills in.
const skillTemplate = (name: string): string =>
  serializeSkillFile({
    frontmatter: {
      name,
      description: 'TODO: one line — when should the agent reach for this skill?',
      created_at: new Date().toISOString().slice(0, 10),
    },
    body: 'TODO: the procedure. Describe the steps to follow when this skill is invoked.\n',
  });

// Scaffold a new skill file (spec §6.1). Refuses to overwrite an
// existing skill — `/skill new` is create-only; editing is the
// operator's editor, moving is `moveSkill`.
export const createSkill = (
  roots: SkillScopeRoots,
  scope: SkillScope,
  name: string,
): SkillLifecycleResult => {
  const resolved = resolvePath(roots, scope, name);
  if (!resolved.ok) return resolved;
  if (existsSync(resolved.path)) {
    return {
      ok: false,
      reason: 'already_exists',
      message: `a skill named '${name}' already exists in scope '${scope}'`,
    };
  }
  try {
    mkdirSync(dirname(resolved.path), { recursive: true });
    writeFileSync(resolved.path, skillTemplate(name), 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: 'io_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, path: resolved.path };
};

// Move a skill between scopes (spec §6.3 promote / demote). Validates
// the source is a present, well-formed skill — a move must not
// propagate a malformed file or follow a symlink — and refuses to
// clobber a same-name skill in the target scope. Copy-then-delete,
// not rename: the project and user scopes can sit on different
// filesystems, where `rename` fails with EXDEV.
//
// Unlike `deleteSkill`, the source goes through `resolvePath` WITHOUT
// `allowAnyName`: a non-kebab name is rejected (`invalid_name`). You
// clean up a broken file but only move a well-formed one, and the
// destination must itself be a valid skill id.
export const moveSkill = (
  roots: SkillScopeRoots,
  name: string,
  from: SkillScope,
  to: SkillScope,
): SkillLifecycleResult => {
  const source = resolvePath(roots, from, name);
  if (!source.ok) return source;
  const target = resolvePath(roots, to, name);
  if (!target.ok) return target;

  const read = readSkillByName(roots, from, name);
  if (read.kind === 'missing') {
    return { ok: false, reason: 'not_found', message: `no skill '${name}' in scope '${from}'` };
  }
  if (read.kind === 'malformed') {
    return {
      ok: false,
      reason: 'malformed',
      message: `skill '${name}' in scope '${from}' is malformed (${read.error}) — fix it before moving`,
    };
  }
  if (existsSync(target.path)) {
    return {
      ok: false,
      reason: 'already_exists',
      message: `scope '${to}' already has a skill named '${name}'`,
    };
  }
  // Raw re-read, not a re-serialize of the parsed source: a move
  // copies the operator's file verbatim — re-serializing would
  // re-canonicalize field order and whitespace.
  let raw: string;
  try {
    raw = readFileSync(source.path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: 'io_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // Copy-then-delete. Any failure past the destination write may
  // leave the target file on disk — roll it back so a failed move
  // leaves no skill file behind. (The `already_exists` check above
  // and this write are not atomic; in the single-process REPL
  // nothing runs between them, and a concurrent external writer is
  // out of scope — the same assumption the loader's scan makes.)
  try {
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, raw, 'utf8');
    rmSync(source.path);
  } catch (err) {
    // Best-effort rollback. If it fails AND the source survived, the
    // skill now sits in both scopes — the silent shadowing this
    // rollback exists to prevent — so the message must say so, or a
    // blind retry walks into `already_exists`.
    try {
      rmSync(target.path, { force: true });
    } catch {
      // swallowed — the existsSync probe below reports the outcome
    }
    const base = err instanceof Error ? err.message : String(err);
    const stranded = existsSync(target.path) && existsSync(source.path);
    return {
      ok: false,
      reason: 'io_error',
      message: stranded
        ? `${base} — could not roll back the copy at ${target.path}; '${name}' now exists in both '${from}' and '${to}', remove one manually`
        : base,
    };
  }
  return { ok: true, path: target.path };
};

// Delete a skill file (spec §6.5). A malformed file IS deletable —
// removing a broken skill is what the operator wants — so this
// checks only that the file exists, not that it parses, and resolves
// the path with `allowAnyName`: a file whose FILENAME is itself
// malformed (`Bad Name.md`, `Upper.md`) is surfaced by `/skill list`
// as a cleanup target, so delete must reach it. The path sandbox
// still holds — a traversal name is refused.
export const deleteSkill = (
  roots: SkillScopeRoots,
  scope: SkillScope,
  name: string,
): SkillLifecycleResult => {
  const resolved = resolvePath(roots, scope, name, true);
  if (!resolved.ok) return resolved;
  if (!existsSync(resolved.path)) {
    return { ok: false, reason: 'not_found', message: `no skill '${name}' in scope '${scope}'` };
  }
  try {
    rmSync(resolved.path);
  } catch (err) {
    return {
      ok: false,
      reason: 'io_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, path: resolved.path };
};
