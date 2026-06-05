import type { TodoItem, TodoStatus } from '../../todo/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, isToolError, toolError } from '../types.ts';
import {
  CREATABLE_STATUSES,
  MAX_ITEMS,
  type TodoWireItem,
  activeItems,
  assertSingleInProgress,
  countByStatus,
  isCreatableStatus,
  isObject,
  mapItemToWire,
  requireTodoStore,
  validateStringField,
} from './todo-shared.ts';

// todo_create — append one or more todos to the session list, each with a
// stable store-assigned id. Status defaults to 'pending' (the common
// "queue tasks up" case); pass it explicitly to seed a row already
// in_progress/done/failed (NOT 'removed' — you can't create a row already
// soft-deleted). The store stays a dumb container: this does read-modify-
// write (get -> append -> set), and set() auto-emits the TUI update.

export interface TodoCreateInputItem {
  content: string;
  status?: TodoStatus;
  active_form: string;
}
export interface TodoCreateInput {
  items: TodoCreateInputItem[];
}
export interface TodoCreateOutput {
  // The newly created rows WITH their assigned ids — so the model learns
  // the ids it can later pass to todo_update / todo_get.
  created: TodoWireItem[];
  // The live (non-removed) list after the append, for verification.
  items: TodoWireItem[];
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
}

export const todoCreateTool: Tool<TodoCreateInput, TodoCreateOutput> = {
  name: 'todo_create',
  description:
    "Append one or more todos to the session's task list. Each item is { content, status?, active_form }; status defaults to 'pending'. The store assigns a stable id per item (returned in `created`) — use it with todo_update / todo_get. Use this to make a multi-step plan visible to the operator before executing. At most one todo may be in_progress at a time across the whole list.",
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Todos to add. Each is appended; existing todos are untouched.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: "Imperative form of the task (e.g., 'Implement payment flow').",
            },
            status: {
              type: 'string',
              enum: [...CREATABLE_STATUSES],
              description: "Lifecycle status. Defaults to 'pending' when omitted.",
            },
            active_form: {
              type: 'string',
              description:
                "Present-progressive description for live rendering (e.g., 'Implementing payment flow').",
            },
          },
          required: ['content', 'active_form'],
        },
      },
    },
    required: ['items'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<TodoCreateOutput>> {
    const got = requireTodoStore(ctx, 'todo_create');
    if (isToolError(got)) return got;
    if (!Array.isArray(args.items)) {
      return toolError(ERROR_CODES.invalidArg, 'items must be an array');
    }
    if (args.items.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'items must contain at least one todo to create');
    }

    const { store, sid } = got;
    const existing = store.get(sid);
    // Cap counts ACTIVE todos only — soft-deleted (removed) rows linger in
    // the store to keep ids stable, but must not consume the budget.
    const activeCount = activeItems(existing).length;
    if (activeCount + args.items.length > MAX_ITEMS) {
      return toolError(
        ERROR_CODES.invalidArg,
        `creating ${args.items.length} todos would exceed the ${MAX_ITEMS}-item cap (${activeCount} already active)`,
      );
    }

    // Validate every field BEFORE consuming an id — a rejected call must
    // not burn ids, which would leave gaps on the next successful create.
    const fields: Array<{ content: string; status: TodoStatus; activeForm: string }> = [];
    for (let i = 0; i < args.items.length; i++) {
      const raw = args.items[i] as unknown;
      if (!isObject(raw)) {
        return toolError(ERROR_CODES.invalidArg, `items[${i}] must be an object`);
      }
      const contentCheck = validateStringField(raw.content, `items[${i}].content`);
      if (!contentCheck.ok) return toolError(ERROR_CODES.invalidArg, contentCheck.message);
      const activeFormCheck = validateStringField(raw.active_form, `items[${i}].active_form`);
      if (!activeFormCheck.ok) return toolError(ERROR_CODES.invalidArg, activeFormCheck.message);
      const status = raw.status === undefined ? 'pending' : raw.status;
      // isCreatableStatus rejects 'removed' — you soft-delete via
      // todo_update, you don't create a row already removed.
      if (!isCreatableStatus(status)) {
        return toolError(
          ERROR_CODES.invalidArg,
          `items[${i}].status must be one of: ${CREATABLE_STATUSES.join(', ')}`,
        );
      }
      fields.push({ content: contentCheck.value, status, activeForm: activeFormCheck.value });
    }

    // Reject a 2nd in_progress against the COMBINED list before persisting.
    const invalid = assertSingleInProgress([...existing, ...fields]);
    if (invalid !== null) return invalid;

    const created: TodoItem[] = fields.map((f) => ({ id: store.nextId(sid), ...f }));
    const full = [...existing, ...created];
    store.set(sid, full);

    const counts = countByStatus(full);
    return {
      created: created.map(mapItemToWire),
      items: activeItems(full).map(mapItemToWire),
      ...counts,
    };
  },
};
