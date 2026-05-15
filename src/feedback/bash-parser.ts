// Bash command parser — extracts the leading binary so the L1
// alias outcome emitter can detect alias-eligible invocations.
//
// Scope: minimum-viable parser. Handles common shapes operators
// type day-to-day; returns null on shell-magic edge cases the
// outcome emitter falls back to the generic `flag:bash` signature.
//
// What's handled:
//   - Plain commands:          `grep foo bar`            → 'grep'
//   - Leading env vars:        `FOO=1 grep foo`          → 'grep'
//   - Compound with `cd`:      `cd /tmp && grep foo`     → 'grep'
//                              `cd /tmp; grep foo`       → 'grep'
//   - Subshell-style cd:       `(cd /tmp && grep foo)`   → 'grep'
//   - Leading whitespace:      `   grep foo`             → 'grep'
//
// What's NOT handled (returns null — emitter skips L1):
//   - Pipes:                   `cat foo | grep bar` (first binary
//                              is cat, not grep — emitter can't
//                              decide which to attribute)
//   - Backticks / $(...) :     `echo $(grep foo)`
//   - Function calls:          `myfunc arg`
//   - For loops, conditionals: `for x in ...; do ...; done`
//   - Heredocs, redirections that come first
//
// The parser is conservative — false positives (emitting an L1
// signature for a command that isn't really `grep foo`) would
// pollute the loop frio's outcome stream and cause bad adaptation
// proposals. False negatives (failing to emit when the command
// IS plain `grep foo`) just leave a stat unrecorded; operator
// surfaces less promote-able L1 signatures, but no wrong
// proposals.

// Single-line bash command parser. Returns the leading binary
// after stepping past env-var prefixes and `cd` setup, or null
// when the shape is too exotic.
export const extractLeadingBinary = (command: string): string | null => {
  // Strip leading whitespace + optional surrounding parens (one
  // level — `(cd /tmp && grep foo)` is common; we don't recurse).
  let cmd = command.trim();
  if (cmd.startsWith('(') && cmd.endsWith(')')) {
    cmd = cmd.slice(1, -1).trim();
  }
  if (cmd.length === 0) return null;

  // Walk over `cd ...` prefixes followed by `&&` or `;`. Repeat
  // (rare but possible: `cd /a && cd /b && grep foo`).
  while (true) {
    const trimmed = cmd.trimStart();
    if (!trimmed.startsWith('cd ')) break;
    // Find the next `&&` or `;` outside of quotes. Conservative:
    // bail when we hit a quote so we don't have to handle escapes.
    const breakIdx = findSeparator(trimmed);
    if (breakIdx === null) return null;
    cmd = trimmed.slice(breakIdx).replace(/^(&&|;)\s*/, '');
  }

  // Strip leading `VAR=value VAR2=value2` env prefixes. Stop on
  // the first token that doesn't match the `WORD=...` shape.
  while (true) {
    cmd = cmd.trimStart();
    const m = cmd.match(/^([A-Za-z_][A-Za-z0-9_]*=\S+)\s+/);
    if (m === null) break;
    cmd = cmd.slice(m[0].length);
  }

  // The leading token is the binary path. Accept letters, digits,
  // `_`, `+`, `.`, `/`, `-`. Leading `.` and `/` are accepted so
  // `./grep` and `/usr/bin/grep` resolve correctly to bare name.
  // Stops at first whitespace / shell metacharacter.
  const m = cmd.trimStart().match(/^([A-Za-z_./][A-Za-z0-9_+./-]*)/);
  if (m === null) return null;
  const token = m[1] as string;

  // Refuse degenerate tokens.
  if (token.length === 0 || token === '.' || token === './' || token === '/') return null;

  // Strip absolute / relative path prefix — `/usr/bin/grep` or
  // `./grep` resolves to `grep` for alias purposes. The operator's
  // intent is the binary's role, not its install location.
  const slashIdx = token.lastIndexOf('/');
  const binary = slashIdx >= 0 ? token.slice(slashIdx + 1) : token;
  // After stripping the path the bare-name still has to be non-
  // empty and not start with a dot (`.config` etc. aren't binaries).
  if (binary.length === 0 || binary.startsWith('.')) return null;
  return binary;
};

// Find the index where a shell statement separator (`&&` or `;`)
// starts. Bails (returns null) on quotes — strings are exotic
// enough that we'd rather skip than mis-parse.
const findSeparator = (s: string): number | null => {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') return null;
    if (c === '&' && s[i + 1] === '&') return i;
    if (c === ';') return i;
    if (c === '|' || c === '>' || c === '<') return null; // redir/pipe — bail
    i++;
  }
  return null;
};
