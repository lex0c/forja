import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
//
// `path.resolve(cwd, ...)` is called unconditionally on both target and
// pattern — even when the input is already absolute — so `..`/`./`
// components are lexically normalized BEFORE realpath. Without this
// (pre-slice-29 behavior), an absolute input like `/work/proj/../../etc/x`
// would survive both realpath fallbacks when intermediate dirs don't
// exist on the live FS, and the matcher would then strip the textual
// `/work/proj/` prefix via relativize and match the residual
// `../../etc/x` against the cwd-relative pattern.
export const matchPath = (pattern: string, target: string, cwd: string): boolean => {
  const absTargetRaw = resolve(cwd, target);
  const absTarget = resolveSymlinks(absTargetRaw);
  const absPattern = resolve(cwd, pattern);

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
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;
    // Backslash handling is narrow: only `\*`, `\?`, and `\\`
    // are recognized as escape sequences (the three chars the
    // matcher otherwise interprets as glob meta). For any other
    // following char, the backslash is preserved as a LITERAL —
    // policies legitimately carry backslashes in Windows-style
    // paths (`C:\Users\...`) and shell-escaped tokens
    // (`foo\ bar`), and consuming the backslash unconditionally
    // would silently drop them and cause `git status` rules
    // adjacent to backslashed segments to mis-match.
    //
    // Escape consumption is used by the session-allow bridge,
    // which calls `escapeGlobMetacharacters(args.command)` to
    // turn `echo *` into the literal rule `echo \*`. Without
    // escape support, the rule's `*` would be a wildcard and
    // session-allow (which runs BEFORE the compound-shell
    // guard) would auto-allow `echo $(rm -rf /)` on the next
    // call.
    if (ch === '\\' && i + 1 < pattern.length) {
      const lit = pattern[i + 1];
      if (lit === '*' || lit === '?') {
        // `\*` / `\?` — glob meta escaped to literal. Emit as
        // regex literal (these chars aren't in REGEX_META; the
        // compiler's main branch handles them as wildcards
        // separately, so explicit escape is required here).
        out += `\\${lit}`;
        i += 2;
        continue;
      }
      if (lit === '\\') {
        // `\\` — literal backslash. Emit regex escape so the
        // resulting pattern matches a single backslash.
        out += '\\\\';
        i += 2;
        continue;
      }
      // Any other pair: backslash is itself a literal char.
      // Emit the regex escape for it and let the next char
      // scan normally on its own iteration. This preserves
      // `C:\foo` / `foo\ bar` / `path\with\slashes` shapes.
      out += '\\\\';
      i += 1;
      continue;
    }
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(REGEX_META, '\\$&');
    i += 1;
  }
  // `s` (dotAll) so `.` (and therefore the `.*` we use for `*`) matches
  // newlines too. The `bash` tool accepts multi-line commands; without
  // dotAll, a pattern like `*` or `python -c *` fails to match an input
  // that contains `\n`, and policy rules silently fall through to the
  // default deny.
  return new RegExp(`^${out}$`, 's');
};

// Escapes the three glob-meaningful characters (`*`, `?`, `\\`)
// so the resulting string, fed back through compileGlobToRegex,
// matches its source LITERALLY rather than as a glob. Backslash
// itself is escaped because compileGlobToRegex's escape branch
// consumes it; an unescaped trailing backslash in the literal
// would otherwise swallow whatever precedes the next char and
// silently shift the pattern.
//
// Used by the session-allow bridge to promote `args.command` /
// `args.path` as exact-match rules. A bash command like `echo *`
// becomes `echo \*`; future calls of `echo *` match (the
// compiler's escape branch produces `^echo \*$/s`), but `echo
// $(rm -rf /)` does not. Without this, the session rule's `*`
// would be a wildcard and the engine's order (session-allow
// before compound-shell guard) would auto-allow the injection.
const GLOB_META = /[\\*?]/g;

export const escapeGlobMetacharacters = (literal: string): string =>
  literal.replace(GLOB_META, '\\$&');

// Command matching: pattern with `*` matches any sequence of characters
// (including spaces and slashes). Patterns without `*` must match the full
// command exactly. Trailing whitespace in input is trimmed.
export const matchCommand = (pattern: string, command: string): boolean =>
  compileGlobToRegex(pattern).test(command.trim());

