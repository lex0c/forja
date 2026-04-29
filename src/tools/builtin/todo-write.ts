import type { TodoItem, TodoStatus } from '../../todo/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// Tool-surface mirror of TodoItem with snake_case naming for the
// model-facing JSON convention. activeForm becomes active_form on
// the wire; the keys-to-snake conversion is reversed manually here
// instead of via keysToSnake because we also need the inverse
// conversion (snake_case input → camelCase internal) and the
// generic helper only goes one way.
//
// Input and output items share the same shape — the tool echoes
// the validated list back verbatim. Single type avoids the small
// inconsistency risk of two parallel definitions drifting.
export interface TodoWriteItem {
  content: string;
  status: TodoStatus;
  active_form: string;
}

export interface TodoWriteInput {
  items: TodoWriteItem[];
}

export interface TodoWriteOutput {
  // Echoed back verbatim so the model can verify what landed.
  items: TodoWriteItem[];
  // Counts surface in audit logs and let evals reward "the model
  // actually progressed work" without parsing the items array.
  pending: number;
  in_progress: number;
  done: number;
}

// Hard caps on input shape. Same anti-unbounded-buffer rationale
// from CODER_PLAYBOOK §5.3: every collection accepting model input
// needs a cap, otherwise pathological calls land massive payloads
// in audit rows and trap downstream renderers. 200 items covers
// any plausible task list (the spec mentions tasks of 5+ steps as
// the threshold for `todo_write` use); 4 KB per text field is
// generous for an imperative task description.
const MAX_ITEMS = 200;
const MAX_FIELD_BYTES = 4096;

const isValidStatus = (s: unknown): s is TodoStatus =>
  s === 'pending' || s === 'in_progress' || s === 'done';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Validate a string field with shared shape: must be a non-empty
// string, must not exceed MAX_FIELD_BYTES (counted as UTF-8
// bytes — a 4096-char string of multibyte chars would still be
// well over the byte cap and that's the limit that matters for
// audit row size).
const validateStringField = (
  v: unknown,
  label: string,
): { ok: true; value: string } | { ok: false; message: string } => {
  if (typeof v !== 'string') return { ok: false, message: `${label} must be a string` };
  if (v.length === 0) return { ok: false, message: `${label} must be non-empty` };
  const byteLength = Buffer.byteLength(v, 'utf8');
  if (byteLength > MAX_FIELD_BYTES) {
    return {
      ok: false,
      message: `${label} exceeds ${MAX_FIELD_BYTES} bytes (got ${byteLength})`,
    };
  }
  return { ok: true, value: v };
};

export const todoWriteTool: Tool<TodoWriteInput, TodoWriteOutput> = {
  name: 'todo_write',
  description:
    "Replace the session's TodoList with the provided items. Each item is { content, status, active_form } where status is one of pending|in_progress|done and active_form is the present-progressive description shown live (e.g., 'Implementing payment flow' for content 'Implement payment flow'). The list is replaced atomically — pass the full intended list every call, partial updates are not supported. State is per-session and does NOT persist across sessions. At most one item may be in_progress at a time. Use this tool to make sub-task progress visible during multi-step work; the model decides when it's worth using.",
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description:
          'Full intended list of TodoItems. Replaces the previous list atomically. Empty array clears the list.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: "Imperative form of the task (e.g., 'Implement payment flow').",
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done'],
              description: 'Lifecycle marker. At most one item may be in_progress.',
            },
            active_form: {
              type: 'string',
              description:
                "Present-progressive description for live rendering (e.g., 'Implementing payment flow').",
            },
          },
          required: ['content', 'status', 'active_form'],
        },
      },
    },
    required: ['items'],
  },
  metadata: {
    // 'misc' for the same reason bash_output is misc: routing by
    // category is fine, the tool has no filesystem / network /
    // command surface that another section would govern. The
    // engine's misc-allow is correct here — todo_write touches
    // only in-process memory, not a resource the operator might
    // want to gate.
    category: 'misc',
    // Pure observational from the harness's safety perspective —
    // the list is harness-internal state, not external mutation.
    writes: false,
    // Replacing the same items twice yields the same store state.
    idempotent: true,
    // Plan mode: safe — no real-world side effect. The list is
    // visible to the user as a checklist but there's nothing to
    // undo or revert.
    planSafe: true,
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<TodoWriteOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before write', { retryable: true });
    }
    if (ctx.todoStore === undefined) {
      // Same shape as bg.manager_unavailable — operator-facing
      // configuration error, not user error. Non-retryable.
      return toolError(
        'todo.store_unavailable',
        'todo_write requires a session-bound TodoStore but none was provided',
        {
          hint: 'This usually means the harness was constructed without a todoStore. Check HarnessConfig.',
        },
      );
    }
    if (!Array.isArray(args.items)) {
      return toolError(ERROR_CODES.invalidArg, 'items must be an array');
    }
    if (args.items.length > MAX_ITEMS) {
      return toolError(
        ERROR_CODES.invalidArg,
        `items array exceeds maximum (${MAX_ITEMS}, got ${args.items.length})`,
      );
    }

    // Validate each item with the same runtime-vs-schema discipline
    // applied across the rest of the tool surface (see
    // CODER_PLAYBOOK §3.3). Schema declares each field's type but
    // model JSON arrives unvalidated. Catch the bad shapes here so
    // the store never holds malformed entries. Single pass also
    // accumulates the status counts so we don't iterate twice.
    const validated: TodoItem[] = [];
    const outputItems: TodoWriteItem[] = [];
    let pending = 0;
    let inProgress = 0;
    let done = 0;
    for (let i = 0; i < args.items.length; i++) {
      const raw = args.items[i] as unknown;
      if (!isObject(raw)) {
        return toolError(ERROR_CODES.invalidArg, `items[${i}] must be an object`);
      }
      const contentCheck = validateStringField(raw.content, `items[${i}].content`);
      if (!contentCheck.ok) {
        return toolError(ERROR_CODES.invalidArg, contentCheck.message);
      }
      if (!isValidStatus(raw.status)) {
        return toolError(
          ERROR_CODES.invalidArg,
          `items[${i}].status must be one of: pending, in_progress, done`,
        );
      }
      const activeFormCheck = validateStringField(raw.active_form, `items[${i}].active_form`);
      if (!activeFormCheck.ok) {
        return toolError(ERROR_CODES.invalidArg, activeFormCheck.message);
      }
      if (raw.status === 'pending') pending += 1;
      else if (raw.status === 'in_progress') inProgress += 1;
      else done += 1;
      validated.push({
        content: contentCheck.value,
        status: raw.status,
        activeForm: activeFormCheck.value,
      });
      outputItems.push({
        content: contentCheck.value,
        status: raw.status,
        active_form: activeFormCheck.value,
      });
    }

    // Spec §7.4: at most one item in_progress at a time. The model
    // sometimes drifts and marks several items active simultaneously,
    // which defeats the "what am I working on right now" signal the
    // TUI gives the user. Reject the call so the model fixes the
    // list before it lands. Cheap correction at write time, much
    // better than chasing the bug at render time.
    if (inProgress > 1) {
      return toolError(
        ERROR_CODES.invalidArg,
        `at most one item may have status='in_progress' (found ${inProgress})`,
      );
    }

    ctx.todoStore.set(ctx.sessionId, validated);

    return {
      items: outputItems,
      pending,
      in_progress: inProgress,
      done,
    };
  },
};
