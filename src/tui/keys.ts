// Stdin escape-sequence parser for the inline TUI. Spec: UI.md §5.1, §5.4.
//
// Raw stdin in TTY mode delivers one of:
//  - a single ASCII byte (printable, control, or 0x7f DEL)
//  - a multi-byte UTF-8 sequence for one Unicode codepoint
//  - an escape sequence (CSI, SS3, or modifier-prefixed) for arrows,
//    function keys, paste markers, alt+letter, etc.
//
// The parser is byte-stateful: callers feed bytes via `feed(buf)` and
// receive zero or more KeyEvent objects. Incomplete sequences are buffered
// until the next feed. This matches how `node-pty` and `blessed` work
// internally and lets us handle multi-byte chunks split across reads.

import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './term.ts';

// Named keys we care about. Printable characters and pasted text use
// kind === 'char' / 'paste'. Anything else is normalized to a stable
// `name` so render code never inspects raw bytes.
export type KeyName =
  | 'enter'
  | 'tab'
  | 'backspace'
  | 'escape'
  | 'space'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'delete'
  | 'insert'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12';

export type KeyEvent =
  | { kind: 'key'; name: KeyName; ctrl: boolean; alt: boolean; shift: boolean; raw: string }
  // Printable codepoint (single character, UTF-8 decoded). Modifier flags
  // reflect what the terminal CAN tell us — most terminals don't report
  // shift on plain letters (typed casing already encodes it).
  | { kind: 'char'; char: string; ctrl: boolean; alt: boolean; raw: string }
  // Bracketed paste content as a single chunk. Render code treats this
  // as one logical input event (no per-char redraw).
  | { kind: 'paste'; text: string };

// A small subset of CSI sequences mapped to named keys. Covers vt100,
// xterm, and what Linux console emits. We don't try to be exhaustive
// for keys nobody uses (Shift+F11, etc.) — those fall through as
// unknown escape sequences and are dropped.
//
// Format: the byte AFTER `ESC [` (or `ESC O` for SS3), with optional
// modifier params parsed separately.
const CSI_FINAL_TO_NAME: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  // Some terminals emit ESC [ Z for Shift+Tab. We surface it as 'tab'
  // with shift=true rather than a separate name.
  Z: 'tab',
};

// `ESC [ <num> ~` mappings (xterm-style). Numbers sourced from xterm
// ctlseqs documentation.
const CSI_TILDE_TO_NAME: Record<string, KeyName> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '11': 'f1',
  '12': 'f2',
  '13': 'f3',
  '14': 'f4',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12',
};

// `ESC O <letter>` (SS3) — the alternate keypad sequences emitted by
// some terminals (notably xterm with appkeypad mode and macOS Terminal).
const SS3_TO_NAME: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

// Decode the modifier param (xterm uses (modifier-1) bitfield where
// 1=shift, 2=alt, 4=ctrl, 8=meta). The "+1" arrives because xterm
// encodes "no modifiers" as 1.
const decodeModifier = (param: number): { shift: boolean; alt: boolean; ctrl: boolean } => {
  const m = Math.max(0, param - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 };
};

const NO_MODS = { shift: false, alt: false, ctrl: false };

// Decode incoming chunks into a JS string. Uses a stateful TextDecoder
// in `stream:true` mode so a multi-byte UTF-8 codepoint split across two
// chunks decodes correctly (the trailing continuation bytes are held by
// the decoder and emitted on the next call). String inputs are passed
// through unchanged — they're already JS code units with no further
// decoding to do.
//
// A pure-string parser is simpler than a Buffer one and the per-byte
// perf cost is negligible for terminal input rates (< 1000 bytes/sec
// sustained).
interface ChunkDecoder {
  decode: (input: Buffer | string) => string;
}
const createDecoder = (): ChunkDecoder => {
  const td = new TextDecoder('utf-8', { fatal: false });
  return {
    decode: (input) => (typeof input === 'string' ? input : td.decode(input, { stream: true })),
  };
};

export interface KeyParser {
  feed: (input: Buffer | string) => KeyEvent[];
  // Drains any buffered sequence as best-effort raw chars. Used at
  // shutdown so a half-typed paste doesn't get silently lost.
  drain: () => KeyEvent[];
  // Internal buffer length, exposed for tests.
  bufferLength: () => number;
}

