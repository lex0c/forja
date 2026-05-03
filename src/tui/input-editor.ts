// Input editor — pure key-event reducer for the input box. Spec:
// UI.md §5.1 (input handling) and §5.4 (keybindings).
//
// Takes a `KeyEvent` and the current `InputState`, returns the next
// `InputState` plus optional signals the caller acts on:
//   - submit: user pressed Enter on a non-empty buffer
//   - cancelInput: user pressed Ctrl+C with the buffer empty
//   - interruptSoft: single Esc — caller decides whether to forward
//     to the harness based on loop state
//
// Hard interrupt (second Esc while soft already in flight) is
// detected by the REPL loop, not here — the editor only sees one key
// per call and is stateless across calls. The REPL reads the
// renderer's softInterrupted flag to distinguish first Esc from
// second.
//
// The editor is `state in, state out` — no side effects. The caller
// (REPL loop) owns the bus, the harness, the cursor visibility. This
// makes the editor trivially testable: feed key sequences and assert
// on the resulting state.

import type { KeyEvent } from './keys.ts';
import type { InputState } from './state.ts';

export interface ApplyKeyResult {
  next: InputState;
  // User pressed Enter on a non-empty buffer. Caller emits
  // `user:submit` and clears via the reducer's existing path.
  submit?: { text: string };
  // User pressed Ctrl+C with an empty buffer. Caller treats as
  // "cancel input mode" or "exit"; with non-empty buffer Ctrl+C
  // clears the buffer (handled internally) instead of bubbling.
  cancelInput?: true;
  // Soft interrupt request: Esc once. Caller decides whether to
  // forward to the harness — only meaningful while running.
  interruptSoft?: true;
}

const NOOP = (input: InputState): ApplyKeyResult => ({ next: input });

// Apply a single keystroke. Idempotent in the sense that the same
// state + same key always produces the same output.
export const applyKey = (input: InputState, key: KeyEvent): ApplyKeyResult => {
  switch (key.kind) {
    case 'paste':
      return { next: insertText(input, key.text) };

    case 'char':
      // Ctrl+letter combos handled below; plain printable goes
      // straight in.
      if (key.ctrl) return applyCtrlChar(input, key.char);
      if (key.alt) return applyAltChar(input, key.char);
      return { next: insertText(input, key.char) };

    case 'key':
      return applyNamedKey(input, key);
  }
};

// ─── Insertion / deletion primitives ─────────────────────────────────────

const insertText = (input: InputState, text: string): InputState => {
  const before = input.value.slice(0, input.cursor);
  const after = input.value.slice(input.cursor);
  return {
    value: before + text + after,
    cursor: input.cursor + text.length,
  };
};

const deleteRange = (input: InputState, start: number, end: number): InputState => {
  // Bounds-clamped delete. Used by backspace, delete, ctrl+w, ctrl+u, ctrl+k.
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(input.value.length, Math.max(start, end));
  if (lo === hi) return input;
  return {
    value: input.value.slice(0, lo) + input.value.slice(hi),
    cursor: input.cursor <= lo ? input.cursor : input.cursor <= hi ? lo : input.cursor - (hi - lo),
  };
};

// True when `s.charCodeAt(idx)` is a UTF-16 high surrogate (0xD800..0xDBFF).
// `lowSurrogate` covers the second half of the pair (0xDC00..0xDFFF).
// Backspace / Delete use these to keep emoji + non-BMP CJK intact —
// removing only one half would leave an orphan and corrupt the string.
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

// One step backward over a codepoint boundary. Returns the offset to
// land on after a backspace from `cursor`. Skips over the high
// surrogate when the cursor sits after a non-BMP codepoint.
const stepBack = (value: string, cursor: number): number => {
  if (cursor <= 0) return 0;
  const before = value.charCodeAt(cursor - 1);
  if (isLowSurrogate(before) && cursor >= 2) {
    const prev = value.charCodeAt(cursor - 2);
    if (isHighSurrogate(prev)) return cursor - 2;
  }
  return cursor - 1;
};

