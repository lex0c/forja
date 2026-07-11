import type { TodoItem, TodoStatus } from '../../todo/index.ts';
import { ERROR_CODES, isToolError, type Tool, type ToolResult, toolError } from '../types.ts';
import {
  ALL_STATUSES,
  activeItems,
  assertSingleInProgress,
  countByStatus,
  isValidStatus,
  mapItemToWire,
  requireTodoStore,
  type TodoWireItem,
  validateStringField,
} from './todo-shared.ts';

// todo_update — patch a single live todo by id. Only the fields you pass
// change; the rest are retained (partial patch). This is the path a row
// takes to 'done', 'failed', or 'removed' (soft-delete). A removed id is
// a tombstone — not patchable — and resolves to todo.not_found.

export interface TodoUpdateInput {
  id: string;
  content?: string;
  status?: TodoStatus;
  active_form?: string;
}
export interface TodoUpdateOutput {
  // The patched row (carries its new status, e.g. 'removed' when you just
  // soft-deleted it, so the call's effect is visible).
  item: TodoWireItem;
  // The live (non-removed) list after the patch.
  items: TodoWireItem[];
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
}

export const todoUpdateTool: Tool<TodoUpdateInput, TodoUpdateOutput> = {
  name: 'todo_update',
  description:
    "Patch a single todo by its id (from todo_create / todo_list). Pass only the fields to change: `status` ('pending' | 'in_progress' | 'done' | 'failed' | 'removed'), `content`, and/or `active_form` — omitted fields keep their current value. Mark a finished task 'done', a task that couldn't be completed 'failed', or 'removed' to soft-delete it (drops from the list and counts; the id is never reused). At most one todo may be in_progress at a time. Returns todo.not_found if the id isn't a live todo in this session.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the todo to patch.' },
      content: { type: 'string', description: 'New imperative description (optional).' },
      status: {
        type: 'string',
        enum: [...ALL_STATUSES],
        description:
          "New lifecycle status (optional). 'removed' soft-deletes the todo (drops from the list/counts; id never reused).",
      },
      active_form: {
        type: 'string',
        description: 'New present-progressive description (optional).',
      },
    },
    required: ['id'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<TodoUpdateOutput>> {
    const got = requireTodoStore(ctx, 'todo_update');
    if (isToolError(got)) return got;
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'id must be a non-empty string');
    }
    const hasPatch =
      args.content !== undefined || args.status !== undefined || args.active_form !== undefined;
    if (!hasPatch) {
      return toolError(
        ERROR_CODES.invalidArg,
        'provide at least one of content, status, active_form to update',
      );
    }

    const { store, sid } = got;
    const list = store.get(sid);
    const idx = list.findIndex((i) => i.id === args.id);
    // A removed id is a tombstone — invisible to the model — so treat it as
    // not_found rather than letting an update resurrect a soft-deleted row.
    if (idx === -1 || list[idx]?.status === 'removed') {
      return toolError(
        ERROR_CODES.todoNotFound,
        `no todo with id ${JSON.stringify(args.id)} in this session`,
      );
    }
    const current = list[idx] as TodoItem;

    let content = current.content;
    if (args.content !== undefined) {
      const c = validateStringField(args.content, 'content');
      if (!c.ok) return toolError(ERROR_CODES.invalidArg, c.message);
      content = c.value;
    }
    let activeForm = current.activeForm;
    if (args.active_form !== undefined) {
      const a = validateStringField(args.active_form, 'active_form');
      if (!a.ok) return toolError(ERROR_CODES.invalidArg, a.message);
      activeForm = a.value;
    }
    let status = current.status;
    if (args.status !== undefined) {
      if (!isValidStatus(args.status)) {
        return toolError(
          ERROR_CODES.invalidArg,
          `status must be one of: ${ALL_STATUSES.join(', ')}`,
        );
      }
      status = args.status;
    }

    const updated: TodoItem = { id: current.id, content, status, activeForm };
    let next: TodoItem[];
    if (status === 'removed') {
      // Purge the row, don't tombstone it. The monotonic id counter
      // (store.nextId) already guarantees the id is never reused, so a
      // lingering 'removed' row buys nothing — and because the create cap
      // counts only ACTIVE rows, keeping tombstones let create→remove
      // cycles grow the store (and every todo_updated payload) without
      // bound, defeating MAX_ITEMS. Dropping it keeps the cap honest.
      next = list.filter((_, i) => i !== idx);
    } else {
      next = [...list];
      next[idx] = updated;
    }
    const invalid = assertSingleInProgress(next);
    if (invalid !== null) return invalid;

    store.set(sid, next);
    const counts = countByStatus(next);
    return {
      item: mapItemToWire(updated),
      items: activeItems(next).map(mapItemToWire),
      ...counts,
    };
  },
};
