import { describe, expect, test } from 'bun:test';
import { applyKey } from '../../src/tui/input-editor.ts';
import type { KeyEvent, KeyName } from '../../src/tui/keys.ts';
import type { InputState } from '../../src/tui/state.ts';

const empty = (): InputState => ({ value: '', cursor: 0 });

const at = (value: string, cursor: number): InputState => ({ value, cursor });

const ch = (char: string, mods: { ctrl?: boolean; alt?: boolean } = {}): KeyEvent => ({
  kind: 'char',
  char,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  raw: char,
});

const named = (
  name: KeyName,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyEvent => ({
  kind: 'key',
  name,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
  raw: '',
});

describe('printable insertion', () => {
  test('typing a char appends and advances cursor', () => {
    const r = applyKey(empty(), ch('a'));
    expect(r.next).toEqual({ value: 'a', cursor: 1 });
    expect(r.submit).toBeUndefined();
  });

  test('typing in the middle inserts at cursor', () => {
    const r = applyKey(at('hello', 2), ch('X'));
    expect(r.next).toEqual({ value: 'heXllo', cursor: 3 });
  });

  test('space key inserts a space at cursor', () => {
    const r = applyKey(at('hi', 2), named('space'));
    expect(r.next).toEqual({ value: 'hi ', cursor: 3 });
  });
});

describe('bracketed paste', () => {
  test('paste inserts the whole text and advances cursor by length', () => {
    const r = applyKey(at('a|b', 2), { kind: 'paste', text: 'XY' });
    expect(r.next).toEqual({ value: 'a|XYb', cursor: 4 });
  });

  test('paste with embedded newline preserved', () => {
    const r = applyKey(empty(), { kind: 'paste', text: 'line1\nline2' });
    expect(r.next).toEqual({ value: 'line1\nline2', cursor: 11 });
  });
});

describe('backspace and delete', () => {
  test('backspace removes char before cursor', () => {
    const r = applyKey(at('hello', 5), named('backspace'));
    expect(r.next).toEqual({ value: 'hell', cursor: 4 });
  });

  test('backspace at start is a no-op', () => {
    const r = applyKey(at('hello', 0), named('backspace'));
    expect(r.next).toEqual({ value: 'hello', cursor: 0 });
  });

  test('delete removes char after cursor', () => {
    const r = applyKey(at('hello', 1), named('delete'));
    expect(r.next).toEqual({ value: 'hllo', cursor: 1 });
  });

  test('delete at end is a no-op', () => {
    const r = applyKey(at('hello', 5), named('delete'));
    expect(r.next).toEqual({ value: 'hello', cursor: 5 });
  });

  test('Ctrl+H also acts as backspace (legacy mapping)', () => {
    const r = applyKey(at('hello', 5), ch('h', { ctrl: true }));
    expect(r.next).toEqual({ value: 'hell', cursor: 4 });
  });
});

describe('cursor movement', () => {
  test('left moves one position back, clamped to 0', () => {
    expect(applyKey(at('abc', 2), named('left')).next).toEqual({ value: 'abc', cursor: 1 });
    expect(applyKey(at('abc', 0), named('left')).next).toEqual({ value: 'abc', cursor: 0 });
  });

  test('right moves one position forward, clamped to length', () => {
    expect(applyKey(at('abc', 1), named('right')).next).toEqual({ value: 'abc', cursor: 2 });
    expect(applyKey(at('abc', 3), named('right')).next).toEqual({ value: 'abc', cursor: 3 });
  });

  test('home jumps to start of line (multi-line aware)', () => {
    expect(applyKey(at('abc', 3), named('home')).next.cursor).toBe(0);
    expect(applyKey(at('abc\ndef', 6), named('home')).next.cursor).toBe(4);
  });

  test('end jumps to end of line (multi-line aware)', () => {
    expect(applyKey(at('abc\ndef', 1), named('end')).next.cursor).toBe(3);
    expect(applyKey(at('abc\ndef', 5), named('end')).next.cursor).toBe(7);
  });

  test('Ctrl+A is the same as Home; Ctrl+E the same as End', () => {
    expect(applyKey(at('abc\ndef', 6), ch('a', { ctrl: true })).next.cursor).toBe(4);
    expect(applyKey(at('abc\ndef', 1), ch('e', { ctrl: true })).next.cursor).toBe(3);
  });

  test('Ctrl+Left jumps to previous word boundary', () => {
    const r = applyKey(at('foo bar baz', 8), named('left', { ctrl: true }));
    expect(r.next.cursor).toBe(4);
  });

  test('Ctrl+Right jumps to next word boundary', () => {
    const r = applyKey(at('foo bar baz', 4), named('right', { ctrl: true }));
    expect(r.next.cursor).toBe(7);
  });

  test('Alt+B / Alt+F also jump by word', () => {
    expect(applyKey(at('foo bar', 7), ch('b', { alt: true })).next.cursor).toBe(4);
    expect(applyKey(at('foo bar', 0), ch('f', { alt: true })).next.cursor).toBe(3);
  });
});

describe('multi-line navigation', () => {
  test('up moves cursor one visual line up, preserving column', () => {
    const r = applyKey(at('hello\nworld', 8), named('up'));
    expect(r.next.cursor).toBe(2); // col 2 of "hello"
  });

  test('up at first line goes to start of buffer', () => {
    const r = applyKey(at('abc\ndef', 2), named('up'));
    expect(r.next.cursor).toBe(0);
  });

  test('down moves cursor one visual line down, clamping column', () => {
    const r = applyKey(at('hello\nhi', 4), named('down'));
    expect(r.next.cursor).toBe(8); // clamped to end of "hi" (len 2)
  });

  test('down at last line goes to end of buffer', () => {
    const r = applyKey(at('abc\ndef', 5), named('down'));
    expect(r.next.cursor).toBe(7);
  });
});

describe('line deletion (Ctrl+U / Ctrl+K / Ctrl+W)', () => {
  test('Ctrl+U deletes from cursor to start of line', () => {
    const r = applyKey(at('abcdef', 4), ch('u', { ctrl: true }));
    expect(r.next).toEqual({ value: 'ef', cursor: 0 });
  });

  test('Ctrl+K deletes from cursor to end of line', () => {
    const r = applyKey(at('abcdef', 2), ch('k', { ctrl: true }));
    expect(r.next).toEqual({ value: 'ab', cursor: 2 });
  });

  test('Ctrl+W deletes the previous word', () => {
    const r = applyKey(at('foo bar baz', 7), ch('w', { ctrl: true }));
    expect(r.next).toEqual({ value: 'foo  baz', cursor: 4 });
  });

  test('Ctrl+W at start is a no-op', () => {
    const r = applyKey(empty(), ch('w', { ctrl: true }));
    expect(r.next).toEqual({ value: '', cursor: 0 });
  });

  test('Alt+D deletes the next word', () => {
    const r = applyKey(at('foo bar', 0), ch('d', { alt: true }));
    expect(r.next).toEqual({ value: ' bar', cursor: 0 });
  });
});

describe('Enter and Shift+Enter', () => {
  test('Enter on non-empty buffer signals submit, leaves state intact', () => {
    const r = applyKey(at('hello', 5), named('enter'));
    expect(r.submit).toEqual({ text: 'hello' });
    // Reducer (state.ts) clears the input on `user:submit`; the
    // editor itself does not.
    expect(r.next).toEqual({ value: 'hello', cursor: 5 });
  });

  test('Enter on empty buffer is a no-op (no submit)', () => {
    const r = applyKey(empty(), named('enter'));
    expect(r.submit).toBeUndefined();
    expect(r.next).toEqual({ value: '', cursor: 0 });
  });

  test('Shift+Enter inserts a newline', () => {
    const r = applyKey(at('foo', 3), named('enter', { shift: true }));
    expect(r.next).toEqual({ value: 'foo\n', cursor: 4 });
    expect(r.submit).toBeUndefined();
  });
});

describe('Ctrl+C and Ctrl+D semantics', () => {
  test('Ctrl+C with non-empty buffer clears it (no cancel signal)', () => {
    const r = applyKey(at('abc', 2), ch('c', { ctrl: true }));
    expect(r.next).toEqual({ value: '', cursor: 0 });
    expect(r.cancelInput).toBeUndefined();
  });

  test('Ctrl+C with empty buffer surfaces cancelInput=interrupt (gate-arming signal)', () => {
    const r = applyKey(empty(), ch('c', { ctrl: true }));
    expect(r.cancelInput).toBe('interrupt');
    expect(r.next).toEqual({ value: '', cursor: 0 });
  });

  test('Ctrl+D with empty buffer surfaces cancelInput=eof (direct EOF)', () => {
    const r = applyKey(empty(), ch('d', { ctrl: true }));
    expect(r.cancelInput).toBe('eof');
  });

  test('Ctrl+D with non-empty buffer deletes forward (like Delete)', () => {
    const r = applyKey(at('abc', 1), ch('d', { ctrl: true }));
    expect(r.next).toEqual({ value: 'ac', cursor: 1 });
    expect(r.cancelInput).toBeUndefined();
  });
});

describe('Escape signals interrupt', () => {
  test('Esc surfaces interruptSoft, leaves buffer intact', () => {
    const r = applyKey(at('typing', 6), named('escape'));
    expect(r.interruptSoft).toBe(true);
    expect(r.next).toEqual({ value: 'typing', cursor: 6 });
  });
});

describe('Tab is a no-op (reserved for autocomplete)', () => {
  test('Tab does not modify the buffer or signal anything', () => {
    const r = applyKey(at('/he', 3), named('tab'));
    expect(r.next).toEqual({ value: '/he', cursor: 3 });
    expect(r.submit).toBeUndefined();
  });
});

describe('surrogate-pair safety (emoji / non-BMP)', () => {
  test('backspace removes a full emoji codepoint, not just the low surrogate', () => {
    // 'a🚀b' = 'a' (1 unit) + '🚀' (2 units = surrogate pair) + 'b'
    // (1 unit) = 4 JS code units. Cursor at 3 sits between the
    // emoji's low surrogate and 'b'. Backspace should land at 1
    // and produce 'ab' — NOT delete only the low surrogate and leave
    // an orphan high surrogate behind.
    const r = applyKey({ value: 'a🚀b', cursor: 3 }, named('backspace'));
    expect(r.next).toEqual({ value: 'ab', cursor: 1 });
  });

  test('delete forward removes a full emoji codepoint', () => {
    // 'a🚀b', cursor=1 (between 'a' and the high surrogate). Delete
    // forward should remove the whole emoji, leaving 'ab' cursor=1.
    const r = applyKey({ value: 'a🚀b', cursor: 1 }, named('delete'));
    expect(r.next).toEqual({ value: 'ab', cursor: 1 });
  });

  test('Ctrl+H also operates on full codepoint', () => {
    const r = applyKey({ value: '🎉', cursor: 2 }, ch('h', { ctrl: true }));
    expect(r.next).toEqual({ value: '', cursor: 0 });
  });

  test('Ctrl+D forward-delete operates on full codepoint', () => {
    const r = applyKey({ value: '🎉', cursor: 0 }, ch('d', { ctrl: true }));
    expect(r.next).toEqual({ value: '', cursor: 0 });
  });

  test('CJK characters in BMP delete one unit (no surrogate involved)', () => {
    // '日本' — each kanji is one BMP codepoint, one JS code unit each.
    // Cursor at 1 (after '日'). Backspace removes 1 unit → '本'.
    const r = applyKey({ value: '日本', cursor: 1 }, named('backspace'));
    expect(r.next).toEqual({ value: '本', cursor: 0 });
  });

  test('left arrow steps over a full emoji codepoint, never lands mid-pair', () => {
    // Cursor=3 sits after the emoji (between low surrogate and 'b').
    // Left should jump to position 1 (before the high surrogate),
    // NOT to position 2 (mid-pair) which would corrupt the next
    // insert / delete by splitting the surrogates.
    const r = applyKey({ value: 'a😀b', cursor: 3 }, named('left'));
    expect(r.next).toEqual({ value: 'a😀b', cursor: 1 });
  });

  test('right arrow steps over a full emoji codepoint, never lands mid-pair', () => {
    // Cursor=1 (after 'a', before the high surrogate). Right should
    // jump to position 3 (after the low surrogate), NOT 2.
    const r = applyKey({ value: 'a😀b', cursor: 1 }, named('right'));
    expect(r.next).toEqual({ value: 'a😀b', cursor: 3 });
  });

  test('left arrow at position 0 stays at 0 (no underflow)', () => {
    // Regression: stepBack returns 0 when cursor <= 0, no Math.max
    // needed at the call site.
    const r = applyKey({ value: '😀', cursor: 0 }, named('left'));
    expect(r.next).toEqual({ value: '😀', cursor: 0 });
  });

  test('right arrow at end of buffer stays at length (no overflow)', () => {
    const r = applyKey({ value: '😀', cursor: 2 }, named('right'));
    expect(r.next).toEqual({ value: '😀', cursor: 2 });
  });

  test('left → insert after emoji produces well-formed string (regression cover)', () => {
    // The bug shape: cursor at 3 (after emoji), Left to 2 (mid-pair),
    // then insert 'X' would yield 'a\ud83dX\ude00b' — lone surrogates
    // both ways, breaks any UTF-8 encoder downstream. Post-fix the
    // Left lands at 1, insert lands BEFORE the emoji: 'aX😀b'.
    const left = applyKey({ value: 'a😀b', cursor: 3 }, named('left'));
    const inserted = applyKey(left.next, ch('X'));
    expect(inserted.next.value).toBe('aX😀b');
    // Sanity: no lone surrogates anywhere in the result.
    for (let i = 0; i < inserted.next.value.length; i++) {
      const code = inserted.next.value.charCodeAt(i);
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const isLow = code >= 0xdc00 && code <= 0xdfff;
      if (isHigh) {
        const next = inserted.next.value.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (isLow) {
        const prev = inserted.next.value.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });

  test('CJK BMP arrows still move one code unit (no surrogate to skip)', () => {
    // BMP codepoints fit in one code unit each. stepBack/stepForward
    // should fall through to the cursor ± 1 path without invoking
    // surrogate logic.
    const left = applyKey({ value: '日本', cursor: 2 }, named('left'));
    expect(left.next.cursor).toBe(1);
    const right = applyKey({ value: '日本', cursor: 0 }, named('right'));
    expect(right.next.cursor).toBe(1);
  });
});

describe('immutability', () => {
  test('applyKey does not mutate the input state', () => {
    const input: InputState = { value: 'hello', cursor: 3 };
    const snapshot = { ...input };
    applyKey(input, ch('X'));
    applyKey(input, named('backspace'));
    applyKey(input, named('left'));
    applyKey(input, ch('c', { ctrl: true }));
    expect(input).toEqual(snapshot);
  });
});
