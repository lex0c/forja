// Shared helpers for the todo CRUD tools (todo_create / todo_update /
// todo_list / todo_get). Lifted from the former `todo_write` tool so the
// four tools share one validation + wire-mapping surface instead of
// duplicating it four ways. The store (`src/todo/index.ts`) stays a dumb
// container; all input validation and the at-most-one-in_progress
// invariant live here, at the tool boundary.

import type { TodoItem, TodoStatus, TodoStore } from '../../todo/index.ts';
import { ERROR_CODES, type ToolContext, type ToolError, toolError } from '../types.ts';

// Hard caps on input shape — every collection accepting model input needs
// a cap, else a pathological call lands a massive payload in audit rows
// and traps downstream renderers. 200 items covers any plausible task
// list; 4 KB per text field is generous for an imperative description.
export const MAX_ITEMS = 200;
export const MAX_FIELD_BYTES = 4096;

export const STORE_UNAVAILABLE_HINT =
  'This usually means the harness was constructed without a todoStore. Check HarnessConfig.';

// Front-guard shared by every todo tool: the abort check + the
// session-bound store requirement (the store degrades cleanly when the
// harness wasn't wired). Returns the store + sessionId, or a ToolError to
// return as-is — collapsing ~10 copy-pasted lines per tool into two.
export const requireTodoStore = (
  ctx: ToolContext,
  toolName: string,
): { store: TodoStore; sid: string } | ToolError => {
  if (ctx.signal.aborted) {
    return toolError(ERROR_CODES.aborted, `tool aborted before ${toolName}`, { retryable: true });
  }
  if (ctx.todoStore === undefined) {
    return toolError(
      'todo.store_unavailable',
      `${toolName} requires a session-bound TodoStore but none was provided`,
      { hint: STORE_UNAVAILABLE_HINT },
    );
  }
  return { store: ctx.todoStore, sid: ctx.sessionId };
};

// Tool-surface (snake_case) mirror of TodoItem. `activeForm` becomes
// `active_form` on the wire, matching the model-facing JSON convention.
export interface TodoWireItem {
  id: string;
  content: string;
  status: TodoStatus;
  active_form: string;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const isValidStatus = (s: unknown): s is TodoStatus =>
  s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed' || s === 'removed';

// Canonical status sets — the single source for the tools' inputSchema
// enums and their "must be one of" error messages, so the schema, the
// runtime check, and the human message can't drift apart (they did once).
// `removed` is a soft-delete TARGET (set via todo_update), never a status
// you create a row in, so the creatable set excludes it.
export const CREATABLE_STATUSES = ['pending', 'in_progress', 'done', 'failed'] as const;
export const ALL_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'removed'] as const;

export const isCreatableStatus = (s: unknown): s is (typeof CREATABLE_STATUSES)[number] =>
  s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed';

// True if `s` contains any C0 control char or DEL, allowing only tab
// (U+0009). Implemented with charCodeAt instead of a control-char regex
// so the source carries no literal control bytes (fragile to edit, trips
// linters). Surrogate halves (> 0x20) are never flagged.
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};

// Validate a model-supplied string field: non-empty, within the byte cap,
// and free of control characters (except tab). Control chars are rejected
// AT THE SOURCE: a `\n` / `\r` embedded in content breaks the renderer's
// one-item-per-line contract (render/todo-list.ts `liveHeight` math
// under-counts). With this guard the renderer's defensive scrub is pure
// belt-and-suspenders for replay paths, not load-bearing.
export const validateStringField = (
  v: unknown,
  label: string,
): { ok: true; value: string } | { ok: false; message: string } => {
  if (typeof v !== 'string') return { ok: false, message: `${label} must be a string` };
  if (v.length === 0) return { ok: false, message: `${label} must be non-empty` };
  const byteLength = Buffer.byteLength(v, 'utf8');
  if (byteLength > MAX_FIELD_BYTES) {
    return { ok: false, message: `${label} exceeds ${MAX_FIELD_BYTES} bytes (got ${byteLength})` };
  }
  if (hasControlChar(v)) {
    return { ok: false, message: `${label} must not contain control characters` };
  }
  return { ok: true, value: v };
};

export interface StatusCounts {
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
}

export const countByStatus = (items: TodoItem[]): StatusCounts => {
  const counts: StatusCounts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
  for (const item of items) {
    if (item.status === 'pending') counts.pending += 1;
    else if (item.status === 'in_progress') counts.in_progress += 1;
    else if (item.status === 'done') counts.done += 1;
    else if (item.status === 'failed') counts.failed += 1;
    // 'removed' is soft-deleted — counted in none; invisible to UI/model.
  }
  return counts;
};

// Active (non-soft-deleted) view of a list. `removed` rows linger in the
// store to keep ids stable but are invisible to the model and the UI — so
// EVERY model-facing read goes through here (or findActive), keeping the
// carve-out in one place instead of re-derived (and forgotten) per site.
export const activeItems = (items: TodoItem[]): TodoItem[] =>
  items.filter((i) => i.status !== 'removed');

// Find a LIVE (non-removed) item by id. A soft-deleted id resolves to
// undefined, so the tools surface todo.not_found — matching the store's
// documented "a removed id resolves to not_found" contract.
export const findActive = (items: TodoItem[], id: string): TodoItem | undefined =>
  items.find((i) => i.id === id && i.status !== 'removed');

// At most one item may be in_progress at a time (spec §7.4). Enforced at
// the tool boundary — the store is a dumb container — so every mutating
// tool re-checks the full post-change list and rejects a 2nd in_progress
// with a clean invalid_arg instead of letting a degenerate state persist.
export const assertSingleInProgress = (
  items: ReadonlyArray<{ status: TodoStatus }>,
): ToolError | null => {
  const n = items.filter((i) => i.status === 'in_progress').length;
  if (n > 1) {
    return toolError(
      ERROR_CODES.invalidArg,
      `at most one todo may be in_progress at a time (got ${n})`,
    );
  }
  return null;
};

export const mapItemToWire = (item: TodoItem): TodoWireItem => ({
  id: item.id,
  content: item.content,
  status: item.status,
  active_form: item.activeForm,
});
