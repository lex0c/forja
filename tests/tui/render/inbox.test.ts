import { describe, expect, test } from 'bun:test';
import { renderQueued } from '../../../src/tui/render/inbox.ts';
import { CSI, type Capabilities, SGR } from '../../../src/tui/term.ts';

// color:'none' proves SGR 7 (reverse) is emitted as an attribute, not
// a color — same invariant the user-submit bar relies on.
const caps: Capabilities = { isTTY: true, cols: 20, rows: 24, color: 'none', unicode: true };

describe('renderQueued (INBOX §6 — queued bars)', () => {
  test('empty queue renders nothing (section collapses)', () => {
    expect(renderQueued([], caps)).toEqual([]);
  });

  test('a queued item becomes a reverse bar carrying the `> ` prompt', () => {
    const out = renderQueued([{ id: '0', text: 'hi' }], caps);
    expect(out).toHaveLength(1);
    expect(out[0]?.startsWith(`${CSI}7m`)).toBe(true);
    expect(out[0]).toContain('> hi');
  });

  test('returns BARE reversed content — no frame margin (appendBlock adds it)', () => {
    const out = renderQueued([{ id: '0', text: 'hi' }], caps);
    // Starts with the reverse SGR directly, not 2 spaces of margin.
    expect(out[0]?.startsWith('  ')).toBe(false);
  });

  test('padded to frame width (cols - 2)', () => {
    const out = renderQueued([{ id: '0', text: 'hi' }], caps);
    // reverse() wraps as `${CSI}7m<padded>${SGR.reset}`; strip the
    // known prefix/suffix (no regex — avoids a control char in source).
    const bar = out[0] ?? '';
    const visible = bar.slice(`${CSI}7m`.length, bar.length - SGR.reset.length);
    expect(visible).toBe(`> hi${' '.repeat(caps.cols - 2 - '> hi'.length)}`);
    expect(visible).toHaveLength(caps.cols - 2);
  });

  test('accumulates one bar per item, FIFO', () => {
    const out = renderQueued(
      [
        { id: '0', text: 'one' },
        { id: '1', text: 'two' },
      ],
      caps,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('> one');
    expect(out[1]).toContain('> two');
  });

  test('multi-line item indents continuation lines like user-submit', () => {
    const out = renderQueued([{ id: '0', text: 'a\nb' }], caps);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('> a');
    expect(out[1]).toContain('  b');
  });
});
