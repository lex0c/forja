import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// `task_cancel` aborts a subagent spawned via `task_async`. The
// per-handle controller is flipped; the child's run sees its signal
// abort and exits via the usual interrupted path, leaving its
// audit row + worktree cleanup intact.
//
// Spec: ORCHESTRATION.md §3.6 (Cancel cascading) +
// CONTRACTS.md §2.6.4. Idempotent on unknown / settled handles —
// the model can fire-and-forget cancels without checking state.

export interface TaskCancelInput {
  handle_id: string;
}

export interface TaskCancelOutput {
  cancelled: boolean;
  // Only present when `cancelled === false`, explains why no
  // abort was issued. Lets the model distinguish "I never
  // spawned that" from "the run already finished".
  reason?: 'unknown_handle' | 'already_settled';
}

export const taskCancelTool: Tool<TaskCancelInput, TaskCancelOutput> = {
  name: 'task_cancel',
  description:
    'Abort a subagent spawned via `task_async`. Pass a previously-returned `handle_id`. Idempotent: cancelling an unknown or already-finished handle returns `cancelled: false` with a `reason` field rather than failing. The child gets a signal abort and exits via its interrupted path; partial audit (session row, cost so far) is preserved.',
  inputSchema: {
    type: 'object',
    properties: {
      handle_id: {
        type: 'string',
        description: 'Handle id returned by `task_async`.',
      },
    },
    required: ['handle_id'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    // Note: the cascade triggered by cancel is NOT strictly
    // read-only despite `writes: false`. When the cancelled child
    // declared `isolation: worktree`, the cleanup path
    // (`cleanupWorktree`) shells out `git worktree remove --force`,
    // which mutates `.git/`. Operators with leftover handles can
    // also cancel via the explicit `agent worktree gc` command
    // surface.
    display: 'raw',
  },
  async execute(args, ctx): Promise<ToolResult<TaskCancelOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before cancel', {
        retryable: true,
      });
    }
    if (ctx.subagentHandleStore === undefined) {
      return toolError(
        'subagent.unavailable',
        'subagents are not available in this run (no registry wired)',
        {
          hint: 'task_cancel needs the same harness wiring as task_async.',
        },
      );
    }
    if (typeof args.handle_id !== 'string' || args.handle_id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "'handle_id' must be a non-empty string");
    }
    // 'model' attributes the cancel to the assistant's tool_use
    // in the persisted audit row (`settled_payload.cancelSource`).
    // The other CancelReason values (`cap_watchdog`,
    // `parent_drain`) belong to harness-internal call sites.
    const outcome = ctx.subagentHandleStore.cancel(args.handle_id, 'model');
    if (outcome.cancelled) {
      return { cancelled: true };
    }
    // Map the store's reason to the wire shape. Both
    // 'unknown' and 'already_settled' are common — model can
    // recover from either without retrying.
    return {
      cancelled: false,
      reason: outcome.reason === 'unknown' ? 'unknown_handle' : 'already_settled',
    };
  },
};
