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
    expect(renderTodoList([], caps)).toEqual([]);
  });

  test('header + one row per item with the canonical glyphs', () => {
    const out = renderTodoList(
      [
        item('done', 'Resolve scope roots'),
        item('in_progress', 'Update bootstrap', 'Updating bootstrap'),
        item('pending', 'Add regression test'),
      ],
      caps,
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

  test('list of 8 items renders fully (no truncation)', () => {
    const items = Array.from({ length: 8 }, (_, i) => item('pending', `task ${i}`));
    const out = renderTodoList(items, caps);
    // header + 8 rows; no `(+N more)` suffix.
    expect(out).toHaveLength(9);
    expect(out.some((l) => l.includes('more'))).toBe(false);
  });

  test('over 8 items collapses to running + 2 pending + (+N more)', () => {
    // 1 in_progress, 12 pending — 13 total.
    const items: TodoItemForUI[] = [
      item('in_progress', 'running thing', 'Running thing'),
      ...Array.from({ length: 12 }, (_, i) => item('pending', `pending ${i}`)),
    ];
    const out = renderTodoList(items, caps);
    // header + running + first 2 pending + `(+N more)` = 5 lines.
    expect(out).toHaveLength(5);
    expect(out[1]).toContain('▶');
    expect(out[1]).toContain('Running thing');
    expect(out[2]).toContain('pending 0');
    expect(out[3]).toContain('pending 1');
    expect(out[4]).toContain('(+10 more)');
  });

  test('embedded \\n / \\r in content is scrubbed (line-height contract)', () => {
    // The renderer's caller (composeLive → renderer.ts) assumes one
    // input string == one terminal line for liveHeight bookkeeping.
    // Embedded newlines would make `liveHeight = truncated.length`
    // under-count, leaving ghost rows after eraseLive. todo_write's
    // validation doesn't reject these today, so the renderer scrubs
    // defensively.
    const out = renderTodoList(
      [item('done', 'first\nsecond\nthird'), item('in_progress', 'x', 'progress\rwith\r\nbreaks')],
      caps,
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
    const out = renderTodoList(items, caps);
    // header + running + 2 pending + (+N more).
    expect(out).toHaveLength(5);
    expect(out[1]).toContain('Doing critical');
    expect(out[2]).toContain('pending 0');
    expect(out[3]).toContain('pending 1');
    // 11 total - 3 visible items = 8 hidden.
    expect(out[4]).toContain('(+8 more)');
  });
});
