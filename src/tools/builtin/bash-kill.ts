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
    // Deferred (AGENTIC_CLI §7.6): rare bg-job management; bash/bash_background/
    // bash_output stay visible. Reached via tool_search when needed.
    deferred: true,
    // Category 'misc', not 'bash'. Same reasoning as bash_output:
    // checkBash requires `args.command` and denies when absent,
    // which would default-deny every kill under non-bypass mode.
    // The process being killed was previously approved at spawn
    // time; killing it doesn't open new attack surface.
    category: 'misc',
    // Sends a signal — declared as a pessimistic write.
    writes: true,
    // Slice 150 (review): the `escapesCwd` field is misnamed for
    // this tool's case — bash_kill doesn't touch the filesystem,
    // it sends a signal. But the field's DOCUMENTED meaning per
    // tools/types.ts is broader: "side effects of this tool may
    // escape ctx.cwd ... NOT reversed by a working-tree restore."
    // Killing a bg process satisfies the second half: any
    // half-finished work the process had in flight stays half-
    // finished after a checkpoint restore. Setting the flag here
    // is correct under the documented semantics, just confusing
    // under the name. The harness's `loop.ts` comment acknowledges
    // the field name is a future-rename target; bundling the
    // rename with the broader cleanup is out of scope for this
    // slice.
    escapesCwd: true,
    exec: true,
    // Same as bash_background: the runtime dispatches through
    // `ctx.bgManager`; without it every call surfaces the
    // bgmanager-missing tool-error. Pulled forward to bootstrap.
    requiresBgManager: true,
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
    // Schema declares `signal` as an enum and `grace_period_ms` with
    // minimum: 0, but providers don't enforce schema constraints —
    // model JSON arrives unvalidated. Without these checks, an
    // unexpected `signal` value (e.g. 'SIGUSR1') leaks into
    // proc.kill() with a confusing failure shape, and a non-numeric
    // or negative `grace_period_ms` is coerced inside the manager's
    // sleep path, collapsing the grace window to ~0ms — graceful
    // shutdown becomes immediate SIGKILL escalation, defeating the
    // documented semantics. Reject runtime-side with the same
    // boundaries the schema declares.
    const ALLOWED_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] as const;
    if (args.signal !== undefined) {
      if (
        typeof args.signal !== 'string' ||
        !(ALLOWED_SIGNALS as readonly string[]).includes(args.signal)
      ) {
        return toolError(
          ERROR_CODES.invalidArg,
          `signal must be one of: ${ALLOWED_SIGNALS.join(', ')}`,
        );
      }
    }
    if (args.grace_period_ms !== undefined) {
      if (
        typeof args.grace_period_ms !== 'number' ||
        !Number.isFinite(args.grace_period_ms) ||
        !Number.isInteger(args.grace_period_ms) ||
        args.grace_period_ms < 0
      ) {
        return toolError(ERROR_CODES.invalidArg, 'grace_period_ms must be a non-negative integer');
      }
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
