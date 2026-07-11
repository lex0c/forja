import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface ReminderListEntry {
  reminder_id: string;
  note: string;
  scheduled_at: number;
  fire_at: number;
}

export interface ReminderListInput {
  // No args — always the full pending set for this session.
  [k: string]: never;
}

export interface ReminderListOutput {
  reminders: ReminderListEntry[];
  total: number;
}

export const reminderListTool: Tool<ReminderListInput, ReminderListOutput> = {
  name: 'reminder_list',
  description:
    'List the pending reminders scheduled in this session, soonest first. Read-only snapshot. Use it to recover a reminder_id you lost (across turns or after compaction) so you can reminder_cancel it. Fired and cancelled reminders are gone — only still-pending ones appear.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
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
  async execute(_args, ctx): Promise<ToolResult<ReminderListOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before list', { retryable: true });
    }
    if (ctx.reminderScheduler === undefined) {
      return toolError(
        'reminder.scheduler_unavailable',
        'reminder_list requires a session-scoped scheduler but none was provided',
      );
    }
    const pending = ctx.reminderScheduler.list();
    return {
      reminders: pending.map((r) => ({
        reminder_id: r.id,
        note: r.note,
        scheduled_at: r.scheduledAt,
        fire_at: r.fireAt,
      })),
      total: pending.length,
    };
  },
};
