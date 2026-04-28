import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Glob } from 'bun';

// Resolve symlinks before matching. Without this, a symlink at
// `src/link → /etc/passwd` would let a `src/**` allow rule grant access
// to `/etc/passwd` because the matcher only sees the cwd-relative form.
//
// realpath fails on paths that don't exist (e.g., `write_file` creating
// a new file). For those we fall back to realpathing the parent dir +
// joining the basename — that catches the case where `src` itself is a
// symlink to `/etc/`. If even the parent doesn't exist, give up and use
// the input — there's nothing to follow.
const resolveSymlinks = (abs: string): string => {
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
};

// Path matching: every pattern and every input is normalized to a path
// relative to `cwd`, then matched with Bun.Glob. Absolute paths outside
// cwd never match cwd-relative patterns (a bare `**/foo` won't reach into
// `/etc/passwd`), which is the security property we want. Symlinks are
// resolved on the target before matching, so a symlink inside cwd that
// points outside cwd won't sneak past.
export const matchPath = (pattern: string, target: string, cwd: string): boolean => {
  const absTargetRaw = isAbsolute(target) ? target : resolve(cwd, target);
  const absTarget = resolveSymlinks(absTargetRaw);
  const absPattern = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);

  const absCwd = resolve(cwd);
  const targetRel = relativize(absCwd, absTarget);
  const patternRel = relativize(absCwd, absPattern);

  if (targetRel === null || patternRel === null) {
    // Either target or pattern is outside the cwd subtree; fall back to
    // direct absolute match (so `/etc/**` still works against /etc/...).
    return new Glob(absPattern).match(absTarget);
  }
  return new Glob(patternRel).match(targetRel);
};

const relativize = (base: string, abs: string): string | null => {
  if (abs === base) return '.';
  if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
  return null;
};

// Command and host matching can't use Bun.Glob directly because Glob's `*`
// stops at `/` (correct for paths, wrong for commands like `curl * | sh`
// where the URL contains slashes). We translate the pattern to a regex
// where `*` means "any character" and `?` means "exactly one character".
// All other regex metachars are escaped, and the result is anchored.
//
// This is an *implementation* detail — policies still author with glob
// syntax, the "no regex in policy" rule (CLAUDE.md) is preserved.
const REGEX_META = /[.+^${}()|[\]\\]/g;

const compileGlobToRegex = (pattern: string): RegExp => {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(REGEX_META, '\\$&');
  }
  // `s` (dotAll) so `.` (and therefore the `.*` we use for `*`) matches
  // newlines too. The `bash` tool accepts multi-line commands; without
  // dotAll, a pattern like `*` or `python -c *` fails to match an input
  // that contains `\n`, and policy rules silently fall through to the
  // default deny.
  return new RegExp(`^${out}$`, 's');
};

// Command matching: pattern with `*` matches any sequence of characters
// (including spaces and slashes). Patterns without `*` must match the full
// command exactly. Trailing whitespace in input is trimmed.
export const matchCommand = (pattern: string, command: string): boolean =>
  compileGlobToRegex(pattern).test(command.trim());

// Host matching for fetch URLs. Same compile semantics as commands —
// hostnames don't contain `/`, but we want consistent behavior across
// command/host matching (and `*` in `*.internal` should not be limited
// by anything other than the literal `.`).
export const matchHost = (pattern: string, host: string): boolean =>
  compileGlobToRegex(pattern.toLowerCase()).test(host.toLowerCase());

// Returns the first pattern that matches, or null. Useful for diagnostics
// (which rule fired?).
export const firstMatchingPath = (
  patterns: readonly string[] | undefined,
  target: string,
  cwd: string,
): string | null => {
  if (patterns === undefined) return null;
  for (const p of patterns) {
    if (matchPath(p, target, cwd)) return p;
  }
  return null;
};

export const firstMatchingCommand = (
  patterns: readonly string[] | undefined,
  command: string,
): string | null => {
  if (patterns === undefined) return null;
  for (const p of patterns) {
    if (matchCommand(p, command)) return p;
  }
  return null;
};

export const firstMatchingHost = (
  patterns: readonly string[] | undefined,
  host: string,
): string | null => {
  if (patterns === undefined) return null;
  for (const p of patterns) {
    if (matchHost(p, host)) return p;
  }
  return null;
};
