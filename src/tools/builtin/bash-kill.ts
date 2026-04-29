import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface BashKillInput {
  process_id: string;
  // Initial signal to send. Defaults to SIGTERM. Pass 'SIGKILL' to
  // skip the grace period and hard-kill immediately.
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';
  // Grace period after SIGTERM before escalating to SIGKILL.
  // Defaults to 5000ms. Ignored when signal is 'SIGKILL'.
  grace_period_ms?: number;
}

export interface BashKillOutput {
  process_id: string;
  status: 'running' | 'exited' | 'killed' | 'failed';
  exit_code: number | null;
  exited_at: number | null;
}

export const bashKillTool: Tool<BashKillInput, BashKillOutput> = {
  name: 'bash_kill',
  description:
    'Terminate a background process started by bash_background. Sends SIGTERM by default, escalates to SIGKILL after a grace period. Idempotent on already-finished processes — returns the current status without re-killing.',
  inputSchema: {
    type: 'object',
    properties: {
      process_id: {
        type: 'string',
        description: 'The process_id returned by bash_background.',
      },
      signal: {
        type: 'string',
        enum: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'],
        description: 'Initial signal to send. Defaults to SIGTERM. SIGKILL skips the grace period.',
      },
      grace_period_ms: {
        type: 'integer',
        minimum: 0,
        description:
          'Milliseconds to wait after SIGTERM before escalating to SIGKILL. Defaults to 5000. Ignored when signal is SIGKILL.',
      },
    },
    required: ['process_id'],
  },
  metadata: {
    // Category 'misc', not 'bash'. Same reasoning as bash_output:
    // checkBash requires `args.command` and denies when absent,
    // which would default-deny every kill under non-bypass mode.
    // The process being killed was previously approved at spawn
    // time; killing it doesn't open new attack surface. Plan mode
    // still blocks (writes=true + no planSafe) — operators in
    // plan mode shouldn't be triggering kills.
    category: 'misc',
    // Sends a signal — pessimistic write under plan mode.
    writes: true,
    exec: true,
    idempotent: true, // re-killing an already-killed process is a no-op
    display: 'raw',
    cost: { latency_ms_typical: 100 },
  },
  async execute(args, ctx): Promise<ToolResult<BashKillOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before kill', { retryable: true });
    }
    if (ctx.bgManager === undefined) {
      return toolError(
        'bg.manager_unavailable',
        'bash_kill requires a session-bound bg manager but none was provided',
      );
    }
    if (typeof args.process_id !== 'string' || args.process_id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'process_id must be a non-empty string');
    }
    try {
      const opts: { signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'; gracePeriodMs?: number } =
        {};
      if (args.signal !== undefined) opts.signal = args.signal;
      if (args.grace_period_ms !== undefined) opts.gracePeriodMs = args.grace_period_ms;
      const r = await ctx.bgManager.kill(args.process_id, opts);
      return {
        process_id: args.process_id,
        status: r.status,
        exit_code: r.exitCode,
        exited_at: r.exitedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isNotFound = /not found|not in this session/i.test(message);
      return toolError(
        isNotFound ? 'bg.process_not_found' : 'bg.kill_failed',
        `bash_kill failed: ${message}`,
      );
    }
  },
};
