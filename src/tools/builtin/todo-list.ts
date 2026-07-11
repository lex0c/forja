import type { TodoStatus } from '../../todo/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, isToolError, toolError } from '../types.ts';
import {
  CREATABLE_STATUSES,
  type TodoWireItem,
  activeItems,
  countByStatus,
  isCreatableStatus,
  mapItemToWire,
  requireTodoStore,
} from './todo-shared.ts';

// todo_list — read the session's LIVE task list (optionally filtered by
// status). Soft-deleted (removed) rows are excluded; counts and total are
// over the active set. Read-only and parallel-safe. Use it after a long
// context (ids may be lost) or to confirm progress before continuing.

export interface TodoListInput {
  status?: TodoStatus;
}
export interface TodoListOutput {
  items: TodoWireItem[];
  // Counts over the whole ACTIVE (non-removed) list, regardless of the
  // `status` filter — so a filtered read still shows true progress.
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  total: number;
}

export const todoListTool: Tool<TodoListInput, TodoListOutput> = {
  name: 'todo_list',
  description:
    "List the session's live todos with their ids and statuses, plus counts. Pass `status` to filter ('pending' | 'in_progress' | 'done' | 'failed') — the counts stay over the full active list either way. Soft-deleted rows are never listed. Read-only.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...CREATABLE_STATUSES],
        description: 'Optional status filter. Omit to list every live todo.',
      },
    },
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    parallel_safe: true,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<TodoListOutput>> {
    const got = requireTodoStore(ctx, 'todo_list');
    if (isToolError(got)) return got;
    if (args.status !== undefined && !isCreatableStatus(args.status)) {
      return toolError(
        ERROR_CODES.invalidArg,
        `status filter must be one of: ${CREATABLE_STATUSES.join(', ')}`,
      );
    }

    const list = got.store.get(got.sid);
    const active = activeItems(list);
    const counts = countByStatus(list);
    const filtered =
      args.status === undefined ? active : active.filter((i) => i.status === args.status);
    return { items: filtered.map(mapItemToWire), ...counts, total: active.length };
  },
};
