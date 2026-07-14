// Control-sequence stripping for tool / model output sanitization.
//
// Despite the file name, `stripAnsi` removes ANSI escape sequences
// AND raw control bytes (C0 / C1 / DEL) that would otherwise hijack
// terminal state if echoed back: BEL beeps the user, BS rewinds the
// cursor, XOFF (\x13) pauses the terminal's input delivery to our
// process, etc. The three TUI-safe whitespace controls (TAB \x09,
// LF \x0a, CR \x0d) survive untouched — they appear legitimately in
// file content and don't disrupt cursor state.
//
// Per SECURITY_GUIDELINE.md §3.2 (line 161) and §5 invariant 4: tool
// output reaches the model context (and the audit log) only after
// the sanitization layer runs. The threat model:
//   - "Esconde texto, fakes confirmação, redireciona terminal" — a
//     tool that returns "\x1b[2K\x1b[1AOK" lets a malicious file
//     lie about what happened when its output is later echoed back
//     to a terminal (verbose mode, audit replay, recap).
//   - Token waste — escape codes inflate the model's input context
//     with bytes the model can't render.
//   - Prompt-injection vector via embedded text inside escape blocks.
//   - Terminal-state hijack — control bytes can pause input
//     delivery, hide the cursor, switch alt-screen, etc.; reproduced
//     as "frozen REPL" when assistant text echoed file content back
//     through stdout without the C0 strip applied.
//
// The spec language is "Strip CSI controle, preservar SGR seguro" —
// a terminal-renderer concern. For tool output flowing to the MODEL
// we strip everything: the model has no terminal to render colors
// into, and a future renderer that wants to display tool output to
// the user can re-decide at its own layer (with its own safe-SGR
// allowlist). Stripping at intake means audit/DB rows never store
// live escape bytes that could later leak into a terminal.

// Recognized ANSI patterns:
//
//   - CSI: ESC [  params* intermediate* final
//     params      = [0-9;:?]*
//     intermediate = [ -/]    (0x20-0x2F)
//     final       = [@-~]     (0x40-0x7E)
//
//   - OSC: ESC ] ... terminator
//     terminator  = BEL (0x07) or ST (ESC \)
//
//   - DCS / APC / PM / SOS: ESC [PX^_] ... ST
//
//   - 7-bit single-char escapes: ESC followed by one byte in 0x20-0x7E
//     (covers RI, NEL, RIS, etc — none useful in tool output).
//
//   - C1 controls in 8-bit form: 0x80-0x9F (rare; some terminals).
//
// We collapse all of these into a single alternation. Multi-byte
// terminators (ESC \) get matched non-greedily so consecutive OSC blocks
// don't merge into one.
const ANSI_PATTERN = new RegExp(
  [
    // CSI
    //   params      = 0x30-0x3F (digits, `;`, `:`, `<`, `=`, `>`, `?`)
    //   intermediate = 0x20-0x2F
    //   final       = 0x40-0x7E
    // The full param range matters for private-mode CSI like xterm
    // mouse 1006 (`\x1b[<0;1;1M`); a narrower class would let the
    // sequence body leak through as text after the leading `\x1b[`
    // gets eaten by the single-char fallback.
    '\\x1b\\[[0-9;:<=>?]*[ -/]*[@-~]',
    // OSC terminated by BEL
    '\\x1b\\][\\s\\S]*?\\x07',
    // OSC / DCS / APC / PM / SOS terminated by ST (ESC \)
    '\\x1b[\\]PX^_][\\s\\S]*?\\x1b\\\\',
    // 7-bit single-char escapes (any byte in printable ASCII range
    // after ESC that ISN'T the start of a structured sequence above —
    // those are matched first by alternation order). Range 0x40-0x7E
    // covers Type Fe (`@-_`), Fs (`` ` ``-`~`), and the `c` (RIS)
    // terminal-reset code.
    '\\x1b[@-~]',
    // C1 control bytes (8-bit single-byte equivalents)
    '[\\x80-\\x9f]',
    // Bare ESC fallback: any \x1b not consumed by a pattern above is
    // a stray control introducer. Leaving it would violate the
    // invariant that no control bytes reach model/audit sinks —
    // string concatenation downstream could pair it with later text
    // and re-form a live escape (e.g., `output + "\x1b" + nextChunk`
    // where nextChunk starts with `[31m`). Always strip. Comes last
    // so structured sequences match first.
    '\\x1b',
    // C0 control bytes (everything in 0x00-0x1F except the three
    // safe-for-TUI whitespace controls: TAB \x09, LF \x0a, CR \x0d)
    // plus DEL \x7F. The dangerous ones for terminal-state hijacking:
    //   - BEL  \x07: makes the terminal beep / flash on every byte
    //   - BS   \x08: backspace; rewinds the cursor
    //   - VT/FF \x0b/\x0c: vertical tab / form feed; some terminals
    //                     scroll the screen (xterm clears past prompt)
    //   - SO/SI \x0e/\x0f: shift in/out alternate character set
    //   - XON/XOFF \x11/\x13: software flow control. XOFF makes the
    //                        terminal pause sending bytes back to us
    //                        (raw mode disables the kernel's IXON
    //                        handling but the terminal driver's
    //                        bidirectional flow control still applies
    //                        on some platforms — operator perceives it
    //                        as "input froze")
    //   - SUB  \x1a: substitute; some terminals interpret as "abort"
    //   - DEL  \x7F: delete; behaves like backspace on many terminals
    // Stripping the whole non-whitespace C0 range catches these and
    // any future control we don't know about. Cheaper than maintaining
    // an enumerated allow-list and equally safe — model output has no
    // legitimate use for C0 controls in prose.
    //
    // Range explicitly excludes \x1b (covered by the structured
    // CSI/OSC/SS3 patterns above and the bare-ESC fallback). Splitting
    // 0x0e-0x1a + 0x1c-0x1f leaves no gap for ESC to be redundantly
    // matched here — the control flow is "structured ESC sequence
    // first, then any other dangerous byte" without overlap.
    '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1a\\x1c-\\x1f\\x7f]',
  ].join('|'),
  'g',
);

