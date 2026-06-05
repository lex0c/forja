import { describe, expect, test } from 'bun:test';
import type { TodoItemForUI } from '../../../src/tui/events.ts';
import { renderTodoList } from '../../../src/tui/render/todo-list.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...caps, unicode: false };

const item = (
  status: TodoItemForUI['status'],
  content: string,
  activeForm?: string,
): TodoItemForUI => ({
  content,
  activeForm: activeForm ?? `${content} (active)`,
  status,
});

describe('renderTodoList', () => {
  test('empty list returns []', () => {
    expect(renderTodoList([], caps, 0)).toEqual([]);
  });

  test('header + one row per item with the canonical glyphs', () => {
    const out = renderTodoList(
      [
        item('done', 'Resolve scope roots'),
        item('in_progress', 'Update bootstrap', 'Updating bootstrap'),
        item('pending', 'Add regression test'),
      ],
      caps,
      0,
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toContain('Tasks');
    expect(out[1]).toContain('✓');
    expect(out[1]).toContain('Resolve scope roots');
    expect(out[2]).toContain('▶');
    // in_progress uses activeForm.
    expect(out[2]).toContain('Updating bootstrap');
    expect(out[2]).not.toContain('Update bootstrap ');
    expect(out[3]).toContain('○');
    expect(out[3]).toContain('Add regression test');
  });

  test('non-progress states render content, not activeForm', () => {
    const out = renderTodoList(
      [item('done', 'Ship it', 'Shipping it'), item('pending', 'Wait', 'Waiting')],
      caps,
      0,
    );
    expect(out[1]).toContain('Ship it');
    expect(out[1]).not.toContain('Shipping it');
    expect(out[2]).toContain('Wait');
    expect(out[2]).not.toContain('Waiting');
  });

  test('ASCII fallback substitutes the bracket glyph set', () => {
    const out = renderTodoList(
      [item('done', 'd'), item('in_progress', 'p', 'P'), item('pending', 'q')],
      ascii,
      0,
    );
    expect(out[1]).toContain('[x]');
    expect(out[2]).toContain('[*]');
    expect(out[3]).toContain('[ ]');
    // No Unicode glyphs leaked through.
    for (const line of out) {
      expect(line).not.toContain('✓');
      expect(line).not.toContain('▶');
      expect(line).not.toContain('○');
    }
  });

  test('list of 5 items renders fully (no truncation)', () => {
    const items = Array.from({ length: 5 }, (_, i) => item('pending', `task ${i}`));
    const out = renderTodoList(items, caps, 0);
    // header + 5 rows; no `(+N more)` suffix.
    expect(out).toHaveLength(6);
    expect(out.some((l) => l.includes('more'))).toBe(false);
  });

  test('over 5 items collapses to running + pending lookahead + (+N more)', () => {
    // 1 in_progress, 12 pending — 13 total.
    const items: TodoItemForUI[] = [
      item('in_progress', 'running thing', 'Running thing'),
      ...Array.from({ length: 12 }, (_, i) => item('pending', `pending ${i}`)),
    ];
    const out = renderTodoList(items, caps, 0);
    // header + running + first 4 pending + `(+N more)` = 7 lines.
    expect(out).toHaveLength(7);
    expect(out[1]).toContain('▶');
    expect(out[1]).toContain('Running thing');
    expect(out[2]).toContain('pending 0');
    expect(out[5]).toContain('pending 3');
    expect(out[6]).toContain('(+8 more)');
  });

  test('all-done list still shows rows (done backfills — block never empty)', () => {
    // Regression: 6/6 done used to collapse to just the header + counter
    // because done was never picked. Now done backfills the visible slice.
    const items = Array.from({ length: 6 }, (_, i) => item('done', `done ${i}`));
    const out = renderTodoList(items, caps, 0);
    // header + 5 done rows + (+1 more) = 7 lines.
    expect(out).toHaveLength(7);
    expect(out[1]).toContain('done 0');
    expect(out[5]).toContain('done 4');
    expect(out[6]).toContain('(+1 more)');
  });

  test('embedded \\n / \\r in content is scrubbed (line-height contract)', () => {
    // The renderer's caller (composeLive → renderer.ts) assumes one
    // input string == one terminal line for liveHeight bookkeeping.
    // Embedded newlines would make `liveHeight = truncated.length`
    // under-count, leaving ghost rows after eraseLive. The todo tools
    // now reject control chars at the source, so this scrub is residual
    // defense — exercised here by calling the renderer directly.
    const out = renderTodoList(
      [item('done', 'first\nsecond\nthird'), item('in_progress', 'x', 'progress\rwith\r\nbreaks')],
      caps,
      0,
    );
    // Header + 2 rows = 3 lines; no extra splits.
    expect(out).toHaveLength(3);
    for (const line of out) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\r');
    }
    expect(out[1]).toContain('first second third');
    expect(out[2]).toContain('progress with breaks');
  });

  test('truncation surfaces in_progress even when beyond position 3', () => {
    // 5 done items, then in_progress at index 5, then 5 pending.
    const items: TodoItemForUI[] = [
      ...Array.from({ length: 5 }, (_, i) => item('done', `done ${i}`)),
      item('in_progress', 'critical', 'Doing critical'),
      ...Array.from({ length: 5 }, (_, i) => item('pending', `pending ${i}`)),
    ];
    const out = renderTodoList(items, caps, 0);
    // header + running + 4 pending + (+N more) = 7 lines.
    expect(out).toHaveLength(7);
    expect(out[1]).toContain('Doing critical');
    expect(out[2]).toContain('pending 0');
    expect(out[5]).toContain('pending 3');
    // 11 total - 5 visible items = 6 hidden.
    expect(out[6]).toContain('(+6 more)');
  });

  test('header is just the status breakdown (no done/total fraction)', () => {
    const out = renderTodoList(
      [item('done', 'a'), item('in_progress', 'b', 'B'), item('pending', 'c'), item('failed', 'd')],
      caps,
      0,
    );
    expect(out[0]).toContain('Tasks (1 pending · 1 in_progress · 1 done · 1 failed)');
    expect(out[0]).not.toContain('1/4'); // the old done/total fraction was dropped
  });

  test('"Tasks" shimmers while a task is in_progress, flat otherwise', () => {
    const color: Capabilities = { ...caps, color: 'basic' };
    // The shimmer paints one accent (SGR 94) char in "Tasks" while a task
    // runs; with nothing in_progress the header is flat `secondary`.
    const active = renderTodoList([item('in_progress', 'x', 'X')], color, 100)[0] ?? '';
    const idle = renderTodoList([item('done', 'x')], color, 100)[0] ?? '';
    expect(active).toContain('[94m');
    expect(idle).not.toContain('[94m');
  });

  test('done rows render in secondary (grey); pending stays dim', () => {
    const color: Capabilities = { ...caps, color: 'basic' };
    // done recedes to `secondary` (SGR 90, visible grey); pending is `dim`
    // (SGR 2) — completed work reads quieter than the not-started ones.
    const done = renderTodoList([item('done', 'finished')], color, 0)[1] ?? '';
    expect(done).toContain('[90m');
    const pending = renderTodoList([item('pending', 'todo')], color, 0)[1] ?? '';
    expect(pending).not.toContain('[90m');
  });

  test('failed status renders ✗ (unicode) / [!] (ascii) — reachable now', () => {
    const u = renderTodoList([item('failed', 'broke it')], caps, 0);
    expect(u[1]).toContain('✗');
    expect(u[1]).toContain('broke it');
    expect(renderTodoList([item('failed', 'broke it')], ascii, 0)[1]).toContain('[!]');
  });

  test('truncation surfaces failed rows in the visible slice', () => {
    const items: TodoItemForUI[] = [
      item('in_progress', 'running', 'Running'),
      ...Array.from({ length: 8 }, (_, i) => item('pending', `pending ${i}`)),
      item('failed', 'broke'),
    ];
    const out = renderTodoList(items, caps, 0);
    expect(out.some((l) => l.includes('✗') && l.includes('broke'))).toBe(true);
  });
});
