import { parseDuration } from '../../reminders/index.ts';
import { DEFER_BELOW_TOKENS_SMALL } from '../context-budget.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface ReminderInput {
  in: string;
  note: string;
}

export interface ReminderOutput {
  reminder_id: string;
  fire_at: number;
}

export const reminderTool: Tool<ReminderInput, ReminderOutput> = {
  name: 'reminder',
  description:
    'Schedule a one-shot reminder that wakes you after a relative delay — for a CLOCK wait with no process to watch (a rate limit resetting, a deploy settling, DNS propagating). `in` is relative: "30s" | "10m" | "2h". When it fires you are notified automatically with `note` as the context — do NOT poll. In-memory: lives only for this session. reminder_list recovers a lost id; reminder_cancel unschedules. To wait on a process instead, use bash_background.',
  inputSchema: {
    type: 'object',
    properties: {
      in: {
        type: 'string',
        description: 'Relative delay: "<n>s" | "<n>m" | "<n>h" (e.g. "10m"). Max 24h.',
      },
      note: {
        type: 'string',
        description: 'Context surfaced as the wake-turn input when the reminder fires.',
      },
    },
    required: ['in', 'note'],
  },
  metadata: {
    // 'misc' like bash_list: carries no `args.command`, so the bash
    // policy gate (which requires one) would default-deny. Scheduling a
    // session-local timer opens no fs/exec surface.
    category: 'misc',
    // Window-relative deferral (CONTEXT_TUNING §2.2): scheduling is off the base
    // surface on a small window; reachable via tool_search.
    deferBelowTokens: DEFER_BELOW_TOKENS_SMALL,
    writes: false,
    // Arms a session-scoped timer that can wake a turn — a side effect,
    // hence flagged (parallels requiresBgManager).
    requiresReminderScheduler: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 1 },
  },
  async execute(args, ctx): Promise<ToolResult<ReminderOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before scheduling', { retryable: true });
    }
    if (ctx.reminderScheduler === undefined) {
      return toolError(
        'reminder.scheduler_unavailable',
        'reminder requires a session-scoped scheduler but none was provided (reminders need the interactive REPL — a one-shot run has no next turn to wake)',
      );
    }
    if (typeof args.in !== 'string' || typeof args.note !== 'string' || args.note.length === 0) {
      return toolError(
        ERROR_CODES.invalidArg,
        'reminder requires { in: string, note: non-empty string }',
      );
    }
    const delayMs = parseDuration(args.in);
    if (delayMs === null) {
      return toolError(
        ERROR_CODES.invalidArg,
        `in must be a relative delay like "30s", "10m", "2h" (got ${JSON.stringify(args.in)})`,
      );
    }
    try {
      const { id, fireAt } = ctx.reminderScheduler.set({ delayMs, note: args.note });
      return { reminder_id: id, fire_at: fireAt };
    } catch (e) {
      // Horizon-cap violation etc — a clean invalid_arg, not a crash.
      return toolError(ERROR_CODES.invalidArg, e instanceof Error ? e.message : String(e));
    }
  },
};
