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

// Find the leading binary token in `command`, returning both the
// resolved bare name AND the start/end offsets INTO THE ORIGINAL
// string. Single scanner used by both `extractLeadingBinary`
// (returns bare name only) and `rewriteCommandBinary` (uses
// offsets to splice). Centralizing the prefix walk here prevents
// the two consumers from drifting on edge cases — paren-with-
// whitespace, multi-env, env-before-cd — that broke a previous
// duplicate-walk implementation.
//
// Returns null when the shape is too exotic to parse safely:
//   - empty / whitespace-only
//   - quoted segments (single, double, backtick) in the prefix
//   - pipes / redirections before the binary
//   - degenerate path tokens (just `.`, `./`, `/`)
//
// Bail conditions are conservative: false positives would let the
// rewrite splice into a wrong position and produce a non-equivalent
// command. False negatives just skip the rewrite + outcome emission;
// no harm done.
interface BinaryLocation {
  // Bare binary name (path-stripped).
  binary: string;
  // Index in the ORIGINAL command string where the binary token
  // starts. The path prefix is INCLUDED in this offset; rewrite
  // splices from here through `end`.
  start: number;
  // Exclusive end offset of the binary token (with path prefix).
  end: number;
}

const findLeadingBinary = (command: string): BinaryLocation | null => {
  // Optional outer parens. We REFUSE to handle parens — a previous
  // implementation tried to track interior offsets and produced
  // garbage on `( cd /tmp && grep foo )` with internal whitespace.
  // Parens-wrapped commands are rare in practice; bailing is
  // conservative + correct.
  const trimmedFull = command.trimStart();
  if (trimmedFull.startsWith('(')) return null;

  // Track absolute offset into original command as we advance.
  let offset = command.length - trimmedFull.length;
  let rest = trimmedFull;

  // Walk prefix shapes: `cd ... && / ;` AND env-var assignments.
  // Both can appear in either order; loop until neither matches.
  // Each iteration must consume at least one character or we
  // break to avoid infinite-loop on a malformed prefix.
  let progressed = true;
  while (progressed) {
    progressed = false;
    // cd prefix
    if (rest.startsWith('cd ')) {
      const breakIdx = findSeparator(rest);
      if (breakIdx === null) return null;
      // Consume `cd ... `, the separator (`&&` is 2 chars or `;`
      // is 1 char), and any trailing whitespace.
      const sepMatch = rest.slice(breakIdx).match(/^(&&|;)\s*/);
      if (sepMatch === null) return null;
      const consumed = breakIdx + sepMatch[0].length;
      offset += consumed;
      rest = rest.slice(consumed);
      progressed = true;
      continue;
    }
    // env-var prefix `WORD=value `
    // The value capture is split off so we can refuse quoted / escaped
    // values. With a greedy `\S+`, `FOO="a b" grep` matches only `"a`
    // and leaves `b" grep` in rest — the next round would then read
    // `b` as the binary. Quotes signal shell-level parsing (expansion,
    // word-splitting suppression) we don't emulate; bail to fall back
    // to the generic flag:bash signature instead of emitting a wrong
    // alias outcome.
    const envMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s+/);
    if (envMatch !== null) {
      const value = envMatch[2] as string;
      if (/["'`\\]/.test(value)) return null;
      offset += envMatch[0].length;
      rest = rest.slice(envMatch[0].length);
      progressed = true;
      continue;
    }
    // Leading whitespace from a previous consumption left over.
    if (rest.length !== rest.trimStart().length) {
      const ws = rest.length - rest.trimStart().length;
      offset += ws;
      rest = rest.trimStart();
      progressed = true;
    }
  }

  if (rest.length === 0) return null;

  // The leading token is the binary path. Same alphabet
  // extractLeadingBinary previously used.
  const m = rest.match(/^([A-Za-z_./][A-Za-z0-9_+./-]*)/);
  if (m === null) return null;
  const token = m[1] as string;
  if (token.length === 0 || token === '.' || token === './' || token === '/') return null;

  // Strip absolute / relative path prefix for the bare-name return,
  // but keep `start`/`end` covering the FULL path token so rewrite
  // replaces the whole `/usr/bin/grep` with the new bare binary.
  const slashIdx = token.lastIndexOf('/');
  const binary = slashIdx >= 0 ? token.slice(slashIdx + 1) : token;
  if (binary.length === 0 || binary.startsWith('.')) return null;

  return { binary, start: offset, end: offset + token.length };
};

// Single-line bash command parser. Returns the leading binary
// after stepping past env-var prefixes and `cd` setup, or null
// when the shape is too exotic.
export const extractLeadingBinary = (command: string): string | null => {
  const loc = findLeadingBinary(command);
  return loc === null ? null : loc.binary;
};

// Validate a candidate binary name for splice. Refuses anything
// that would let an attacker-controlled `target` field corrupt
// the rewritten command — shell metacharacters, paths, whitespace,
// quotes, control chars. Spec §9.1 says rewrite happens BEFORE the
// permission engine; without this validator a malicious
// `action_json: {target: '; rm -rf /'}` (poisoned shared DB,
// future TOML import) would bypass the entire allow-list.
//
// Allowed alphabet: ASCII letter or underscore at the start, then
// letters/digits/underscore/`+`/`.`/`-`. NO `/` (no paths — the
// new binary's PATH resolution wins). NO whitespace, NO shell
// metas (`;`, `&`, `|`, `<`, `>`, `$`, backtick, quotes, newline).
const BARE_BINARY_RE = /^[A-Za-z_][A-Za-z0-9_+.-]*$/;

export const isValidBinaryReplacement = (s: string): boolean => BARE_BINARY_RE.test(s);

// Rewrite the leading binary token in `command` to `newBinary`,
// preserving env prefixes, cd walks, leading whitespace, and the
// rest of the argument vector. Returns null when the parser
// can't locate the binary (same bail conditions as
// extractLeadingBinary) OR when `newBinary` fails the
// `isValidBinaryReplacement` check. Path-prefixed binaries
// (`/usr/bin/grep`) are replaced as bare names — the rewrite
// adopts the new binary's PATH resolution rather than copying
// the old path prefix (which would resolve to a different
// binary entirely under a different installed location).
//
// Used by 3.5b dispatch rewriting: when the resolver returns an
// active L1 alias policy, the tool input's `command` is mutated
// before invokeTool fires. Examples:
//
//   'grep -r foo'                → 'ripgrep -r foo'
//   'FOO=1 grep -r foo'          → 'FOO=1 ripgrep -r foo'
//   'cd /tmp && grep foo'        → 'cd /tmp && ripgrep foo'
//   '/usr/bin/grep -r foo'       → 'ripgrep -r foo'
export const rewriteCommandBinary = (command: string, newBinary: string): string | null => {
  if (!isValidBinaryReplacement(newBinary)) return null;
  const loc = findLeadingBinary(command);
  if (loc === null) return null;
  return `${command.slice(0, loc.start)}${newBinary}${command.slice(loc.end)}`;
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
