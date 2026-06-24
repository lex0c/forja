import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';
import { playbookDirsHint } from './task-shared.ts';

// `task_list` returns a snapshot of every subagent handle the
// current session knows about — both the handles still running
// in this turn's task_async batch AND the ones rehydrated from
// prior runs of the same session. The model uses this to
// recover handle ids it may have lost track of (compaction
// dropped earlier turns, the session was resumed after a crash,
// the model needs to confirm what's still in flight before
// fanning out further).
//
// Read-only and parallel-safe by construction: it just snapshots
// the in-memory store and serializes to a tool-result envelope.
// Spec ORCHESTRATION.md §3 family.

export interface TaskListInput {
  // Optional filter by status. When omitted, returns every
  // handle (running + settled). Most useful filters:
  //   - `running`: "what am I still waiting on?"
  //   - `settled`: "what already finished, in case I need
  //                  to task_await for cached output?"
  status?: 'running' | 'settled';
}

export interface TaskListEntry {
  handle_id: string;
  name: string;
  spawned_at: number;
  status: 'running' | 'settled';
  // Settled-envelope discriminator (review fix Q3). Present
  // iff status === 'settled'. `'ran'` means the child
  // produced an outcome — the `settled` block follows. The
  // three refusal kinds carry no `settled` block; the model
  // recognizes them by `kind` alone and follows up with
  // `task_await(handle_id)` if it wants the full refusal
  // payload.
  kind?:
    | 'ran'
    | 'unknown_subagent'
    | 'depth_exceeded'
    | 'budget_exhausted'
    | 'subagent_escalation'
    | 'playbook_model_unavailable';
  // Present only for `status === 'settled'` AND `kind === 'ran'`.
  // The other settled kinds carry refusal metadata not modeled
  // here; the model resolves those via a follow-up
  // task_await(handle_id) which surfaces them as tool errors
  // with full details.
  settled?: {
    child_status: 'done' | 'interrupted' | 'exhausted' | 'error';
    reason: string;
    cost_usd: number;
    steps: number;
    duration_ms: number;
    child_session_id: string | null;
    cancel_source?: 'model' | 'cap_watchdog' | 'parent_drain';
  };
}

export interface TaskListOutput {
  // Sorted by `spawned_at` ascending so consumers see handles
  // in the order they were issued.
  handles: TaskListEntry[];
  // Counters over the FILTERED set — match the `handles` field.
  // Useful when reading a status-filtered snapshot.
  in_flight: number;
  settled: number;
  // Counters over the WHOLE store, regardless of `status`
  // filter. Lets the model decide e.g. "I asked for running,
  // but there are 3 settled handles I should task_await for
  // their cached output before fanning out more". Always
  // populated; equals `in_flight + settled` when no filter
  // was applied.
  total_in_flight: number;
  total_settled: number;
}

export const taskListTool: Tool<TaskListInput, TaskListOutput> = {
  name: 'task_list',
  description:
    'List every subagent handle the current session knows about, with status and (when settled) a one-line outcome summary. Use after a long context (compaction may have dropped earlier turns), after a resume, or when you need to confirm what is still in flight before fanning out more work. The output is a snapshot — read-only and parallel-safe. Pass `status: "running"` to filter to in-flight handles, `status: "settled"` for the ones that finished. Follow up with `task_await(handle_id)` to fetch a settled handle\'s full output.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['running', 'settled'],
        description: 'Optional filter. Omit to list every handle.',
      },
    },
  },
  metadata: {
    // Deferred (AGENTIC_CLI §7.6): rare async-subagent introspection; reached
    // via tool_search.
    deferred: true,
    category: 'misc',
    writes: false,
    idempotent: true,
    parallel_safe: true,
    display: 'raw',
  },
  async execute(args, ctx): Promise<ToolResult<TaskListOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before listing handles', {
        retryable: true,
      });
    }
    if (ctx.subagentHandleStore === undefined) {
      return toolError(
        'subagent.unavailable',
        'subagents are not available in this run (no registry wired)',
        {
          hint: `task_list needs the same harness wiring as task_async / task_await. Define agents under ${playbookDirsHint()} and bootstrap will pick them up.`,
        },
      );
    }
    const summaries = ctx.subagentHandleStore.listDetailed();
    summaries.sort((a, b) => a.spawnedAt - b.spawnedAt);
    // Compute store-wide totals BEFORE filtering — the model
    // reads them to see "how many handles exist regardless of
    // my filter" (review fix Q2). Filter-scoped counters
    // (`in_flight` / `settled`) are computed alongside the
    // mapping below.
    let totalInFlight = 0;
    let totalSettled = 0;
    for (const s of summaries) {
      if (s.status === 'running') totalInFlight += 1;
      else totalSettled += 1;
    }
    const filtered =
      args.status === undefined ? summaries : summaries.filter((s) => s.status === args.status);
    let inFlight = 0;
    let settled = 0;
    const handles: TaskListEntry[] = filtered.map((s) => {
      if (s.status === 'running') inFlight += 1;
      else settled += 1;
      const entry: TaskListEntry = {
        handle_id: s.id,
        name: s.name,
        spawned_at: s.spawnedAt,
        status: s.status,
      };
      if (s.kind !== undefined) entry.kind = s.kind;
      if (s.settled !== undefined) {
        entry.settled = {
          child_status: s.settled.childStatus,
          reason: s.settled.reason,
          cost_usd: s.settled.costUsd,
          steps: s.settled.steps,
          duration_ms: s.settled.durationMs,
          child_session_id: s.settled.childSessionId,
          ...(s.settled.cancelSource !== undefined
            ? { cancel_source: s.settled.cancelSource }
            : {}),
        };
      }
      return entry;
    });
    return {
      handles,
      in_flight: inFlight,
      settled,
      total_in_flight: totalInFlight,
      total_settled: totalSettled,
    };
  },
};
