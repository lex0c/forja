import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface ReminderCancelInput {
  reminder_id: string;
}

export interface ReminderCancelOutput {
  // false when the id is unknown or the reminder already fired —
  // idempotent, not an error.
  cancelled: boolean;
}

export const reminderCancelTool: Tool<ReminderCancelInput, ReminderCancelOutput> = {
  name: 'reminder_cancel',
  description:
    'Cancel a pending reminder by its reminder_id so it never fires. Idempotent: cancelling an unknown or already-fired id returns { cancelled: false } rather than an error. Use reminder_list to find the id.',
  inputSchema: {
    type: 'object',
    properties: {
      reminder_id: { type: 'string', description: 'The id returned by reminder / reminder_list.' },
    },
    required: ['reminder_id'],
  },
  metadata: {
    // Deferred (AGENTIC_CLI §7.6): rare reminder management; `reminder` (set)
    // stays visible. Reached via tool_search.
    deferred: true,
    category: 'misc',
    writes: false,
    requiresReminderScheduler: true,
    idempotent: true,
    display: 'raw',
    cost: { latency_ms_typical: 1 },
  },
  async execute(args, ctx): Promise<ToolResult<ReminderCancelOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before cancel', { retryable: true });
    }
    if (ctx.reminderScheduler === undefined) {
      return toolError(
        'reminder.scheduler_unavailable',
        'reminder_cancel requires a session-scoped scheduler but none was provided',
      );
    }
    if (typeof args.reminder_id !== 'string' || args.reminder_id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'reminder_id must be a non-empty string');
    }
    return { cancelled: ctx.reminderScheduler.cancel(args.reminder_id) };
  },
};