export const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');

// One-line display sanitization for untrusted strings the modal
// will interpolate verbatim into a single row. Three transforms:
//   1. stripAnsi removes ESC-prefixed control sequences so the
//      string can't paint fake colors / cursor moves into the
//      modal layout.
//   2. Newline / tab / CR collapse to a single space — a
//      multi-line payload could otherwise split across modal
//      rows and mimic separator lines or fake warnings.
//      stripAnsi does NOT cover \x0a (LF) — its character class
//      excludes \x09-\x0a-\x0d to keep ordinary text intact —
//      so the explicit collapse is necessary.
//   3. Length cap so a kilobyte-long string can't overflow the
//      modal row width or push subsequent content off screen.
//
// Used by modal labels that interpolate strings derived from
// raw tool args (e.g., the session-allow option's "Yes, don't
// ask again for: <X>" wording — X originates from the model's
// emitted args.command, which the parent gate doesn't otherwise
// trust to be control-clean). Default cap matches the existing
// SUBAGENT_DISPLAY_MAX surface so a future migration can fold
// both call sites onto this helper without behavior drift.
export const SAFE_ONE_LINE_MAX = 200;
export const sanitizeOneLineForDisplay = (raw: string, max = SAFE_ONE_LINE_MAX): string => {
  let cleaned = stripAnsi(raw).replace(/[\r\n\t]+/g, ' ');
  if (cleaned.length > max) {
    cleaned = `${cleaned.slice(0, max - 1)}…`;
  }
  return cleaned;
};

