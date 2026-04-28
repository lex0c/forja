// ANSI escape stripping for tool output sanitization.
//
// Per SECURITY_GUIDELINE.md §3.2 (line 161) and §5 invariant 4: tool
// output reaches the model context (and the audit log) only after the
// sanitization layer runs. The threat model:
//   - "Esconde texto, fakes confirmação, redireciona terminal" — a tool
//     that returns "\x1b[2K\x1b[1AOK" lets a malicious file lie about
//     what happened when its output is later echoed back to a terminal
//     (verbose mode, audit replay, recap).
//   - Token waste — ANSI codes inflate the model's input context with
//     bytes the model can't render.
//   - Prompt-injection vector via embedded text inside escape blocks.
//
// The spec language is "Strip CSI controle, preservar SGR seguro" — a
// terminal-renderer concern. For tool output flowing to the MODEL we
// strip everything: the model has no terminal to render colors into,
// and a future renderer that wants to display tool output to the user
// can re-decide at its own layer (with its own safe-SGR allowlist).
// Stripping at intake means audit/DB rows never store live escape
// bytes that could later leak into a terminal.

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
  ].join('|'),
  'g',
);

export const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');

// Recursively strip ANSI from every string leaf in a value. Preserves
// shape (objects, arrays, numbers, booleans, null) so a tool returning
// `{ stdout: "..", stderr: ".." }` keeps that schema for the model.
//
// `unknown` in, `unknown` out — the harness JSON-stringifies the result
// downstream and doesn't depend on the type. Defended against:
//   - Cyclic references: tracked via an ancestry stack (WeakSet that
//     entries are added to before recursing and removed after). Only
//     references that close back on the current path are marked as
//     cycles; the same object referenced twice as siblings (a
//     non-cyclic DAG, e.g., a shared error appearing under two keys)
//     is sanitized in both places, mirroring how JSON.stringify
//     would re-emit it. Tools shouldn't produce true cycles (JSON
//     can't represent them), but the sanitizer must not
//     stack-overflow on a buggy input.
//   - Non-plain objects (Date, Buffer, Map): treated as opaque — string
//     leaves inside don't reach. Caller is expected to serialize first
//     if they want deep walking; tool contract is plain JSON-shaped.
const CYCLE_MARKER = '<cycle>';

const sanitizeWithSeen = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return stripAnsi(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return CYCLE_MARKER;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeWithSeen(v, seen));
    }
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