// Detects shell metacharacters that compose multiple commands into
// one (`;`, `\n`, `\r`, `&&`, `||`, `|`, lone `&`), embed command
// substitution (`$(...)`, backticks, `<(...)`, `>(...)`), or
// redirect output to a file (`>FILE`, `>>FILE`, `>|FILE`,
// `<>FILE`, `&>FILE`, `&>>FILE`, `>&FILE`). Used by the bash
// policy check to force the confirm path on risky shapes
// regardless of any allow rule: without this, a literal `*` in
// an allow pattern admits injection like `git status; rm -rf .`
// because the matcher's `*` resolves to `.*` with dotAll
// (greedy, matches across newlines), and the deny rules can't
// enumerate every shape.
//
// Output redirection matters specifically because the init
// template's bash allowlist deliberately ships nominally
// read-only patterns (`git status -*`, `git diff -*`, `ls -*`).
// Bash redirection turns any of those into silent file mutation:
// `git status --short > /tmp/secrets` matches `git status -*`
// and, without flagging `>`, would auto-allow a write operator
// reading no permission gate. Same for `>>` (append),
// `>|` (force-write), `<>` (open for read+write), the bash
// extension `&>` / `&>>` (both streams to file), and the bash
// LEGACY form `>&word` where word is not a digit or `-`
// (equivalent to `&>word` per bash(1); see the `>` branch for
// the digit/`-` discrimination). Stdin redirection from a file
// (`<FILE`, `<<EOF`, `<<<X`) does not mutate the filesystem
// and is not flagged on its own — those are the same risk class
// as the allowed host command reading stdin, which the bash
// allow rule already authorized.
//
// File-descriptor manipulation that does NOT touch the filesystem
// stays unflagged: `>&N`, `<&N`, `>&-`, `<&-`, `2>&1`, etc. The
// `>`/`<` branch consumes the trailing `&` so the digit/`-`
// target scans normally.
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
// it's a compound separator just like `;`.
//
// The scan respects single-quote, double-quote, and backslash-escape
// state so a literal `;` inside `git commit -m "fix; bug"` does not
// trip the detector. Newlines inside single/double quotes also
// don't trip — bash treats them as part of the string, not as
// terminators. A backslash before newline (`\\\n`) is the standard
// line-continuation; the scanner's escape rule skips the newline,
// correctly leaving the joined command undetected. Heuristic —
// does NOT model here-doc bodies (the body content scans
// normally and may flag on its own metachars) or `((...))`
// arithmetic substitution. These are rare in agent-emitted
// commands; if they show up the operator still sees the modal
// whenever a more common metachar fires.
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
  while (i < command.length) {
    const c = command[i];
    if (c === undefined) break;
    // Backslash escape: skip the next char ONLY in unquoted /
    // double-quoted contexts. Inside single quotes bash does NOT
    // honor backslash escapes — `\\` is a literal backslash and
    // the next char retains its normal meaning, including the
    // closing `'`. Without the `!inSingle` guard, the scanner
    // unconditionally consumes `\\` + closing `'`, leaves
    // inSingle stuck at true, and lets the rest of the command
    // (including `;`, `&`, `|`) scan as if still quoted.
    // Concrete bypass: `echo '\\'; rm -rf /tmp/pwn` is a real
    // compound — bash sees `'\\'` as a single-quoted literal
    // backslash, then `;` as a separator. Without this guard the
    // matcher treats everything after `\\` as still inside the
    // single quote and returns false.
    //
    // Covers the standard bash line-continuation `\\\n` — the
    // newline gets skipped, joined command continues. Also
    // handles `\\>` / `\\<` — escaped redirect operators are
    // literal, not metachars.
    if (c === '\\' && !inSingle && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
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
        // &> / &>> — bash extension redirecting both stdout and
        // stderr to a file. Mutation. Flag.
        if (command[i + 1] === '>') return true;
        // Bare `&` — async control operator. Treats whatever
        // came before as a separate command. Includes the
        // trailing-`&` case (`sleep 30 &`): even though there's
        // no second command, the agent could just as easily have
        // emitted `sleep 30 & rm`, so the policy gate prefers a
        // confirm.
        return true;
      }
      if (c === '>') {
        const next = command[i + 1];
        // >& — distinguish:
        //   >&digit / >&-  → fd duplication / closure (`>&1`,
        //     `>&2`, `>&-`). No filesystem mutation. Skip.
        //   >&word         → bash LEGACY form equivalent to
        //     `&>word`: redirects both stdout AND stderr to the
        //     file `word`. Mutation. Flag. See bash(1)
        //     "REDIRECTING STANDARD OUTPUT AND STANDARD ERROR":
        //     "When using the second form [>&word], word may not
        //     expand to a number or -. If it does, other
        //     redirection operators apply (see Duplicating File
        //     Descriptors)."
        //   Without this distinction, an allow like `git diff
        //   --*` admits `git diff --name-only >&/tmp/out` because
        //   `>&` was previously always treated as fd dup.
        if (next === '&') {
          const after = command[i + 2];
          const isFdRef = after === '-' || (after !== undefined && after >= '0' && after <= '9');
          if (isFdRef) {
            i += 2;
            continue;
          }
          // >&word — file mutation.
          return true;
        }
        // >( — process substitution (write side). Same risk
        // class as $(...) — the inner command runs in a subshell.
        if (next === '(') return true;
        // Anything else (>FILE, >>FILE, >|FILE, > FILE, etc.) is
        // a file write. Flag so allow patterns like `git status*`
        // don't silently authorize `git status > /tmp/secrets`
        // — Bash redirection creates / truncates / appends to
        // arbitrary paths and the policy gate has to surface
        // that to the operator.
        return true;
      }
      if (c === '<') {
        const next = command[i + 1];
        // <& — fd duplication. Note the asymmetry with `>&`:
        //   `<&word` where word is NOT a digit or `-` is a bash
        //   ERROR at runtime (see bash(1) "Duplicating File
        //   Descriptors") — there's no `<&word` legacy form for
        //   "read both streams from word" the way `>&word`
        //   redirects both output streams. So we don't need the
        //   digit/`-` discrimination on the `<` side: any
        //   `<&...` either runs as fd dup (no fs touch) or
        //   bash-errors (no execution, no security concern).
        if (next === '&') {
          i += 2;
          continue;
        }
        // << — heredoc; <<< (handled by recursion: after
        // consuming `<<` here, the third `<` is treated as a
        // standalone read redirect, which is also unflagged).
        // Heredoc body content scans normally and may flag on
        // its own metachars (false-positive on legitimate
        // heredocs is acceptable — operator sees modal once,
        // session-allow promotes the literal).
        if (next === '<') {
          i += 2;
          continue;
        }
        // <( — process substitution (read side)
        if (next === '(') return true;
        // <> — opens file for read+write. Mutation. Flag.
        if (next === '>') return true;
        // <FILE — read from file. No mutation. The bash allow
        // rule that authorized the host command already
        // authorized stdin handling; not flagged here.
        i += 1;
        continue;
      }
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
