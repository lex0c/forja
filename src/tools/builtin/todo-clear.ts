import type { TodoStatus } from '../../todo/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, isToolError, toolError } from '../types.ts';
import {
  ALL_STATUSES,
  type TodoWireItem,
  activeItems,
  countByStatus,
  isValidStatus,
  mapItemToWire,
  requireTodoStore,
} from './todo-shared.ts';

// todo_clear — empty the session's task list, or drop just the todos in a
// given status. The bulk counterpart to soft-deleting one row via
// todo_update(status:'removed'). Hard-removes the matched rows from the
// store (they leave the array entirely), but the id counter is NOT reset
// — a later todo_create still gets fresh, non-recycled ids.

export interface TodoClearInput {
  // Omitted → clear the ENTIRE list. Set → remove only todos in that
  // status (e.g. 'done' to sweep completed work keeping the rest, or
  // 'removed' to purge soft-deleted rows).
  status?: TodoStatus;
}
export interface TodoClearOutput {
  // How many rows this call removed from the store (includes soft-deleted
  // tombstones when clearing everything).
  cleared: number;
  // The remaining active (non-removed) list.
  items: TodoWireItem[];
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  total: number;
}

export const todoClearTool: Tool<TodoClearInput, TodoClearOutput> = {
  name: 'todo_clear',
  description:
    "Empty the session's todo list. Call with no args to remove ALL todos; pass `status` (e.g. 'done') to drop only the todos in that status, keeping the rest ('removed' purges soft-deleted rows). New todos created afterwards still get fresh ids (the counter isn't reset). Use it to reset the list between distinct pieces of work, or to sweep completed todos.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...ALL_STATUSES],
        description: 'Optional. Remove only todos in this status. Omit to clear the whole list.',
      },
    },
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<TodoClearOutput>> {
    const got = requireTodoStore(ctx, 'todo_clear');
    if (isToolError(got)) return got;
    if (args.status !== undefined && !isValidStatus(args.status)) {
      return toolError(ERROR_CODES.invalidArg, `status must be one of: ${ALL_STATUSES.join(', ')}`);
    }

    const { store, sid } = got;
    const before = store.get(sid);
    // No status → wipe everything. With status → keep the rest.
    const remaining =
      args.status === undefined ? [] : before.filter((i) => i.status !== args.status);
    store.set(sid, remaining);

    // Report over the active (non-removed) survivors, mirroring todo_list.
    const active = activeItems(remaining);
    const counts = countByStatus(remaining);
    return {
      cleared: before.length - remaining.length,
      items: active.map(mapItemToWire),
      ...counts,
      total: active.length,
    };
  },
};
