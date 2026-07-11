import { describe, expect, test } from 'bun:test';
import { createKeyParser, type KeyEvent } from '../../src/tui/keys.ts';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from '../../src/tui/term.ts';

const feed = (input: string): KeyEvent[] => createKeyParser().feed(input);

describe('input shapes', () => {
  test('Buffer input is decoded to chars', () => {
    const parser = createKeyParser();
    const events = parser.feed(Buffer.from('\x1b[A', 'utf8'));
    expect(events).toEqual([
      { kind: 'key', name: 'up', ctrl: false, alt: false, shift: false, raw: '\x1b[A' },
    ]);
  });

  test('UTF-8 codepoint split across two Buffer feeds reassembles', () => {
    // 'é' is 0xc3 0xa9 in UTF-8. If we feed only 0xc3, the stateful
    // decoder must hold it; the next feed delivering 0xa9 yields 'é'.
    const parser = createKeyParser();
    expect(parser.feed(Buffer.from([0xc3]))).toEqual([]);
    const events = parser.feed(Buffer.from([0xa9]));
    expect(events).toEqual([{ kind: 'char', char: 'é', ctrl: false, alt: false, raw: 'é' }]);
  });

  test('emoji split across feeds reassembles into one event', () => {
    // '🚀' = U+1F680 = F0 9F 9A 80 in UTF-8. Split it 2/2.
    const parser = createKeyParser();
    expect(parser.feed(Buffer.from([0xf0, 0x9f]))).toEqual([]);
    const events = parser.feed(Buffer.from([0x9a, 0x80]));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('char');
    if (events[0]?.kind === 'char') expect(events[0].char).toBe('🚀');
  });
});

describe('printable characters', () => {
  test('lowercase ASCII letter', () => {
    expect(feed('a')).toEqual([{ kind: 'char', char: 'a', ctrl: false, alt: false, raw: 'a' }]);
  });

  test('uppercase letter is just the char', () => {
    // Terminal sends raw 'A' for shift+a — shift modifier is implicit
    // in the casing. We don't synthesize shift=true.
    expect(feed('A')).toEqual([{ kind: 'char', char: 'A', ctrl: false, alt: false, raw: 'A' }]);
  });

  test('multibyte UTF-8 codepoint surfaces as single char', () => {
    const events = feed('é');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'char', char: 'é', ctrl: false, alt: false, raw: 'é' });
  });

  test('emoji (surrogate pair codepoint) surfaces as single char', () => {
    const events = feed('🚀');
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('char');
    if (events[0]?.kind === 'char') expect(events[0].char).toBe('🚀');
  });

  test('multiple chars in one feed', () => {
    const events = feed('abc');
    expect(events).toHaveLength(3);
    expect(events.map((e) => (e.kind === 'char' ? e.char : ''))).toEqual(['a', 'b', 'c']);
  });
});

describe('control bytes', () => {
  test('Enter (CR)', () => {
    expect(feed('\r')[0]).toMatchObject({ kind: 'key', name: 'enter' });
  });

  test('Enter (LF) is also normalized to enter', () => {
    expect(feed('\n')[0]).toMatchObject({ kind: 'key', name: 'enter' });
  });

  test('Tab', () => {
    expect(feed('\t')[0]).toMatchObject({ kind: 'key', name: 'tab' });
  });

  test('Backspace (DEL byte 0x7f)', () => {
    expect(feed('\x7f')[0]).toMatchObject({ kind: 'key', name: 'backspace' });
  });

  test('Backspace (legacy 0x08)', () => {
    expect(feed('\x08')[0]).toMatchObject({ kind: 'key', name: 'backspace' });
  });

  test('Space', () => {
    expect(feed(' ')[0]).toMatchObject({ kind: 'key', name: 'space' });
  });

  test('Ctrl+A (0x01) → ctrl=true, char=a', () => {
    expect(feed('\x01')[0]).toEqual({
      kind: 'char',
      char: 'a',
      ctrl: true,
      alt: false,
      raw: '\x01',
    });
  });

  test('Ctrl+R (0x12)', () => {
    const ev = feed('\x12')[0];
    expect(ev).toMatchObject({ kind: 'char', char: 'r', ctrl: true });
  });
});