// One step forward over a codepoint boundary. Returns the offset
// AFTER a delete-forward from `cursor`. Skips over the low surrogate
// when the cursor sits before a non-BMP codepoint.
const stepForward = (value: string, cursor: number): number => {
  if (cursor >= value.length) return value.length;
  const at = value.charCodeAt(cursor);
  if (isHighSurrogate(at) && cursor + 1 < value.length) {
    const next = value.charCodeAt(cursor + 1);
    if (isLowSurrogate(next)) return cursor + 2;
  }
  return cursor + 1;
};

// ─── Ctrl+letter handlers ────────────────────────────────────────────────

const applyCtrlChar = (input: InputState, char: string): ApplyKeyResult => {
  switch (char) {
    case 'a': // beginning of line (current line, multi-line aware)
      return { next: { ...input, cursor: lineStart(input) } };
    case 'e': // end of line
      return { next: { ...input, cursor: lineEnd(input) } };
    case 'u': // delete from cursor to start of line
      return { next: deleteRange(input, lineStart(input), input.cursor) };
    case 'k': // delete from cursor to end of line
      return { next: deleteRange(input, input.cursor, lineEnd(input)) };
    case 'w': // delete previous word
      return { next: deleteRange(input, prevWordBoundary(input), input.cursor) };
    case 'c':
      // With non-empty buffer: clear it (no submit, just reset). With
      // empty buffer: surface as cancel signal so the caller can
      // decide (exit, double-Ctrl+C, etc.).
      if (input.value === '') return { next: input, cancelInput: true };
      return { next: { value: '', cursor: 0 } };
    case 'd':
      // EOF when buffer empty — surface as cancelInput. Otherwise
      // delete forward (same as Delete key).
      if (input.value === '') return { next: input, cancelInput: true };
      return { next: deleteRange(input, input.cursor, stepForward(input.value, input.cursor)) };
    case 'h':
      // Same byte as Backspace on most terminals; the key parser
      // already normalizes to 'backspace'. We keep this branch so
      // ctrl+h via a non-standard mapping still does the right thing.
      return { next: deleteRange(input, stepBack(input.value, input.cursor), input.cursor) };
    default:
      return NOOP(input);
  }
};

// ─── Alt+letter handlers ─────────────────────────────────────────────────

const applyAltChar = (input: InputState, char: string): ApplyKeyResult => {
  switch (char) {
    case 'b': // jump to previous word boundary
      return { next: { ...input, cursor: prevWordBoundary(input) } };
    case 'f': // jump to next word boundary
      return { next: { ...input, cursor: nextWordBoundary(input) } };
    case 'd': // delete next word
      return { next: deleteRange(input, input.cursor, nextWordBoundary(input)) };
    default:
      return NOOP(input);
  }
};

// ─── Named-key handler (arrows, enter, backspace, delete, esc) ───────────