// Sanitize a model-authored tool-card SUBJECT (a bash command / grep pattern
// / path) for a single scrollback line — shared by the live tool card
// (harness-adapter) and the resume-replay card so both render the SAME
// subject. Strips ANSI + C0 control bytes (a raw ESC/BEL paints fake SGR or
// rings the bell; a bare `\r` overwrites a row), collapses `\r`/`\t` and any
// newline-hugging whitespace to a single space while leaving ordinary
// intra-line spacing untouched (so `grep -n "foo  bar"` keeps its double
// space), and caps the line so a huge command can't blow past the card.
// `null` passes through unchanged.
export const sanitizeCardSubject = (
  subject: string | null,
  max = SAFE_ONE_LINE_MAX,
): string | null => {
  if (subject === null) return null;
  const cleaned = stripAnsi(subject).replace(/[\r\t]+/g, ' ');
  const flat = cleaned.includes('\n') ? cleaned.replace(/\s*\n\s*/g, ' ').trim() : cleaned;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// Anti-spoof for untrusted text that lands in the operator's SCROLLBACK
// (not a modal — so, unlike `sanitizeOneLineForDisplay`, no width cap;
// the wake-turn input that shares this path shouldn't be truncated).
// Used for a fired notification echoing a model-authored reminder note /
// bg command, or raw bg process output. stripAnsi already drops ESC
// sequences AND every bare C0 byte EXCEPT \t \n \r (its class keeps those
// three to preserve ordinary text); those three are exactly the
// scrollback-spoof vectors (\n / \r forge or overwrite rows). So both
// helpers below only have to deal with \t \n \r after stripAnsi. The
// char-scan (vs a control-char regex) keeps raw C0 bytes out of this
// source and stays correct even if stripAnsi's class changes.
//
// `flattenControlToLine` collapses survivors to one line (note/command —
// conceptually single-line). `stripControlKeepLines` drops \r (the
// overwrite vector) but KEEPS \n and \t so a multi-line body (the bg
// output head-tail) preserves its line structure for the caller's
// per-line indent.
export const flattenControlToLine = (s: string): string => {
  let out = '';
  for (const ch of stripAnsi(s)) out += ch.charCodeAt(0) <= 0x1f ? ' ' : ch;
  return out.replace(/ {2,}/g, ' ').trim();
};
export const stripControlKeepLines = (s: string): string => {
  let out = '';
  for (const ch of stripAnsi(s)) {
    const c = ch.charCodeAt(0);
    if (c > 0x1f || c === 0x09 || c === 0x0a) out += ch; // printable + TAB + LF
  }
  return out;
};

// Collapse runs of blank (whitespace-only) lines down to a single empty line.
// `stripControlKeepLines` preserves \n for a multi-line body, but that lets
// untrusted text flood the TTY with blank lines — a peer sending thousands of
// '\n' renders as thousands of blank (indented) rows even under a char cap.
// Content lines are kept at full fidelity; only the empty runs shrink.
export const collapseBlankLines = (s: string): string => {
  const out: string[] = [];
  let prevBlank = false;
  for (const line of s.split('\n')) {
    const blank = line.trim().length === 0;
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out.join('\n');
};

// Recursively strip ANSI from every string leaf in a value. Preserves
// shape (plain objects, arrays, numbers, booleans, null) so a tool
// returning `{ stdout: "..", stderr: ".." }` keeps that schema for
// the model. Non-plain objects (Date, Map, Set, Error, class
// instances, Buffer) are NOT walked: doing so would call
// `Object.entries` and either flatten them to `{}` (Date, Map, Set)
// or destroy their prototype (class instances), silently corrupting
// the output. Instead, we follow JSON serialization semantics:
//   - If the value has `toJSON`, call it and recurse on the result
//     (matches JSON.stringify; Date → ISO string for example).
//   - Otherwise, return the value opaquely. The harness's downstream
//     `JSON.stringify(content)` will render it per JSON's own rules
//     (Map/Set/Error → `{}`, custom instance → enumerable props).
//
// `unknown` in, `unknown` out — the harness JSON-stringifies the
// result downstream and doesn't depend on the type. Defenses:
//   - Cyclic references tracked via an ancestry-stack WeakSet.
//     Entries added before recursing and removed after, so a non-
//     cyclic DAG (same object referenced from sibling positions)
//     is sanitized in every position — only refs that close back
//     on the current path are marked as cycles.
//   - The walker never falls into infinite toJSON loops because
//     the post-toJSON value is structurally different (it's the
//     serialized form, not the original instance).
const CYCLE_MARKER = '<cycle>';

const isPlainObject = (v: object): boolean => {
  // Object.create(null) has null prototype but is functionally a
  // plain dict — walk it. Anything else with a custom prototype
  // (Date, Map, instance of Foo) is treated as opaque.
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const hasToJSON = (v: object): v is { toJSON: (key?: unknown) => unknown } =>
  typeof (v as { toJSON?: unknown }).toJSON === 'function';

const sanitizeWithSeen = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return stripAnsi(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return CYCLE_MARKER;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeWithSeen(v, seen));
    }
    // Honor `toJSON` like JSON.stringify does — Date → ISO string,
    // class instances that opt into a serialized form get their
    // serialized shape sanitized. The seen-set still guards against
    // cycles in pathological toJSON implementations.
    if (hasToJSON(value)) {
      return sanitizeWithSeen(value.toJSON(), seen);
    }
    // Non-plain objects without toJSON: opaque pass-through. The
    // caller will eventually JSON.stringify and get the same shape
    // they would have gotten without us — Map/Set/Error → `{}`,
    // instance → its own enumerable props. Walking would
    // corruptively flatten these to literal `{}`, losing the
    // identity that JSON's default rendering preserves.
    if (!isPlainObject(value)) return value;
    // Plain object walk. Non-enumerable / symbol keys are ignored —
    // tool outputs are spec'd as JSON-shaped, and JSON.stringify
    // drops them too.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeWithSeen(v, seen);
    }
    return out;
  } finally {
    // Pop from the ancestry stack so a sibling holding the same
    // reference re-processes it instead of getting `<cycle>` for a
    // non-cyclic DAG.
    seen.delete(value);
  }
};

export const sanitizeToolOutput = (value: unknown): unknown =>
  sanitizeWithSeen(value, new WeakSet());
