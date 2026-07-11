import { ERROR_CODES, isToolError, type Tool, type ToolResult, toolError } from '../types.ts';
import { findActive, mapItemToWire, requireTodoStore, type TodoWireItem } from './todo-shared.ts';

// todo_get — fetch a single LIVE todo by id. Read-only and parallel-safe.
// A soft-deleted (removed) id resolves to todo.not_found, same as an id
// that never existed — removed rows are invisible to the model.

export interface TodoGetInput {
  id: string;
}
export interface TodoGetOutput {
  item: TodoWireItem;
}

export const todoGetTool: Tool<TodoGetInput, TodoGetOutput> = {
  name: 'todo_get',
  description:
    "Fetch a single todo by its id (content, status, active_form). Read-only. Returns todo.not_found if the id isn't a live todo in this session (a soft-deleted/removed id counts as not_found).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id of the todo to fetch.' },
    },
    required: ['id'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    parallel_safe: true,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<TodoGetOutput>> {
    const got = requireTodoStore(ctx, 'todo_get');
    if (isToolError(got)) return got;
    if (typeof args.id !== 'string' || args.id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'id must be a non-empty string');
    }

    const item = findActive(got.store.get(got.sid), args.id);
    if (item === undefined) {
      return toolError(
        ERROR_CODES.todoNotFound,
        `no todo with id ${JSON.stringify(args.id)} in this session`,
      );
    }
    return { item: mapItemToWire(item) };
  },
};
