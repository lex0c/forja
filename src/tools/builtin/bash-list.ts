import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// One row in the snapshot. Deliberately a SUBSET of the durable
// `background_processes` row — the model needs the id (to follow up
// with bash_output/bash_kill), the command/label (to recognize what
// it launched), and lifecycle (status/exit_code/spawned_at). Log
// paths, cursors, and byte-drop counters stay out: internal bookkeeping
// the model never acts on.
export interface BashListEntry {
  process_id: string;
  command: string;
  label: string | null;
  status: 'running' | 'exited' | 'killed' | 'failed';
  exit_code: number | null;
  spawned_at: number;
}

export interface BashListInput {
  // Optional status filter. Omit to list every process this session
  // knows about. `running` is the common case ("what's still in
  // flight?"); the terminal statuses recover a finished process's id.
  status?: 'running' | 'exited' | 'killed' | 'failed';
}

export interface BashListOutput {
  processes: BashListEntry[];
  // Count of `running` rows in the FULL session set (not the filtered
  // view) — a cheap "is anything still in flight?" signal even when the
  // model filtered to a terminal status.
  running: number;
  // Total rows in the full session set, unfiltered.
  total: number;
}

export const bashListTool: Tool<BashListInput, BashListOutput> = {
  name: 'bash_list',
  description:
    'List the background processes started by bash_background in this session, with their status and exit code. Read-only snapshot. Use it to recover a process_id you lost (across turns or after compaction), or to see what is still running. Follow up with bash_output(process_id) for output or bash_kill(process_id) to stop one.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['running', 'exited', 'killed', 'failed'],
        description:
          'Optional filter. Omit to list every process. "running" shows only what is still in flight.',
      },
    },
    required: [],
  },
  metadata: {
    // Deferred (AGENTIC_CLI §7.6): rare bg-job management; reached via tool_search.
    deferred: true,
    // 'misc', not 'bash': like bash_output/bash_kill, this carries no
    // `args.command`, so the bash policy gate (which requires one)
    // would default-deny. A read-only snapshot of already-spawned
    // processes opens no new surface — the spawn already passed policy.
    category: 'misc',
    writes: false,
    // Hard dependency on the session-bound bg manager (same as
    // bash_output/bash_kill) — surfaces to the subagent validator.
    requiresBgManager: true,
    idempotent: true,
    display: 'raw',
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<BashListOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before list', { retryable: true });
    }
    if (ctx.bgManager === undefined) {
      return toolError(
        'bg.manager_unavailable',
        'bash_list requires a session-bound bg manager but none was provided',
      );
    }
    if (
      args.status !== undefined &&
      args.status !== 'running' &&
      args.status !== 'exited' &&
      args.status !== 'killed' &&
      args.status !== 'failed'
    ) {
      return toolError(
        ERROR_CODES.invalidArg,
        'status must be one of running | exited | killed | failed',
      );
    }
    // Full set first (for the running/total counts), then apply the
    // optional filter to the returned rows. Two reads are cheap (pure
    // SQL); the alternative — count in JS over the full list — needs
    // the full list anyway, so this keeps the counts honest without a
    // second query path.
    const all = ctx.bgManager.list();
    const filtered = args.status === undefined ? all : all.filter((p) => p.status === args.status);
    return {
      processes: filtered.map((p) => ({
        process_id: p.id,
        command: p.command,
        label: p.label,
        status: p.status,
        exit_code: p.exitCode,
        spawned_at: p.spawnedAt,
      })),
      running: all.filter((p) => p.status === 'running').length,
      total: all.length,
    };
  },
};
