import { describe, expect, test } from 'bun:test';
import { sanitizeToolOutput, stripAnsi } from '../../src/sanitize/ansi.ts';

describe('stripAnsi', () => {
  test('removes SGR color sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;33;42mhi\x1b[0m')).toBe('hi');
  });

  test('removes cursor and erase CSI sequences', () => {
    // 2K = clear line; 1A = up one row; H = home — the canonical
    // "rewrite history" injection used to hide what a tool did.
    expect(stripAnsi('\x1b[2K\x1b[1AOK')).toBe('OK');
    expect(stripAnsi('foo\x1b[Hbar')).toBe('foobar');
  });

  test('removes OSC sequences (BEL terminator)', () => {
    // ESC ] 0 ; title BEL — terminal-title manipulation.
    expect(stripAnsi('\x1b]0;malicious title\x07real text')).toBe('real text');
  });

  test('removes OSC sequences (ST terminator)', () => {
    // ESC \ as the string terminator.
    expect(stripAnsi('\x1b]8;;https://evil.example/\x1b\\link\x1b]8;;\x1b\\after')).toBe(
      'linkafter',
    );
  });

  test('removes DCS / APC / PM / SOS sequences', () => {
    // ESC P ... ST — Device Control String.
    expect(stripAnsi('\x1bP1;1|payload\x1b\\rest')).toBe('rest');
    // ESC _ ... ST — Application Program Command (used by some terminals).
    expect(stripAnsi('\x1b_payload\x1b\\rest')).toBe('rest');
  });

  test('removes 7-bit single-char escapes', () => {
    // ESC M (Reverse Index), ESC E (Next Line), ESC c (RIS).
    expect(stripAnsi('a\x1bMb\x1bEc\x1bcd')).toBe('abcd');
  });

  test('removes 8-bit C1 controls', () => {
    expect(stripAnsi('a\x9bb\x9dc')).toBe('abc');
  });

  test('preserves plain text and whitespace', () => {
    expect(stripAnsi('hello world\n\ttab')).toBe('hello world\n\ttab');
    expect(stripAnsi('')).toBe('');
  });

  test('does not strip lone backslash or square bracket', () => {
    expect(stripAnsi('a [foo] b')).toBe('a [foo] b');
    expect(stripAnsi('path/with/[brackets]')).toBe('path/with/[brackets]');
  });

  test('handles malformed escape gracefully (CSI with no final byte)', () => {
    // Incomplete CSI: ESC [ params, then EOF. CSI fails (needs final
    // byte 0x40-0x7E), so the single-char rule fires on `\x1b[`,
    // stripping just those two bytes. Leftover params survive as
    // plain text — which is the conservative call: leaving live ESC
    // bytes is the security risk we're guarding against, while a
    // stray `123;` in output is harmless noise.
    expect(stripAnsi('foo\x1b[123;')).toBe('foo123;');
  });

  test('strips bare ESC bytes that no other pattern consumed', () => {
    // Trailing ESC at end-of-string: previous rules required a
    // following byte. Leaving it would violate the invariant — a
    // downstream concatenation `persisted + nextChunk` where
    // nextChunk starts with `[31m` would reconstitute a live escape.
    expect(stripAnsi('foo\x1b')).toBe('foo');
    // ESC followed by a non-printable that no alternative matches
    // (e.g., \t at 0x09 sits below 0x40 so the single-char rule
    // declines). The bare-ESC fallback strips ESC; the \t survives
    // as the legitimate whitespace it is.
    expect(stripAnsi('foo\x1b\tbar')).toBe('foo\tbar');
    // Two ESCs back to back: the first has no printable byte after
    // it (the second ESC is itself 0x1B, below the 0x40-0x7E
    // single-char range), so the bare-ESC fallback strips it. The
    // second ESC then pairs with the following `b` (0x62, in range)
    // as a legitimate single-char escape and is consumed as a unit.
    expect(stripAnsi('a\x1b\x1bb')).toBe('a');
    // Two ESCs at end-of-string: nothing printable to pair with;
    // the bare-ESC fallback fires twice.
    expect(stripAnsi('end\x1b\x1b')).toBe('end');
    // ESC followed by a sub-0x40 byte (digit `1` is 0x31): single-
    // char declines, bare-ESC strips ESC, digit survives.
    expect(stripAnsi('a\x1b1b')).toBe('a1b');
    // Sanity: structured patterns still match first — a complete
    // CSI is consumed as a unit, not byte-by-byte.
    expect(stripAnsi('a\x1b[31mb\x1b[0m')).toBe('ab');
  });

  test('does not strip tab/newline/CR/null (legitimate whitespace bytes)', () => {
    expect(stripAnsi('\t\n\r')).toBe('\t\n\r');
  });

  test('strips multiple consecutive sequences without merging', () => {
    expect(stripAnsi('\x1b[31m\x1b[1mbold red\x1b[0m\x1b[0m')).toBe('bold red');
  });

  test('strips private-mode CSI with `<` `=` `>` in params', () => {
    // xterm mouse 1006: ESC [ < params M / m. Param byte `<` is in
    // 0x3C and would fall outside a narrow `[0-9;:?]` class — the
    // single-char fallback would only eat `\x1b[`, leaking the body.
    expect(stripAnsi('before\x1b[<0;100;100Mafter')).toBe('beforeafter');
    expect(stripAnsi('\x1b[=1hraw')).toBe('raw');
    expect(stripAnsi('\x1b[>0;276;0c')).toBe('');
  });
});

