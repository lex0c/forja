import { describe, expect, test } from 'bun:test';
import { HEAD_TAIL_DEFAULT_LINES, headTailSummary } from '../../src/tools/output-summarizer.ts';

describe('headTailSummary', () => {
  test('passes through when input is at or below maxBytes', () => {
    const out = headTailSummary('one\ntwo\nthree', {
      maxBytes: 1024,
      headLines: 5,
      tailLines: 5,
    });
    expect(out.reduced).toBe(false);
    expect(out.text).toBe('one\ntwo\nthree');
    expect(out.originalBytes).toBe(13);
  });

  test('passes through empty input (no false-positive reduction)', () => {
    const out = headTailSummary('', { maxBytes: 1024, headLines: 5, tailLines: 5 });
    expect(out.reduced).toBe(false);
    expect(out.text).toBe('');
    expect(out.originalBytes).toBe(0);
  });

  test('elides middle when input exceeds maxBytes (many-lines path)', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    const text = lines.join('\n');
    const out = headTailSummary(text, { maxBytes: 100, headLines: 10, tailLines: 10 });
    expect(out.reduced).toBe(true);
    // First 10 + elision marker + last 10
    expect(out.text).toContain('line0');
    expect(out.text).toContain('line9');
    expect(out.text).toContain('line190');
    expect(out.text).toContain('line199');
    expect(out.text).not.toContain('line50');
    expect(out.text).toContain('lines elided');
    expect(out.originalBytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  test('byte-window fallback when input is one giant line', () => {
    // A single 64KB line — line-based head/tail wouldn't reduce
    // anything, so the helper falls back to a byte-window cut.
    const giant = 'x'.repeat(64 * 1024);
    const out = headTailSummary(giant, { maxBytes: 4 * 1024, headLines: 50, tailLines: 50 });
    expect(out.reduced).toBe(true);
    expect(out.text).toContain('dropped');
    // Should be much smaller than the input.
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThan(giant.length);
  });

  test('byte-window fallback handles multi-byte UTF-8 (no duplication, no negative dropped)', () => {
    // `你` = 3 bytes in UTF-8 but 1 UTF-16 code unit. Pre-fix the
    // byte-window used String.prototype.slice which counts code
    // units — for a 6000-char (18 KB) input crossing a 16 KB
    // threshold, `slice(0, 8192)` returned the entire string and
    // the tail slice duplicated part of it, producing a "summary"
    // larger than the input with a negative `dropped` marker.
    const giant = '你'.repeat(6000);
    const originalBytes = Buffer.byteLength(giant, 'utf8');
    expect(originalBytes).toBe(18000);
    const out = headTailSummary(giant, {
      maxBytes: 16 * 1024,
      headLines: 80,
      tailLines: 80,
    });
    expect(out.reduced).toBe(true);
    expect(out.originalBytes).toBe(originalBytes);
    // Result must be smaller than the input — actual reduction, not
    // a degenerate "summary" that's bigger than what it summarizes.
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThan(originalBytes);
    // Dropped marker reports a positive byte count (never negative).
    const droppedMatch = out.text.match(/\[\.\.\. (\d+(?:\.\d+)?)(B|KB|MB) dropped \.\.\.\]/);
    expect(droppedMatch).not.toBeNull();
  });

  test('byte-window slices land on UTF-8 codepoint boundaries (no truncation mid-codepoint)', () => {
    // Mix of ASCII + 3-byte CJK + 4-byte emoji. Slicing without
    // boundary awareness would split a codepoint and emit
    // U+FFFD replacement chars. The boundary helper ensures both
    // head and tail decode back to valid UTF-8.
    const mixed = `${'a'.repeat(8000)}${'你'.repeat(3000)}${'🦊'.repeat(2000)}${'z'.repeat(8000)}`;
    const out = headTailSummary(mixed, {
      maxBytes: 4 * 1024,
      headLines: 50,
      tailLines: 50,
    });
    expect(out.reduced).toBe(true);
    // No U+FFFD (replacement char) in the output — boundary-aware
    // slicing preserved all kept codepoints intact.
    expect(out.text).not.toContain('�');
  });

  test('exposes default head/tail line count for tools to consume', () => {
    expect(HEAD_TAIL_DEFAULT_LINES).toBeGreaterThan(0);
  });

  test('reduced flag false when threshold not crossed even with many lines', () => {
    // Few short lines: bytes well under threshold, line count
    // exceeds head+tail but the byte check fires first and we
    // skip reduction.
    const text = Array.from({ length: 50 }, (_, i) => `${i}`).join('\n');
    const out = headTailSummary(text, { maxBytes: 1024, headLines: 5, tailLines: 5 });
    expect(out.reduced).toBe(false);
  });
});
