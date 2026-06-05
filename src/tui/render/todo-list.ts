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
// `failed` is reachable: the TodoStore enum exposes it and
// todo_update(status:'failed') sets it. The render branch (glyph +
// truncation) was wired ahead of the enum (D133), so it lit up with no
// renderer churn once the status landed.
//
// >MAX_VISIBLE (5) items: collapses to MAX_VISIBLE rows, priority-filled
// (running → pending lookahead → failed → done backfill, so the block is
// never empty), with a discreet `(+N more)` line in `secondary`. Diverges
// from spec §4.3 (cap 8 + "próximas 2 pending") — operator asked for a
// tighter, always-populated 5-row block; folds into the spec follow-up.

import type { TodoItemForUI, TodoStatusForUI } from '../events.ts';
import { type Capabilities, paint } from '../term.ts';
import { renderShimmer } from './shimmer.ts';

const MAX_VISIBLE = 5;

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
// math would under-count by N. The todo tools now reject control chars
// at the source (todo-shared.ts validateStringField), so this scrub is
// residual defense for replay / NDJSON paths. Tabs are kept (harmless
// single-cell render in most terminals).
const scrubLineBreaks = (s: string): string => s.replace(/[\r\n]+/g, ' ');

const renderRow = (item: TodoItemForUI, caps: Capabilities): string => {
  const glyph = glyphFor(item.status, caps);
  // in_progress in `bold` (default color, heavier weight) so the active
  // task pops without tinting; failed in `error` (loud); done in
  // `secondary` (visible grey — completed work recedes); pending stays
  // `dim` (the faint default, "not started yet").
  const token =
    item.status === 'in_progress'
      ? 'bold'
      : item.status === 'failed'
        ? 'error'
        : item.status === 'done'
          ? 'secondary'
          : 'dim';
  return `  ${paint(caps, token, `${glyph} ${scrubLineBreaks(labelFor(item))}`)}`;
};

// Truncation: when the list exceeds MAX_VISIBLE, fill exactly MAX_VISIBLE
// rows by priority and collapse the rest into a counter line. Running +
// failures are always shown (the signal); the pending lookahead fills the
// budget they leave; done backfills any remaining slots so the block never
// renders EMPTY — an all-done list (6/6) still shows rows, not just the
// `(+N more)` line. Display order: in_progress, pending, failed, done — so
// the running task shows even if it sits deep in the list.
//
// When everything fits, returns the full list.
const visibleRows = (items: TodoItemForUI[]): TodoItemForUI[] => {
  if (items.length <= MAX_VISIBLE) return items;
  const byStatus = (s: TodoStatusForUI): TodoItemForUI[] => items.filter((i) => i.status === s);
  const inProgress = byStatus('in_progress');
  const failed = byStatus('failed');
  const pendingBudget = Math.max(0, MAX_VISIBLE - inProgress.length - failed.length);
  const pending = byStatus('pending').slice(0, pendingBudget);
  const used = inProgress.length + failed.length + pending.length;
  const done = byStatus('done').slice(0, Math.max(0, MAX_VISIBLE - used));
  // Dedup keeps insertion order stable if a future store ever lets a status
  // overlap; the final slice caps a failure-heavy list.
  const picked: TodoItemForUI[] = [];
  const seen = new Set<TodoItemForUI>();
  for (const item of [...inProgress, ...pending, ...failed, ...done]) {
    if (seen.has(item)) continue;
    seen.add(item);
    picked.push(item);
  }
  return picked.slice(0, MAX_VISIBLE);
};

export const renderTodoList = (
  todos: TodoItemForUI[],
  caps: Capabilities,
  now: number,
): string[] => {
  if (todos.length === 0) return [];
  const visible = visibleRows(todos);
  // Header: `Tasks (<n> pending · <n> in_progress · <n> done · <n> failed)`.
  // The word "Tasks" carries the live-verb shimmer WHILE a task is
  // in_progress — composeLive redraws this block every frame and the
  // heartbeat stays awake while an in_progress task exists (renderer.ts
  // `isActive`). With nothing running it renders flat `secondary`, so a
  // parked list never freezes a stray highlighted char. The parenthetical
  // status breakdown is `secondary` (a quiet meta detail).
  const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
  for (const t of todos) counts[t.status] += 1;
  const breakdown =
    `${counts.pending} pending · ${counts.in_progress} in_progress · ` +
    `${counts.done} done · ${counts.failed} failed`;
  const head =
    counts.in_progress > 0
      ? renderShimmer('Tasks', caps, now, 'secondary')
      : paint(caps, 'secondary', 'Tasks');
  const lines: string[] = [`${head} ${paint(caps, 'secondary', `(${breakdown})`)}`];
  for (const item of visible) {
    lines.push(renderRow(item, caps));
  }
  const hidden = todos.length - visible.length;
  if (hidden > 0) {
    // `secondary` (visible grey), not `dim`: this is a meta/counter line,
    // not a task — the visible-grey variant sets it apart from the dim
    // done/pending rows and survives terminals where faint is near-invisible.
    lines.push(paint(caps, 'secondary', `  (+${hidden} more)`));
  }
  return lines;
};
