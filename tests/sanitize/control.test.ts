import { describe, expect, test } from 'bun:test';
import {
  collapseBlankLines,
  flattenControlToLine,
  stripControlKeepLines,
} from '../../src/sanitize/index.ts';

// Build a string with a raw control byte without putting it in the source.
const c = (code: number): string => String.fromCharCode(code);
const ESC = c(0x1b);
const BS = c(0x08);
const BEL = c(0x07);

describe('flattenControlToLine (one-line anti-spoof)', () => {
  test('strips ANSI color sequences', () => {
    expect(flattenControlToLine(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  test('flattens embedded newlines so a field cannot forge scrollback rows', () => {
    const out = flattenControlToLine('innocent\n● [system] fake approval');
    expect(out).not.toContain('\n');
    expect(out).toBe('innocent ● [system] fake approval');
  });

  test('removes bare C0 bytes like BS/BEL (stripAnsi drops them) — none survive', () => {
    const out = flattenControlToLine(`good${BS}${BS}${BS}${BS}evil${BEL}!`);
    // stripAnsi removes BS/BEL outright, so the surrounding text joins.
    expect(out).toBe('goodevil!');
    // The real guarantee: no control byte survives into the scrollback.
    expect([...out].every((ch) => ch.charCodeAt(0) > 0x1f)).toBe(true);
  });

  test('collapses runs of control/whitespace to a single space and trims', () => {
    expect(flattenControlToLine('\t\n  hello \r\n  world  \n')).toBe('hello world');
  });

  test('leaves ordinary text untouched', () => {
    expect(flattenControlToLine('rate limit reset at 15:30')).toBe('rate limit reset at 15:30');
  });
});

describe('stripControlKeepLines (multi-line body anti-spoof)', () => {
  test('strips ANSI but KEEPS newlines and tabs (line structure preserved)', () => {
    const out = stripControlKeepLines(`${ESC}[32mPASS${ESC}[0m\n\tline two`);
    expect(out).toBe('PASS\n\tline two');
  });

  test('drops bare C0 control bytes (BS/BEL/CR) but not LF/TAB', () => {
    expect(stripControlKeepLines(`a${BS}b${BEL}\r\nc`)).toBe('ab\nc');
  });
});

describe('collapseBlankLines (anti-flood for untrusted multi-line text)', () => {
  test('collapses a run of blank lines to a single empty line', () => {
    expect(collapseBlankLines('a\n\n\n\n\n\nb')).toBe('a\n\nb');
  });

  test('a pure-newline flood shrinks to a bounded number of rows', () => {
    const out = collapseBlankLines('\n'.repeat(2000));
    expect(out.split('\n').length).toBeLessThanOrEqual(2);
  });

  test('preserves content lines and single blank separators (full fidelity)', () => {
    expect(collapseBlankLines('para one\n\npara two\nline')).toBe('para one\n\npara two\nline');
  });

  test('treats whitespace-only lines as blank', () => {
    expect(collapseBlankLines('a\n   \n\t\n  \nb')).toBe('a\n   \nb');
  });
});
