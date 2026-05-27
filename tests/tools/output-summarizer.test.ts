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
