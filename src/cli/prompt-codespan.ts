// Sanitizer for values embedded inside markdown code spans in the
// system prompt. Used by every prompt-assembly module that
// interpolates an attacker-influenceable value (cwd, branch name,
// AGENTS.md path, etc.) into a `\`...\`` code span.
//
// Why this is load-bearing: the system prompt is PRE-PENDED to
// the conversation and read by the model at higher priority than
// the user's message. A value that breaks out of its surrounding
// code span leaks attacker-controlled content into the prompt at
// system-level priority — a real prompt-injection vector even if
// the operator types something benign.
//
// Three classes of injection mitigated:
//
//   1. Backtick break-out — a `` ` `` inside the value would
//      close the surrounding code span and leak everything
//      after as raw markdown. Replaced with `'` (visibly
//      different so the operator notices the sanitization, no
//      markdown semantics).
//   2. Newline injection — `\n` (or `\r`) inside the value would
//      break out of the bullet line entirely and inject
//      attacker-controlled lines (with their own headers,
//      bullets, or pseudo-instructions) BEFORE the user prompt
//      is read. Replaced with U+23CE (⏎) so the operator sees
//      that the value DID contain a line break (signal preserved)
//      without losing layout.
//   3. Other ASCII control bytes (NUL, ESC, BEL, DEL, etc.) —
//      would either bypass downstream cleanups or render as
//      zero-width noise. Stripped outright.
//
// Threat model: the values flow from `process.cwd()`, `git
// rev-parse`, `--cwd`/`--model` flags, AGENTS.md paths derived
// from the cwd, etc. All of these are attacker-influenceable
// in real scenarios — a coworker creating a malicious directory
// in a shared project, a `git clone` target with a crafted
// branch name on a CI runner, `cd /tmp/$(crafted)` pre-`forja`,
// a misconfigured wrapper script.
//
// Length cap is the last layer: a value that survived the byte
// strip but is still megabyte-long would inflate the cache
// breakpoint and waste tokens. 512 chars fits every legitimate
// path / branch / model id; longer is suspect.

// Maximum characters preserved for any single sanitized value.
// Tuned to the legitimate cases (a path, a branch name, a model
// id) with comfortable headroom; values longer than this are
// truncated with an explicit `…` suffix so the model sees the
// truncation rather than a silently-clipped value.
export const PROMPT_CODESPAN_MAX_CHARS = 512;

export const sanitizeForCodeSpan = (raw: string): string => {
  let v = raw;
  // Map newlines and carriage returns to a visible glyph so
  // multi-line values fold to a single line without losing the
  // signal that the value DID contain a line break.
  v = v.replace(/\r\n|\r|\n/g, '⏎');
  // Strip remaining ASCII control bytes (0x00-0x1F minus \r, \n
  // already replaced; 0x7F DEL).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate strip
  v = v.replace(/[\x00-\x1F\x7F]/g, '');
  // Replace backticks: closes the code span if not escaped, and
  // markdown's escape semantics inside code spans are not portable
  // across renderers. Map to ' (apostrophe) — visible, no markdown
  // meaning.
  v = v.replace(/`/g, "'");
  if (v.length > PROMPT_CODESPAN_MAX_CHARS) {
    v = `${v.slice(0, PROMPT_CODESPAN_MAX_CHARS - 1)}…`;
  }
  return v;
};