describe('escape sequences', () => {
  test('Up arrow (CSI A)', () => {
    expect(feed('\x1b[A')[0]).toMatchObject({ kind: 'key', name: 'up', ctrl: false });
  });

  test('Down arrow', () => {
    expect(feed('\x1b[B')[0]).toMatchObject({ kind: 'key', name: 'down' });
  });

  test('Right arrow with Ctrl modifier', () => {
    // xterm encodes Ctrl as modifier 5 → param "1;5".
    expect(feed('\x1b[1;5C')[0]).toMatchObject({ kind: 'key', name: 'right', ctrl: true });
  });

  test('Shift+Tab via CSI Z', () => {
    expect(feed('\x1b[Z')[0]).toMatchObject({ kind: 'key', name: 'tab', shift: true });
  });

  test('Home and End via tilde-form (CSI 1~ / CSI 4~)', () => {
    expect(feed('\x1b[1~')[0]).toMatchObject({ kind: 'key', name: 'home' });
    expect(feed('\x1b[4~')[0]).toMatchObject({ kind: 'key', name: 'end' });
  });

  test('Delete (CSI 3~)', () => {
    expect(feed('\x1b[3~')[0]).toMatchObject({ kind: 'key', name: 'delete' });
  });

  test('PageUp / PageDown', () => {
    expect(feed('\x1b[5~')[0]).toMatchObject({ kind: 'key', name: 'pageup' });
    expect(feed('\x1b[6~')[0]).toMatchObject({ kind: 'key', name: 'pagedown' });
  });

  test('F1 via SS3 (ESC O P)', () => {
    expect(feed('\x1bOP')[0]).toMatchObject({ kind: 'key', name: 'f1' });
  });

  test('F5 via tilde-form', () => {
    expect(feed('\x1b[15~')[0]).toMatchObject({ kind: 'key', name: 'f5' });
  });

  test('F12 via tilde-form', () => {
    expect(feed('\x1b[24~')[0]).toMatchObject({ kind: 'key', name: 'f12' });
  });

  test('Alt+letter (ESC + char)', () => {
    expect(feed('\x1bb')[0]).toEqual({
      kind: 'char',
      char: 'b',
      ctrl: false,
      alt: true,
      raw: '\x1bb',
    });
  });

  test('ESC ESC emits one escape, leaves the rest for the next consume', () => {
    const parser = createKeyParser();
    const events = parser.feed('\x1b\x1b');
    // After feed: we expect one escape; the second ESC stays buffered
    // (lone ESC is ambiguous). Drain resolves it.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ kind: 'key', name: 'escape' });
    const drained = parser.drain();
    expect(drained[0]).toMatchObject({ kind: 'key', name: 'escape' });
  });

  test('lone ESC is buffered until drain', () => {
    const parser = createKeyParser();
    expect(parser.feed('\x1b')).toEqual([]);
    expect(parser.bufferLength()).toBe(1);
    const drained = parser.drain();
    expect(drained[0]).toMatchObject({ kind: 'key', name: 'escape' });
    expect(parser.bufferLength()).toBe(0);
  });

  describe('tryResolveLoneEsc', () => {
    test('emits Escape and clears buffer when buf is exactly \\x1b', () => {
      const parser = createKeyParser();
      parser.feed('\x1b');
      const out = parser.tryResolveLoneEsc();
      expect(out).toEqual([
        { kind: 'key', name: 'escape', ctrl: false, alt: false, shift: false, raw: '\x1b' },
      ]);
      expect(parser.bufferLength()).toBe(0);
    });

    test('no-op on empty buffer', () => {
      const parser = createKeyParser();
      expect(parser.tryResolveLoneEsc()).toEqual([]);
      expect(parser.bufferLength()).toBe(0);
    });

    test('no-op on multi-byte ESC prefix (CSI in flight)', () => {
      // `\x1b[` is the leader of a CSI sequence. The next feed is
      // expected to bring params + final byte. tryResolveLoneEsc
      // must NOT eat the `\x1b` because doing so would orphan the
      // `[` and the next feed would fail to parse the sequence.
      const parser = createKeyParser();
      parser.feed('\x1b[');
      expect(parser.tryResolveLoneEsc()).toEqual([]);
      expect(parser.bufferLength()).toBe(2);
      // Subsequent feed completes the sequence.
      expect(parser.feed('A')).toEqual([
        { kind: 'key', name: 'up', ctrl: false, alt: false, shift: false, raw: '\x1b[A' },
      ]);
    });

    test('no-op while paste is in flight (does not truncate paste content)', () => {
      // Regression: previously the idle drain timer in repl.ts
      // called `parser.drain()` whenever bufferLength > 0, which
      // unconditionally cleared pasteActive + pasteBuf. A paste
      // delivered in chunks separated by > ESC_DRAIN_MS (slow SSH,
      // large clipboard payloads) got truncated, and subsequent
      // bytes were parsed as keystrokes — silently corrupting
      // submitted input. tryResolveLoneEsc must leave paste state
      // alone.
      const parser = createKeyParser();
      // Open the paste, deliver some content, but no end marker yet.
      // Keep the trailing buffer length within the safety window so
      // bufferLength() > 0 and the timer would fire.
      parser.feed('\x1b[200~hello world');
      const lenBeforeIdle = parser.bufferLength();
      // Idle drain fires.
      expect(parser.tryResolveLoneEsc()).toEqual([]);
      // Buffer untouched.
      expect(parser.bufferLength()).toBe(lenBeforeIdle);
      // Finish the paste. The accumulated content survived.
      const out = parser.feed('!\x1b[201~');
      expect(out).toEqual([{ kind: 'paste', text: 'hello world!' }]);
    });
  });

  test('split CSI across two feeds', () => {
    const parser = createKeyParser();
    expect(parser.feed('\x1b[')).toEqual([]);
    expect(parser.feed('A')).toEqual([
      { kind: 'key', name: 'up', ctrl: false, alt: false, shift: false, raw: '\x1b[A' },
    ]);
  });

  test('unknown CSI sequence is dropped silently and does not block following input', () => {
    // CSI 99 ~ is a tilde-form code we don't map; the parser must
    // consume the whole sequence (no event) and then process the
    // trailing 'a' normally on the next tick.
    const parser = createKeyParser();
    const events = parser.feed('\x1b[99~a');
    expect(events.some((e) => e.kind === 'char' && e.char === 'a')).toBe(true);
    expect(events.some((e) => e.kind === 'key')).toBe(false);
  });
});

