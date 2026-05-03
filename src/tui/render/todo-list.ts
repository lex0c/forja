// Live TodoList block. Spec: UI.md §4.3.
//
// Renders above the operation chips when state.todos is non-empty.
// Empty list returns []; the composer drops the section entirely.
//
// Layout:
//
//   Tasks
//     ✓ Resolve scope roots from repo root
//     ▶ Update bootstrap.ts callers
//     ○ Add regression test
//     ○ Run typecheck
//
// Glyph table per spec §4.3:
//   ✓ done            (ASCII fallback `[x]`)
//   ▶ in_progress     (ASCII fallback `[*]`)
//   ○ pending         (ASCII fallback `[ ]`)
//   ✗ failed          (ASCII fallback `[!]`)
//
// `failed` is wired but unreachable today — TodoStore enum doesn't
// expose it (the tool rejects invalid lists at write time, not at
// render time). The branch stays so a future store extension lights
// it up automatically without renderer churn (D133).
//
// >8 items: collapses to "in_progress + next 2 pending + done count"
// with a discreet `(+N more)` line, per spec §4.3 ("Mais de 8 todos:
// trunca pra '▶ running + próximas 2 pending + ✗ failed', com
// `(+12 more)` discreto"). The done-count placeholder replaces the
// listed-items rule for failed in our case (no failed exist) — failed
// items, when they land, would be appended verbatim.

import type { TodoItemForUI, TodoStatusForUI } from '../events.ts';
import { type Capabilities, paint } from '../term.ts';

const MAX_VISIBLE = 8;

interface GlyphPair {
  unicode: string;
  ascii: string;
}

const GLYPHS: Record<TodoStatusForUI, GlyphPair> = {
  done: { unicode: '✓', ascii: '[x]' },
  in_progress: { unicode: '▶', ascii: '[*]' },
  pending: { unicode: '○', ascii: '[ ]' },
  failed: { unicode: '✗', ascii: '[!]' },
};

const glyphFor = (status: TodoStatusForUI, caps: Capabilities): string => {
  const pair = GLYPHS[status];
  return caps.unicode ? pair.unicode : pair.ascii;
};

// in_progress items render with their `activeForm` ("Implementing
// payment flow"); the other states render `content` ("Implement
// payment flow"). Spec §7.4: activeForm is the present-progressive
// form the model writes for the in-progress label.
const labelFor = (item: TodoItemForUI): string =>
  item.status === 'in_progress' ? item.activeForm : item.content;

// Strip control characters that would break the renderer's "one item
// per output line" contract: a `\n` or `\r` embedded in user content
// would split into multiple terminal lines, but `composeLive` returns
// one string, and the renderer's `liveHeight = truncated.length`
// math would under-count by N. The todo_write tool's validateString
// doesn't reject these (D131-style "validate at boundary" is a TODO
// for that subsystem), so the renderer scrubs defensively. Tabs are
// kept (harmless single-cell render in most terminals).
const scrubLineBreaks = (s: string): string => s.replace(/[\r\n]+/g, ' ');

const renderRow = (item: TodoItemForUI, caps: Capabilities): string => {
  const glyph = glyphFor(item.status, caps);
  // in_progress in `warn` color so the active task pops; others dim.
  // Done rows stay dim — completed work is reference, not focus.
  const token = item.status === 'in_progress' ? 'warn' : 'dim';
  return `  ${paint(caps, token, `${glyph} ${scrubLineBreaks(labelFor(item))}`)}`;
};

// Truncation: when the list exceeds MAX_VISIBLE, surface only the
// signal-bearing slice — the running task plus a small lookahead at
// what's pending — and collapse the rest into a counter line. Order
// preserved: in_progress first (so the user sees what's running even
// if it's at index 30), then the next 2 pending in original order,
// then any failed items, then the (+N more) trailing line.
//
// When everything fits, returns the full list.
const visibleRows = (items: TodoItemForUI[]): TodoItemForUI[] => {
  if (items.length <= MAX_VISIBLE) return items;
  const inProgress = items.filter((i) => i.status === 'in_progress');
  const pending = items.filter((i) => i.status === 'pending').slice(0, 2);
  const failed = items.filter((i) => i.status === 'failed');
  // Drop duplicates while keeping insertion order — an in_progress
  // item is never also pending, but defensive set semantics make the
  // output stable if a future store relaxes the at-most-one rule.
  const picked: TodoItemForUI[] = [];
  const seen = new Set<TodoItemForUI>();
  for (const item of [...inProgress, ...pending, ...failed]) {
    if (seen.has(item)) continue;
    seen.add(item);
    picked.push(item);
  }
  return picked;
};

export const renderTodoList = (todos: TodoItemForUI[], caps: Capabilities): string[] => {
  if (todos.length === 0) return [];
  const visible = visibleRows(todos);
  const lines: string[] = [paint(caps, 'dim', 'Tasks')];
  for (const item of visible) {
    lines.push(renderRow(item, caps));
  }
  const hidden = todos.length - visible.length;
  if (hidden > 0) {
    lines.push(paint(caps, 'dim', `  (+${hidden} more)`));
  }
  return lines;
};
