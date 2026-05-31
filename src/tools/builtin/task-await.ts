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
    //
    // Three of the four `kind` branches below mirror the
    // refusals that `task_async` pre-flights at the call
    // site. They CAN still arrive here when the dispatcher
    // (`spawnSubagentImpl` in loop.ts) revalidates and
    // refuses AFTER the pre-flight passed — typical case:
    // the cap projection looked OK at task_async time, but
    // by the time the store's slot frees and dispatch runs,
    // a sibling settled and the projection now exceeds the
    // cap. The refusal lands as a settled-payload kind, not
    // as a synchronous tool error, so the audit recorder
    // wasn't called by `task_async`.
    //
    // Each branch records the decision before returning, so
    // forensic queries see the refusal regardless of which
    // gate (pre-flight vs. dispatcher) caught it. Attributes
    // to `'task_async'` because the originating model call
    // was task_async; the dispatcher revalidation is an
    // implementation detail invisible to the model.
    const result = outcome.result;
    if (result.kind === 'unknown_subagent') {
      // Reachable when the spawn itself reported unknown name —
      // the original task_async would have surfaced this before
      // the handle was returned, so this is purely defensive.
      ctx.recordGateDecision?.({
        decisionType: 'unknown_subagent',
        toolName: 'task_async',
        requestedName: result.requested,
        details: { available: result.available },
      });
      return toolError('subagent.unknown', `subagent '${result.requested}' not found`, {
        hint:
          result.available.length > 0
            ? `Known subagents: ${result.available.join(', ')}.`
            : 'No subagents are defined.',
        details: { available: result.available },
      });
    }
    if (result.kind === 'depth_exceeded') {
      ctx.recordGateDecision?.({
        decisionType: 'depth_exceeded',
        toolName: 'task_async',
        requestedName: result.requested,
        details: { depth: result.depth, max_depth: result.maxDepth },
      });
      return toolError(
        'subagent.depth_exceeded',
        `subagent '${result.requested}' would nest at depth ${result.depth} (max ${result.maxDepth})`,
        {
          hint: 'Stop nesting task() calls.',
          details: { depth: result.depth, max_depth: result.maxDepth },
        },
      );
    }
    if (result.kind === 'subagent_escalation') {
      // PERMISSION_ENGINE.md §10.1 — declared capabilities exceeded
      // parent's. Reachable when the originating task_async passed
      // a `capabilities` array AND the dispatcher's later intersection
      // refused. Mirrored from `task.ts`'s synchronous handler.
      ctx.recordGateDecision?.({
        decisionType: 'subagent_escalation',
        toolName: 'task_async',
        requestedName: result.requested,
        details: { excess: result.excess },
      });
      return toolError(
        'subagent.escalation',
        `subagent '${result.requested}' requested capabilities beyond the parent's set: ${result.excess.join(', ')}`,
        {
          retryable: false,
          hint: 'Spec §10.1: declared_caps must be a subset of parent_caps. Drop the excess entries from the `capabilities` array, or restructure the work so the subagent runs under the capabilities the parent itself can exercise.',
          details: { subagent: result.requested, excess: result.excess },
        },
      );
    }
    if (result.kind === 'budget_exhausted') {
      ctx.recordGateDecision?.({
        decisionType: 'budget_exhausted',
        toolName: 'task_async',
        requestedName: result.requested,
        details: {
          spent: result.spent,
          estimate: result.estimate,
          projected: result.projected,
          cap: result.cap,
        },
      });
      return toolError(
        'subagent.budget_exhausted',
        `spawning '${result.requested}' would push projected cost to $${result.projected.toFixed(6)} (cap $${result.cap.toFixed(6)})`,
        {
          retryable: false,
          hint: 'Cumulative parent + child cost would cross the run cap. Finish the work without a new subagent, or wait for in-flight task_async spawns to settle and free their reservations.',
          details: {
            subagent: result.requested,
            spent: result.spent,
            estimate: result.estimate,
            projected: result.projected,
            cap: result.cap,
          },
        },
      );
    }
    // result.kind === 'ran' — non-`done` exits map to tool
    // errors so the model sees the failure clearly. Same shape
    // as `task` does.
    if (result.status !== 'done') {
      // Append the child's diagnostic `detail` when the runtime
      // forwarded one. Mirrors the same widening in `task.ts`;
      // both surfaces (sync `task` and async `task_await`) need
      // the cause text or the operator's TUI chip falls back to
      // a bare categorical `reason`.
      const causeSuffix =
        result.detail !== undefined && result.detail.length > 0 ? `: ${result.detail}` : '';
      const detail = `subagent exited with status='${result.status}', reason='${result.reason}'${causeSuffix}`;
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