describe('sanitizeToolOutput', () => {
  test('strips ANSI from string leaves in plain objects', () => {
    const input = {
      stdout: '\x1b[31merror\x1b[0m: file not found',
      stderr: '\x1b[2K\x1b[1Areal stderr',
      exit_code: 1,
    };
    expect(sanitizeToolOutput(input)).toEqual({
      stdout: 'error: file not found',
      stderr: 'real stderr',
      exit_code: 1,
    });
  });

  test('walks nested objects and arrays', () => {
    const input = {
      results: [
        { path: 'a.ts', preview: '\x1b[31mline\x1b[0m' },
        { path: 'b.ts', preview: 'plain' },
      ],
    };
    expect(sanitizeToolOutput(input)).toEqual({
      results: [
        { path: 'a.ts', preview: 'line' },
        { path: 'b.ts', preview: 'plain' },
      ],
    });
  });

  test('preserves non-string primitives unchanged', () => {
    expect(sanitizeToolOutput({ n: 42, b: true, nil: null })).toEqual({
      n: 42,
      b: true,
      nil: null,
    });
  });

  test('returns string input directly with ANSI stripped', () => {
    expect(sanitizeToolOutput('\x1b[31mhi\x1b[0m')).toBe('hi');
  });

  test('returns null/undefined/numbers/booleans unchanged', () => {
    expect(sanitizeToolOutput(null)).toBeNull();
    expect(sanitizeToolOutput(42)).toBe(42);
    expect(sanitizeToolOutput(true)).toBe(true);
    expect(sanitizeToolOutput(undefined)).toBeUndefined();
  });

  test('handles cyclic references without stack overflow', () => {
    const input: Record<string, unknown> = { name: '\x1b[31mfoo\x1b[0m' };
    input.self = input;
    const out = sanitizeToolOutput(input) as Record<string, unknown>;
    expect(out.name).toBe('foo');
    expect(out.self).toBe('<cycle>');
  });

  test('handles cyclic arrays', () => {
    const arr: unknown[] = ['\x1b[31mhi\x1b[0m'];
    arr.push(arr);
    const out = sanitizeToolOutput(arr) as unknown[];
    expect(out[0]).toBe('hi');
    expect(out[1]).toBe('<cycle>');
  });

  test('treats shared (non-cyclic) references as a DAG, not a cycle', () => {
    // The same object referenced from two siblings is NOT a cycle —
    // it's a DAG, which JSON.stringify would happily re-emit twice.
    // Ancestry-only tracking sanitizes both occurrences instead of
    // marking the second as `<cycle>`.
    const shared = { msg: '\x1b[31mhi\x1b[0m' };
    const root = { a: shared, b: shared };
    const out = sanitizeToolOutput(root) as { a: { msg: string }; b: { msg: string } };
    expect(out.a.msg).toBe('hi');
    expect(out.b.msg).toBe('hi');
  });

  test('shared reference inside an array is sanitized at every position', () => {
    const shared = { x: '\x1b[31mhi\x1b[0m' };
    const out = sanitizeToolOutput([shared, shared, shared]) as Array<{ x: string }>;
    expect(out).toHaveLength(3);
    for (const item of out) expect(item.x).toBe('hi');
  });

  test('preserves ToolError discriminator (is_error stays boolean)', () => {
    const input = {
      is_error: true,
      error_code: 'tool.exception',
      error_message: '\x1b[31mtool crashed\x1b[0m: bad input',
      retryable: false,
    };
    const out = sanitizeToolOutput(input) as Record<string, unknown>;
    expect(out.is_error).toBe(true);
    expect(out.error_message).toBe('tool crashed: bad input');
  });

  test('does not mutate the input object', () => {
    const input = { msg: '\x1b[31mhi\x1b[0m' };
    sanitizeToolOutput(input);
    expect(input.msg).toBe('\x1b[31mhi\x1b[0m');
  });
});