export const createKeyParser = (): KeyParser => {
  let buf = '';
  let pasteActive = false;
  let pasteBuf = '';
  const decoder = createDecoder();

  const flushPaste = (events: KeyEvent[]): void => {
    // Normalize line endings: terminals like xterm emit `\r` (CR) for
    // pasted newlines (Enter convention applied to bracketed-paste
    // content), and Windows-origin sources send `\r\n` (CRLF). Both
    // would land in the input buffer as control chars — `\r` makes
    // the renderer think "carriage return to col 0", visually
    // collapsing multi-line paste onto one line. Map every variant
    // to a single `\n`. CRLF is replaced first so the bare-CR pass
    // doesn't see split `\n\n`.
    const text = pasteBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    events.push({ kind: 'paste', text });
    pasteBuf = '';
    pasteActive = false;
  };

  // Try to consume one event from the head of `buf`. Returns null if
  // the buffer holds an incomplete escape sequence (caller leaves it
  // for the next feed). Returns 0 advancement is impossible — we
  // always consume at least one char or signal "wait".
  const consume = (): { event: KeyEvent | null; advance: number } | null => {
    if (buf.length === 0) return null;

    // Bracketed paste: while active, accumulate everything until end
    // marker; emit any other bytes verbatim.
    if (pasteActive) {
      const endIdx = buf.indexOf(BRACKETED_PASTE_END);
      if (endIdx === -1) {
        // No end marker yet — but don't consume the whole buffer in
        // case it ends with a partial marker. Keep the last 5 bytes
        // (BRACKETED_PASTE_END.length is 6) buffered.
        const safeEnd = Math.max(0, buf.length - BRACKETED_PASTE_END.length + 1);
        if (safeEnd === 0) return { event: null, advance: 0 };
        pasteBuf += buf.slice(0, safeEnd);
        return { event: null, advance: safeEnd };
      }
      pasteBuf += buf.slice(0, endIdx);
      const events: KeyEvent[] = [];
      flushPaste(events);
      // Caller drains via the outer loop — but we can only return one
      // event per consume call. Stash it via a closure trick: emit
      // the paste as the "advance" call and let the next consume be
      // a no-op since pasteBuf is already cleared.
      const ev = events[0];
      return ev !== undefined
        ? { event: ev, advance: endIdx + BRACKETED_PASTE_END.length }
        : { event: null, advance: endIdx + BRACKETED_PASTE_END.length };
    }

    // Bracketed paste start marker (only meaningful outside paste).
    if (buf.startsWith(BRACKETED_PASTE_START)) {
      pasteActive = true;
      return { event: null, advance: BRACKETED_PASTE_START.length };
    }

    const c0 = buf.charCodeAt(0);

    // ESC + ... — escape sequence.
    if (c0 === 0x1b) {
      // Lone ESC: ambiguous (could be Esc key, or start of unfinished
      // sequence). We resolve by waiting one feed. If the buffer still
      // holds just ESC after drain(), it's emitted as escape.
      if (buf.length === 1) return { event: null, advance: 0 };

      const c1 = buf.charCodeAt(1);

      // CSI: ESC [ ...
      if (c1 === 0x5b /* '[' */) {
        // Find the final byte (in 0x40..0x7e range). Params and
        // intermediates between are digits, ';', or '?'.
        let i = 2;
        while (i < buf.length) {
          const c = buf.charCodeAt(i);
          if (c >= 0x40 && c <= 0x7e) break;
          i++;
        }
        if (i >= buf.length) return { event: null, advance: 0 };
        const final = buf[i];
        const paramStr = buf.slice(2, i);
        const total = i + 1;
        const raw = buf.slice(0, total);
        if (final === undefined) return { event: null, advance: 0 };
        const event = decodeCsi(final, paramStr, raw);
        return { event, advance: total };
      }

      // SS3: ESC O <letter>
      if (c1 === 0x4f /* 'O' */) {
        if (buf.length < 3) return { event: null, advance: 0 };
        const letter = buf[2];
        if (letter === undefined) return { event: null, advance: 0 };
        const name = SS3_TO_NAME[letter];
        const raw = buf.slice(0, 3);
        if (name === undefined) return { event: null, advance: 3 };
        return { event: { kind: 'key', name, ...NO_MODS, raw }, advance: 3 };
      }

      // Alt+<char>: ESC followed by a printable. Most terminals send
      // this for Alt+letter / Meta+letter. We treat ESC+ESC specially
      // (interrupt) elsewhere — here we just emit alt+char.
      if (buf.length >= 2) {
        const ch = buf[1];
        if (ch === undefined) return { event: null, advance: 0 };
        const code = buf.charCodeAt(1);
        // ESC ESC: emit as escape twice — caller wires it to soft
        // interrupt (UI.md §5.4). We do NOT collapse to a single event
        // because the user intent is "double-tap escape".
        if (code === 0x1b) {
          return {
            event: { kind: 'key', name: 'escape', ...NO_MODS, raw: '\x1b' },
            advance: 1,
          };
        }
        // Plain printable after ESC → alt+char.
        if (code >= 0x20 && code !== 0x7f) {
          return {
            event: { kind: 'char', char: ch, ctrl: false, alt: true, raw: buf.slice(0, 2) },
            advance: 2,
          };
        }
        // ESC + control byte we don't recognize — drop the ESC and let
        // the next consume handle the control byte normally.
        return { event: null, advance: 1 };
      }
      return { event: null, advance: 0 };
    }

    // Plain control bytes. Note that the keys carved out below
    // (Enter, Tab, Backspace) "shadow" the Ctrl+letter range that
    // would otherwise capture them: 0x0d=Ctrl+M, 0x0a=Ctrl+J,
    // 0x09=Ctrl+I, 0x08=Ctrl+H. We surface them as named keys
    // because that's what every user expects; bindings for the
    // shadowed Ctrl combos are not available at this layer.
    if (c0 === 0x0d || c0 === 0x0a) {
      return {
        event: { kind: 'key', name: 'enter', ...NO_MODS, raw: buf[0] ?? '' },
        advance: 1,
      };
    }
    if (c0 === 0x09) {
      return { event: { kind: 'key', name: 'tab', ...NO_MODS, raw: '\t' }, advance: 1 };
    }
    if (c0 === 0x7f || c0 === 0x08) {
      // Most modern terminals send 0x7f (DEL) for backspace. 0x08 is
      // legacy. We normalize both to 'backspace'.
      return {
        event: { kind: 'key', name: 'backspace', ...NO_MODS, raw: buf[0] ?? '' },
        advance: 1,
      };
    }
    if (c0 === 0x20) {
      return { event: { kind: 'key', name: 'space', ...NO_MODS, raw: ' ' }, advance: 1 };
    }
    // Ctrl+letter: bytes 0x01..0x1a map to ctrl+a..ctrl+z. Bytes
    // already shadowed above (Tab/Enter/Backspace) won't reach here.
    if (c0 >= 0x01 && c0 <= 0x1a) {
      const letter = String.fromCharCode(0x60 + c0);
      return {
        event: { kind: 'char', char: letter, ctrl: true, alt: false, raw: buf[0] ?? '' },
        advance: 1,
      };
    }

    // Printable ASCII (single JS code unit, single byte).
    if (c0 < 0x80) {
      return {
        event: { kind: 'char', char: buf[0] ?? '', ctrl: false, alt: false, raw: buf[0] ?? '' },
        advance: 1,
      };
    }
    // Non-ASCII codepoint. After decoding, `buf` holds JS code units
    // (UTF-16); a non-BMP codepoint occupies two units (a surrogate
    // pair). Use the codepoint to figure out how many code units to
    // slice — NOT the original UTF-8 byte count, which has already
    // been decoded away.
    const cp = buf.codePointAt(0);
    if (cp === undefined) return { event: null, advance: 1 };
    const len = cp > 0xffff ? 2 : 1;
    return {
      event: {
        kind: 'char',
        char: buf.slice(0, len),
        ctrl: false,
        alt: false,
        raw: buf.slice(0, len),
      },
      advance: len,
    };
  };

  return {
    feed: (input) => {
      buf += decoder.decode(input);
      const events: KeyEvent[] = [];
      while (buf.length > 0) {
        const r = consume();
        if (r === null || r.advance === 0) break;
        if (r.event !== null) events.push(r.event);
        buf = buf.slice(r.advance);
      }
      return events;
    },
    drain: () => {
      const events: KeyEvent[] = [];
      // Lone ESC held by the parser becomes an escape keypress.
      if (buf.length === 1 && buf.charCodeAt(0) === 0x1b) {
        events.push({ kind: 'key', name: 'escape', ...NO_MODS, raw: '\x1b' });
        buf = '';
      }
      // An unterminated paste at shutdown loses content; accept that
      // — we'd rather drop a partial paste than risk emitting it as
      // command input.
      pasteActive = false;
      pasteBuf = '';
      return events;
    },
    bufferLength: () => buf.length,
  };
};