const applyNamedKey = (
  input: InputState,
  key: Extract<KeyEvent, { kind: 'key' }>,
): ApplyKeyResult => {
  switch (key.name) {
    case 'enter':
      // Shift+Enter inserts a newline; plain Enter submits non-empty
      // input. Empty buffer + Enter is a no-op (doesn't bubble as a
      // submit signal — pressing Enter at an empty prompt should not
      // round-trip through the harness).
      if (key.shift) return { next: insertText(input, '\n') };
      if (input.value === '') return NOOP(input);
      return { next: input, submit: { text: input.value } };

    case 'backspace':
      return { next: deleteRange(input, stepBack(input.value, input.cursor), input.cursor) };

    case 'delete':
      return { next: deleteRange(input, input.cursor, stepForward(input.value, input.cursor)) };

    case 'left':
      if (key.ctrl || key.alt) return { next: { ...input, cursor: prevWordBoundary(input) } };
      return { next: { ...input, cursor: Math.max(0, input.cursor - 1) } };

    case 'right':
      if (key.ctrl || key.alt) return { next: { ...input, cursor: nextWordBoundary(input) } };
      return { next: { ...input, cursor: Math.min(input.value.length, input.cursor + 1) } };

    case 'home':
      return { next: { ...input, cursor: lineStart(input) } };

    case 'end':
      return { next: { ...input, cursor: lineEnd(input) } };

    case 'up': {
      // Up: move cursor one visual line up (same column when possible).
      // Multi-line input only — single line: jump to start of buffer.
      const next = moveCursorVertical(input, -1);
      return { next };
    }

    case 'down': {
      const next = moveCursorVertical(input, +1);
      return { next };
    }

    case 'tab':
      // Tab is reserved for slash-command autocomplete (lands later).
      // No-op in the editor for now — autocomplete will intercept
      // before this layer sees the key.
      return NOOP(input);

    case 'escape':
      // Single escape = soft interrupt request. Caller ignores when
      // not running. We do NOT clear the buffer.
      return { next: input, interruptSoft: true };

    case 'space':
      return { next: insertText(input, ' ') };

    default:
      return NOOP(input);
  }
};

// ─── Cursor / word helpers ───────────────────────────────────────────────

// Start of the line that contains the cursor. Multi-line aware: scans
// back to the previous '\n' (or 0 if none).
const lineStart = (input: InputState): number => {
  const before = input.value.slice(0, input.cursor);
  const nl = before.lastIndexOf('\n');
  return nl === -1 ? 0 : nl + 1;
};

// End of the line that contains the cursor.
const lineEnd = (input: InputState): number => {
  const idx = input.value.indexOf('\n', input.cursor);
  return idx === -1 ? input.value.length : idx;
};

// Word boundary jumps. Word = run of non-whitespace chars; boundary
// is the position after the last whitespace before / at the cursor.
const isWordChar = (c: string): boolean => c !== ' ' && c !== '\t' && c !== '\n';

const prevWordBoundary = (input: InputState): number => {
  let i = input.cursor;
  // Walk over any trailing whitespace.
  while (i > 0 && !isWordChar(input.value[i - 1] ?? '')) i--;
  // Walk over the word itself.
  while (i > 0 && isWordChar(input.value[i - 1] ?? '')) i--;
  return i;
};

const nextWordBoundary = (input: InputState): number => {
  let i = input.cursor;
  // Walk over leading whitespace.
  while (i < input.value.length && !isWordChar(input.value[i] ?? '')) i++;
  // Walk over the word.
  while (i < input.value.length && isWordChar(input.value[i] ?? '')) i++;
  return i;
};

// Move cursor up/down one visual line, preserving column where
// possible. Used by Up/Down arrows.
const moveCursorVertical = (input: InputState, direction: -1 | 1): InputState => {
  const lines = input.value.split('\n');
  const { line, col } = cursorRowCol(input.value, input.cursor);
  const targetLine = line + direction;
  if (targetLine < 0) {
    // Above first line: move to beginning of buffer (matches readline).
    return { ...input, cursor: 0 };
  }
  if (targetLine >= lines.length) {
    // Below last line: move to end of buffer.
    return { ...input, cursor: input.value.length };
  }
  const target = lines[targetLine] ?? '';
  // Compute absolute offset of the target line's start.
  let offset = 0;
  for (let i = 0; i < targetLine; i++) offset += (lines[i] ?? '').length + 1;
  // Clamp the column to the target line's length.
  const newCol = Math.min(col, target.length);
  return { ...input, cursor: offset + newCol };
};

// Decompose absolute cursor offset into (line, col).
const cursorRowCol = (value: string, cursor: number): { line: number; col: number } => {
  const before = value.slice(0, cursor);
  const lines = before.split('\n');
  return {
    line: lines.length - 1,
    col: lines[lines.length - 1]?.length ?? 0,
  };
};
