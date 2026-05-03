import { describe, expect, test } from 'bun:test';
import { renderSlashPopover } from '../../../src/tui/render/slash-popover.ts';
import type { SlashAutocomplete } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const colored: Capabilities = { ...caps, color: 'basic' };

const slash = (
  suggestions: { name: string; description: string }[],
  selectedIdx = 0,
): SlashAutocomplete => ({ suggestions, selectedIdx });

describe('renderSlashPopover', () => {
  test('renders one row per suggestion with cursor on selectedIdx', () => {
    const out = renderSlashPopover(
      slash([
        { name: 'help', description: 'show help' },
        { name: 'quit', description: 'exit' },
      ]),
      caps,
    );
    expect(out).toHaveLength(2);
    // Cursor `>` on row 0 (selectedIdx=0); space on row 1.
    expect(out[0]).toMatch(/^ {2}> \/help/);
    expect(out[1]).toMatch(/^ {2} {2}\/quit/);
  });

  test('cursor moves with selectedIdx', () => {
    const out = renderSlashPopover(
      slash(
        [
          { name: 'a', description: 'a' },
          { name: 'b', description: 'b' },
          { name: 'c', description: 'c' },
        ],
        2,
      ),
      caps,
    );
    expect(out[0]).toMatch(/^ {2} {2}\/a/);
    expect(out[2]).toMatch(/^ {2}> \/c/);
  });

  test('names are padded to align descriptions', () => {
    const out = renderSlashPopover(
      slash([
        { name: 'x', description: 'desc-A' },
        { name: 'longer', description: 'desc-B' },
      ]),
      caps,
    );
    // `x` is padded to 6 chars (length of `longer`); descriptions
    // start at the same column on both rows.
    const idx0 = (out[0] ?? '').indexOf('desc-A');
    const idx1 = (out[1] ?? '').indexOf('desc-B');
    expect(idx0).toBe(idx1);
    expect(idx0).toBeGreaterThan(0);
  });

  test('shows "(no matches)" placeholder when suggestions empty', () => {
    const out = renderSlashPopover(slash([], -1), caps);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('(no matches');
  });

  test('caps visible items at 8; shows "(N more)" footer when overflowing', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `cmd${i}`,
      description: `desc ${i}`,
    }));
    const out = renderSlashPopover(slash(ten, 0), caps);
    // 8 rows + 1 footer.
    expect(out).toHaveLength(9);
    expect(out[8]).toContain('(2 more');
  });

  test('windows the visible slice so highlighted row stays visible', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `cmd${i}`,
      description: `desc ${i}`,
    }));
    // Highlight the LAST one (idx 9); window should slide so cmd9 is
    // the bottom-most visible row.
    const out = renderSlashPopover(slash(ten, 9), caps);
    expect(out).toHaveLength(9); // 8 rows + footer
    // Find the highlighted row: starts with "  > /<name>".
    const cursorRow = out.findIndex((l) => l.startsWith('  > '));
    expect(cursorRow).toBeGreaterThanOrEqual(0);
    expect(out[cursorRow]).toContain('cmd9');
  });

  test('lines use dim SGR when color enabled', () => {
    const out = renderSlashPopover(slash([{ name: 'help', description: 'show help' }]), colored);
    expect(out[0]).toContain(`${CSI}2m`);
  });
});
