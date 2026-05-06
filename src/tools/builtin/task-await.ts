import type { WorktreeOutcome } from '../../subagents/types.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// `task_await` collects the output of a subagent previously spawned
// via `task_async`. Blocks until the child finishes, the optional
// timeout fires, or the parent's signal aborts. Repeat awaits on a
// handle whose run already settled return the cached envelope —
// idempotent by construction.
//
// Spec: ORCHESTRATION.md §3.4 (Coleta de outputs) +
// CONTRACTS.md §2.6.4.

export interface TaskAwaitInput {
  // Handle id returned by an earlier `task_async` call.
  handle_id: string;
  // Optional cap on how long to wait, in milliseconds. Omit for
  // "wait forever" (still subject to the run's wall-clock cap).
  // Must be an integer >= 1; the runtime rejects 0 / negative /
  // float / NaN with `tool.invalid_arg`. Capped at 30 minutes.
  timeout_ms?: number;
}

// Mirrors `TaskOutput` so a model that switches between
// `task` and `task_async` + `task_await` sees the same envelope
// shape on the success path.
export interface TaskAwaitOutput {
  output: string;
  session_id: string;
  status: 'done' | 'interrupted' | 'exhausted' | 'error';
  reason: string;
  cost_usd: number;
  steps: number;
  duration_ms: number;
  audit_failure?: { code: string; message: string };
  worktree?: WorktreeOutcome;
}

const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export const taskAwaitTool: Tool<TaskAwaitInput, TaskAwaitOutput> = {
  name: 'task_await',
  description:
    'Block until a subagent spawned via `task_async` finishes; return its envelope. Pass a previously-returned `handle_id`. Optional `timeout_ms` caps the wait (the run still completes in the background — you can re-await later). Repeat awaits on a settled handle return the same envelope.',
  inputSchema: {
    type: 'object',
    properties: {
      handle_id: {
        type: 'string',
        description: 'Handle id returned by `task_async`.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1,
        description:
          'Maximum wait time in milliseconds. Omit to wait until the child finishes (still bounded by the run wall-clock).',
      },
    },
    required: ['handle_id'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    // Repeat awaits on a settled handle return the cached
    // envelope deterministically — `task_await` itself is
    // idempotent. The CHILD it observes is not, but that's
    // already captured in the spawn's own metadata.
    idempotent: true,
    // Plan mode: same gate as `task` / `task_async`. The block
    // doesn't write, but the run we're observing might. Refusing
    // here keeps the global "no spawning during plan" rule
    // simple — operator can still cancel a leftover handle via
    // task_cancel.
    planSafe: false,
    display: 'raw',
  },
  async execute(args, ctx): Promise<ToolResult<TaskAwaitOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before await', {
        retryable: true,
      });
    }
    if (ctx.subagentHandleStore === undefined) {
      return toolError(
        'subagent.unavailable',
        'subagents are not available in this run (no registry wired)',
        {
          hint: 'task_await needs the same harness wiring as task_async. If task_async returned a handle in this run, the store is configured — this error means the run was misconfigured at boot.',
        },
      );
    }
    if (typeof args.handle_id !== 'string' || args.handle_id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "'handle_id' must be a non-empty string");
    }
    if (args.timeout_ms !== undefined) {
      if (
        typeof args.timeout_ms !== 'number' ||
        !Number.isFinite(args.timeout_ms) ||
        !Number.isInteger(args.timeout_ms) ||
        args.timeout_ms < 1 ||
        args.timeout_ms > MAX_TIMEOUT_MS
      ) {
        return toolError(
          ERROR_CODES.invalidArg,
          `'timeout_ms' must be an integer in [1, ${MAX_TIMEOUT_MS}]`,
        );
      }
    }
    const outcome = await ctx.subagentHandleStore.awaitHandle(args.handle_id, {
      ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
      // Forward the tool ctx signal so a parent abort lands as
      // `aborted` instead of stranding the await on a dead
      // run. The store cooperates with both signal and timeout.
      signal: ctx.signal,
    });
    if (outcome.kind === 'unknown') {
      return toolError('subagent.unknown_handle', `unknown handle '${args.handle_id}'`, {
        hint: 'Pass a handle_id returned by task_async in this run. Handles do not persist across runs.',
      });
    }
    if (outcome.kind === 'timeout') {
      return toolError(
        'subagent.await_timeout',
        `await on '${args.handle_id}' timed out after ${args.timeout_ms}ms`,
        {
          retryable: true,
          hint: 'The subagent is still running. Call task_await again with a larger timeout, or task_cancel to abort it.',
        },
      );
    }
    if (outcome.kind === 'aborted') {
      return toolError(ERROR_CODES.aborted, 'await aborted', { retryable: true });
    }
    // outcome.kind === 'done' — fold the SpawnSubagentResult.
    const result = outcome.result;
    if (result.kind === 'unknown_subagent') {
      // Reachable when the spawn itself reported unknown name —
      // the original task_async would have surfaced this before
      // the handle was returned, so this is purely defensive.
      return toolError('subagent.unknown', `subagent '${result.requested}' not found`, {
        hint:
          result.available.length > 0
            ? `Known subagents: ${result.available.join(', ')}.`
            : 'No subagents are defined.',
        details: { available: result.available },
      });
    }
    if (result.kind === 'depth_exceeded') {
      return toolError(
        'subagent.depth_exceeded',
        `subagent '${result.requested}' would nest at depth ${result.depth} (max ${result.maxDepth})`,
        {
          hint: 'Stop nesting task() calls.',
          details: { depth: result.depth, max_depth: result.maxDepth },
        },
      );
    }
    // result.kind === 'ran' — non-`done` exits map to tool
    // errors so the model sees the failure clearly. Same shape
    // as `task` does.
    if (result.status !== 'done') {
      const detail = `subagent exited with status='${result.status}', reason='${result.reason}'`;
      return toolError('subagent.run_failed', detail, {
        retryable: result.status === 'exhausted',
        details: {
          handle_id: args.handle_id,
          session_id: result.sessionId,
          status: result.status,
          reason: result.reason,
          cost_usd: result.costUsd,
          steps: result.steps,
          duration_ms: result.durationMs,
          output: result.output,
          ...(result.auditFailure !== undefined ? { audit_failure: result.auditFailure } : {}),
          ...(result.worktree !== undefined ? { worktree: result.worktree } : {}),
          ...(result.worktreeError !== undefined ? { worktree_error: result.worktreeError } : {}),
        },
      });
    }
    return {
      output: result.output,
      session_id: result.sessionId,
      status: result.status,
      reason: result.reason,
      cost_usd: result.costUsd,
      steps: result.steps,
      duration_ms: result.durationMs,
      ...(result.auditFailure !== undefined ? { audit_failure: result.auditFailure } : {}),
      ...(result.worktree !== undefined ? { worktree: result.worktree } : {}),
    };
  },
};