// Decode a CSI sequence given its final byte and parameter substring.
// Returns null when the final byte isn't one we recognize (caller drops
// the sequence — better than emitting noise).
const decodeCsi = (final: string, paramStr: string, raw: string): KeyEvent | null => {
  // ESC [ <num> ~ — function keys, navigation.
  if (final === '~') {
    // Format: <code>[;<modifier>]
    const parts = paramStr.split(';');
    const code = parts[0] ?? '';
    const modParam = parts[1] !== undefined ? Number.parseInt(parts[1], 10) : 1;
    const name = CSI_TILDE_TO_NAME[code];
    if (name === undefined) return null;
    const mods = Number.isFinite(modParam) ? decodeModifier(modParam) : NO_MODS;
    return { kind: 'key', name, ...mods, raw };
  }
  // ESC [ A/B/C/D/H/F (with optional modifier as `1;<mod>`).
  const name = CSI_FINAL_TO_NAME[final];
  if (name === undefined) return null;
  // xterm ships `1;5C` for Ctrl+Right; the leading 1 is ignored param.
  const parts = paramStr.split(';');
  const modParam = parts.length >= 2 && parts[1] !== undefined ? Number.parseInt(parts[1], 10) : 1;
  const mods = Number.isFinite(modParam) ? decodeModifier(modParam) : NO_MODS;
  // ESC [ Z = Shift+Tab. Force shift=true regardless of modParam since
  // CSI_FINAL_TO_NAME mapped it to 'tab'.
  if (final === 'Z') return { kind: 'key', name: 'tab', ...mods, shift: true, raw };
  return { kind: 'key', name, ...mods, raw };
};
