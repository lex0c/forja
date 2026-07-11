import { describe, expect, test } from 'bun:test';
import {
  renderSlashPopover,
  slashPopoverLineCount,
} from '../../../src/tui/render/slash-popover.ts';
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
  test('colored terminals: every row starts at col 0 with no glyph (color carries selection)', () => {
    const out = renderSlashPopover(
      slash([
        { name: 'help', description: 'show help' },
        { name: 'quit', description: 'exit' },
      ]),
      colored,
    );
    expect(out).toHaveLength(2);
    // No `>` cursor — selection comes from accent vs secondary
    // SGR (asserted in the color tests below). Rows live at col 0
    // — the popover sits below the input block, which is also
    // edge-to-edge (UI.md §6.3 input-block exception). After
    // stripping the leading SGR escape, the next char is `/`.
    expect(out[0]).toMatch(new RegExp(`^${CSI.replace('[', '\\[')}[0-9;]+m/help`));
    expect(out[1]).toMatch(new RegExp(`^${CSI.replace('[', '\\[')}[0-9;]+m/quit`));
  });

  test('no-color terminals: selected row gets `> ` glyph; unselected gets `  ` (NO_COLOR fallback)', () => {
    // Without color, accent vs secondary collapses to plain text
    // and the operator can't tell which suggestion Enter will
    // execute. The fallback glyph keeps selection legible — same
    // shape the modal uses for its option cursor, consistent
    // affordance across the TUI.
    const out = renderSlashPopover(
      slash(
        [
          { name: 'help', description: 'show help' },
          { name: 'quit', description: 'exit' },
        ],
        0,
      ),
      caps,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^> \/help/);
    // Unselected row uses 2sp so the `/name` column stays aligned
    // with the selected row's `/name`.
    expect(out[1]).toMatch(/^ {2}\/quit/);
  });

  test('no-color terminals: glyph moves with selectedIdx', () => {
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
    expect(out[0]).toMatch(/^ {2}\/a/);
    expect(out[1]).toMatch(/^ {2}\/b/);
    expect(out[2]).toMatch(/^> \/c/);
  });

  test('colored terminals never carry the glyph (clean col-0 layout)', () => {
    // Defense against regressing the fallback into "always on" —
    // the tight col-0 layout is the iteration's chosen UX for
    // colored terminals.
    const out = renderSlashPopover(slash([{ name: 'help', description: 'show help' }], 0), colored);
    // Strip ANSI escapes; the content should start with `/`, not
    // with `> ` or `  `. Source the CSI literal from term.ts so this
    // assertion travels with any future CSI prefix change.
    const ansiStripper = new RegExp(`${CSI.replace('[', '\\[')}[0-9;]*m`, 'g');
    const stripped = (out[0] ?? '').replace(ansiStripper, '');
    expect(stripped).toMatch(/^\/help/);
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
    // the bottom-most visible row. Highlight is now identified by the
    // `accent` SGR (94, terminal blue) — that's the only signal in
    // the absence of a cursor glyph.
    const out = renderSlashPopover(slash(ten, 9), colored);
    expect(out).toHaveLength(9); // 8 rows + footer
    const cursorRow = out.findIndex((l) => l.includes(`${CSI}94m`));
    expect(cursorRow).toBeGreaterThanOrEqual(0);
    expect(out[cursorRow]).toContain('cmd9');
  });

  test('selected row uses accent SGR; unselected rows use secondary', () => {
    // Selection is conveyed by color alone (no `>` glyph). Accent
    // (SGR 94, terminal blue) marks the selected row; every other
    // visible row gets `secondary` (SGR 90, grey). Both colors come
    // from term.ts SGR — keeping the assertion on the raw codes
    // means a future palette tweak trips this test before it ships.
    const out = renderSlashPopover(
      slash(
        [
          { name: 'a', description: 'a' },
          { name: 'b', description: 'b' },
          { name: 'c', description: 'c' },
        ],
        1,
      ),
      colored,
    );
    expect(out[0]).toContain(`${CSI}90m`);
    expect(out[1]).toContain(`${CSI}94m`);
    expect(out[2]).toContain(`${CSI}90m`);
  });

  test('placeholder row uses secondary SGR when color enabled', () => {
    const out = renderSlashPopover(slash([], -1), colored);
    expect(out[0]).toContain(`${CSI}90m`);
  });

  test('overflow footer hint uses secondary SGR when color enabled', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `cmd${i}`,
      description: `desc ${i}`,
    }));
    const out = renderSlashPopover(slash(ten, 0), colored);
    expect(out[8]).toContain(`${CSI}90m`);
    expect(out[8]).toContain('2 more');
  });
});

describe('slashPopoverLineCount', () => {
  // Source of truth for compose.ts: count must match what
  // renderSlashPopover actually emits, otherwise composeCursor's row
  // math drifts and the cursor lands on a popover line instead of the
  // input. Each branch of renderSlashPopover gets its own assertion
  // here so a drift in either path trips the test.
  test('1 line when no suggestions (placeholder row)', () => {
    expect(slashPopoverLineCount(slash([], -1))).toBe(1);
  });

  test('one line per suggestion when under the cap', () => {
    const three = Array.from({ length: 3 }, (_, i) => ({ name: `c${i}`, description: `d${i}` }));
    expect(slashPopoverLineCount(slash(three, 0))).toBe(3);
  });

  test('caps at 8 visible rows + 1 footer when overflowing', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, description: `d${i}` }));
    expect(slashPopoverLineCount(slash(ten, 0))).toBe(9);
  });

  test('matches the actual render output length', () => {
    // Belt-and-suspenders: cross-check across all three branches.
    const empty = slash([], -1);
    const small = slash(
      [
        { name: 'a', description: 'a' },
        { name: 'b', description: 'b' },
      ],
      0,
    );
    const overflow = slash(
      Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, description: `d${i}` })),
      0,
    );
    expect(slashPopoverLineCount(empty)).toBe(renderSlashPopover(empty, caps).length);
    expect(slashPopoverLineCount(small)).toBe(renderSlashPopover(small, caps).length);
    expect(slashPopoverLineCount(overflow)).toBe(renderSlashPopover(overflow, caps).length);
  });
});