describe('bracketed paste', () => {
  test('paste content between markers becomes one paste event', () => {
    const input = `${BRACKETED_PASTE_START}hello world${BRACKETED_PASTE_END}`;
    const events = feed(input);
    expect(events).toEqual([{ kind: 'paste', text: 'hello world' }]);
  });

  test('paste split across multiple feeds is reassembled', () => {
    const parser = createKeyParser();
    parser.feed(BRACKETED_PASTE_START);
    parser.feed('first chunk ');
    parser.feed('second chunk');
    const events = parser.feed(BRACKETED_PASTE_END);
    expect(events).toEqual([{ kind: 'paste', text: 'first chunk second chunk' }]);
  });

  test('paste with embedded newline is preserved verbatim', () => {
    const events = feed(`${BRACKETED_PASTE_START}line1\nline2${BRACKETED_PASTE_END}`);
    expect(events).toEqual([{ kind: 'paste', text: 'line1\nline2' }]);
  });

  test('paste with bare CR (xterm-style newline) is normalized to LF', () => {
    // xterm and many terminals emit `\r` for line breaks inside
    // bracketed paste content (Enter convention). Without the
    // parser-side normalization the buffer would land `\r` in the
    // input and the renderer would interpret it as carriage-return
    // mid-line, visually collapsing the multi-line paste.
    const events = feed(`${BRACKETED_PASTE_START}line1\rline2\rline3${BRACKETED_PASTE_END}`);
    expect(events).toEqual([{ kind: 'paste', text: 'line1\nline2\nline3' }]);
  });

  test('paste with CRLF (Windows-origin) is normalized to single LF', () => {
    // Replacing bare CR after CRLF would split a single line break
    // into two — the parser does CRLF first, then bare CR.
    const events = feed(`${BRACKETED_PASTE_START}line1\r\nline2\r\nline3${BRACKETED_PASTE_END}`);
    expect(events).toEqual([{ kind: 'paste', text: 'line1\nline2\nline3' }]);
  });

  test('paste with mixed CR / LF / CRLF normalizes consistently', () => {
    const events = feed(`${BRACKETED_PASTE_START}a\rb\nc\r\nd${BRACKETED_PASTE_END}`);
    expect(events).toEqual([{ kind: 'paste', text: 'a\nb\nc\nd' }]);
  });

  test('paste end marker buffered: incoming chunk holds partial end', () => {
    // Feed the start marker, some content, then a prefix of the end
    // marker — the parser must NOT emit yet (would lose the marker
    // bytes if it did) and must complete on the next feed.
    const parser = createKeyParser();
    parser.feed(BRACKETED_PASTE_START);
    parser.feed('abc\x1b[20'); // first 4 bytes of end marker (\x1b[201~)
    expect(parser.feed('1~')).toEqual([{ kind: 'paste', text: 'abc' }]);
  });

  test('keystrokes after paste end resume normal parsing', () => {
    const events = feed(`${BRACKETED_PASTE_START}x${BRACKETED_PASTE_END}\r`);
    expect(events).toEqual([
      { kind: 'paste', text: 'x' },
      { kind: 'key', name: 'enter', ctrl: false, alt: false, shift: false, raw: '\r' },
    ]);
  });
});
