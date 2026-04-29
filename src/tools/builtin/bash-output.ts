import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface BashOutputInput {
  process_id: string;
  // Override the stored stdout cursor. When omitted, reads from the
  // byte offset advanced by the prior call (or 0 on first read).
  since_stdout?: number;
  // Override the stored stderr cursor. Independent — see manager
  // dual-cursor model.
  since_stderr?: number;
  // Cap on bytes returned per stream. Defaults to 64 KB to keep a
  // single tool result inside the model's context budget.
  max_bytes?: number;
}

export interface BashOutputOutput {
  process_id: string;
  status: 'running' | 'exited' | 'killed' | 'failed';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  // Byte offsets for the NEXT call. Persisted server-side; mirrored
  // here so the model can pin a specific window in retries.
  stdout_cursor: number;
  stderr_cursor: number;
  // Bytes still unread on each stream beyond the returned slice.
  // Zero means caught up; >0 means truncated by max_bytes — the
  // model should call again to fetch the remainder.
  stdout_pending: number;
  stderr_pending: number;
}

export const bashOutputTool: Tool<BashOutputInput, BashOutputOutput> = {
  name: 'bash_output',
  description:
    'Read incremental stdout/stderr from a background process started by bash_background. Advances a server-side cursor so each call returns only new bytes since the last read. Use status/exit_code to detect termination.',
  inputSchema: {
    type: 'object',
    properties: {
      process_id: {
        type: 'string',
        description: 'The process_id returned by bash_background.',
      },
      since_stdout: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional explicit byte offset for stdout. Overrides the server-side cursor for replay/skip-ahead reads.',
      },
      since_stderr: {
        type: 'integer',
        minimum: 0,
        description:
          'Optional explicit byte offset for stderr. Independent of stdout — see dual-cursor model.',
      },
      max_bytes: {
        type: 'integer',
        minimum: 1,
        description: 'Cap on bytes returned per stream. Defaults to 65536 (64 KB).',
      },
    },
    required: ['process_id'],
  },
  metadata: {
    // Category 'misc', not 'bash'. Reasoning: checkBash requires
    // `args.command` and denies when missing — bash_output only
    // carries `process_id`, so 'bash' would default-deny under any
    // strict/acceptEdits policy. The spawn-time call to
    // bash_background already passed the bash policy gate, and
    // reading output from a previously-approved process opens no
    // new attack surface. Operators who want to deny output reads
    // for already-spawned processes don't have a clean policy
    // surface today; that's a known gap (see BACKLOG Step 2.1
    // risks). The right defense is denying spawn at policy time.
    category: 'misc',
    writes: false,
    // Reading a fixed `since` window is idempotent. Reading without
    // `since` advances the cursor and is therefore not.
    idempotent: false,
    // Plan mode: reading bg output is read-only. A predicate
    // wouldn't add value (no flag to flip), so allow
    // unconditionally — the spawn was already gated.
    planSafe: true,
    display: 'raw',
    cost: { latency_ms_typical: 5 },
  },
  async execute(args, ctx): Promise<ToolResult<BashOutputOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before read', { retryable: true });
    }
    if (ctx.bgManager === undefined) {
      return toolError(
        'bg.manager_unavailable',
        'bash_output requires a session-bound bg manager but none was provided',
      );
    }
    if (typeof args.process_id !== 'string' || args.process_id.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'process_id must be a non-empty string');
    }
    try {
      const opts: { sinceStdout?: number; sinceStderr?: number; maxBytes?: number } = {};
      if (args.since_stdout !== undefined) opts.sinceStdout = args.since_stdout;
      if (args.since_stderr !== undefined) opts.sinceStderr = args.since_stderr;
      if (args.max_bytes !== undefined) opts.maxBytes = args.max_bytes;
      const r = await ctx.bgManager.readOutput(args.process_id, opts);
      return {
        process_id: args.process_id,
        status: r.status,
        exit_code: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        stdout_cursor: r.stdoutCursor,
        stderr_cursor: r.stderrCursor,
        stdout_pending: r.stdoutPending,
        stderr_pending: r.stderrPending,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The manager throws with /not found/ or /not in this session/
      // — both are clean tool-error surface, not retryable.
      const isNotFound = /not found|not in this session/i.test(message);
      return toolError(
        isNotFound ? 'bg.process_not_found' : 'bg.output_failed',
        `bash_output failed: ${message}`,
      );
    }
  },
};
