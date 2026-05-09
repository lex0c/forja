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

// Detects shell metacharacters that compose multiple commands into
// one (`;`, `\n`, `\r`, `&&`, `||`, `|`, lone `&`) or embed command
// substitution (`$(...)`, backticks, `<(...)`, `>(...)`). Used by
// the bash policy check to force the confirm path on compound
// commands regardless of any allow rule: without this, a literal
// `*` in an allow pattern admits injection like `git status; rm
// -rf .` because the matcher's `*` resolves to `.*` with dotAll
// (greedy, matches across newlines), and the deny rules can't
// enumerate every shape.
//
// Newline handling matters specifically because the matcher's
// glob compiler enables `s` (dotAll) so allow patterns like
// `bash -c *` work against multi-line scripts — but that same
// dotAll lets `git status -s\nrm -rf /tmp/pwn` match against an
// allow like `git status -*`. Bash treats `\n` as a command
// terminator equivalent to `;`, so we must too. `\r` is treated
// the same way conservatively: rare in agent-emitted commands,
// but a CR-only or CRLF input shouldn't slip past the gate just
// because the OS line-ending happens to be exotic.
//
// Lone `&` is bash's async control operator — `cmd1 & cmd2` runs
// cmd1 in background and immediately starts cmd2, so structurally
// it's a compound separator just like `;`. The previous version
// only flagged `&&`, leaving `git status & rm -rf /tmp/...`
// admitted by an allow like `git status*`. We now flag any
// unquoted `&` UNLESS it appears inside a redirection context:
//   - `&&` — already covered as compound (returned earlier).
//   - `&>FILE` and `&>>FILE` — bash extension redirecting both
//     stdout+stderr. The `&` here is part of the operator, not a
//     separator.
//   - `>&N`, `<&N`, `>&-`, `2>&1`, etc. — file-descriptor
//     duplication / closure. The `&` here is part of the
//     redirection target.
// `prevIsRedirOp` tracks whether the previous unquoted char was
// `>` or `<` so we can identify the second class above. The
// `&>` lookahead handles the first.
//
// The scan respects single-quote, double-quote, and backslash-escape
// state so a literal `;` inside `git commit -m "fix; bug"` does not
// trip the detector. Newlines inside single/double quotes also
// don't trip — bash treats them as part of the string, not as
// terminators. A backslash before newline (`\\\n`) is the standard
// line-continuation; the scanner's escape rule skips the newline,
// correctly leaving the joined command undetected. Heuristic —
// does NOT model here-docs, `<<<` here-strings, `((...))`
// arithmetic substitution, or process substitution `<(...)` /
// `>(...)`. Those are rare in agent-emitted commands; if they show
// up the operator still sees the modal (the catch-all
// `confirm: ['*']` fires).
//
// Returns true on any of the metachars listed above; the caller
// (engine.ts checkBash) treats true as "force confirm" — deny
// rules still win over confirm, so dangerous compounds like
// `; rm -rf /` are caught by `rm -rf /*` deny on the literal
// command before this gate runs.
export const containsShellInjection = (command: string): boolean => {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  // Tracks whether the previous unquoted char was `>` or `<`, so a
  // following `&` can be recognized as redirection-target syntax
  // (`>&1`, `<&-`, `2>&1`, etc.) and NOT a compound separator.
  // Reset on quote toggles, escape consumption, and any non-`>`/`<`
  // unquoted char.
  let prevIsRedirOp = false;
  while (i < command.length) {
    const c = command[i];
    if (c === undefined) break;
    // Backslash escape: skip the next char (works in unquoted +
    // double-quoted contexts; single-quotes don't honor backslash
    // — but inside single quotes we're not checking metachars
    // anyway, so the over-skip is harmless). Covers the standard
    // bash line-continuation `\\\n` — the newline gets skipped,
    // joined command continues. Resets redirection-context flag:
    // an escaped `>` is literal, not a redirect operator, so a
    // following `&` should NOT be treated as redirection target.
    if (c === '\\' && i + 1 < command.length) {
      prevIsRedirOp = false;
      i += 2;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      prevIsRedirOp = false;
      i += 1;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      prevIsRedirOp = false;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble) {
      // Compound separators (deterministic, no lookback needed)
      if (c === ';') return true;
      // Newline as command terminator — bash treats `\n` like `;`.
      // Without this, glob `*` (compiled with dotAll) matches
      // across newlines and `git status -s\nrm -rf /tmp/pwn`
      // bypasses the guard against an allow `git status -*`.
      // `\r` covered for CR-only / CRLF inputs.
      if (c === '\n' || c === '\r') return true;
      if (c === '|') return true; // covers both | and ||
      // Command substitution
      if (c === '$' && command[i + 1] === '(') return true;
      if (c === '`') return true;
      if (c === '&') {
        // && — logical-AND chain
        if (command[i + 1] === '&') return true;
        // &> — bash extension stdout+stderr redirect (also &>>)
        if (command[i + 1] === '>') {
          prevIsRedirOp = false;
          i += 1;
          continue;
        }
        // After `>` or `<` — fd duplication / closure
        // (`2>&1`, `>&-`, `<&3`, etc.). Not a separator.
        if (prevIsRedirOp) {
          prevIsRedirOp = false;
          i += 1;
          continue;
        }
        // Bare `&` — async control operator. Treats whatever
        // came before as a separate command. Includes the
        // trailing-`&` case (`sleep 30 &`): even though there's
        // no second command, the agent could just as easily have
        // emitted `sleep 30 & rm`, so the policy gate prefers a
        // confirm.
        return true;
      }
      // Process substitution: `<(cmd)` and `>(cmd)` run cmd in a
      // subshell and substitute it as a file descriptor. Same
      // security shape as `$(...)`: an allow like `cat *` would
      // otherwise admit `cat <(rm -rf /tmp/pwn)` because no
      // standard separator (`;`, `&`, `|`, etc.) appears in the
      // input. The redirection-context state already tracks
      // "previous unquoted char was `>` or `<`" — a `(` in that
      // context is process substitution, not a subshell group.
      if (c === '(' && prevIsRedirOp) return true;
      // Track redirection context for the next iteration.
      prevIsRedirOp = c === '>' || c === '<';
    } else {
      prevIsRedirOp = false;
    }
    i += 1;
  }
  return false;
};

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
