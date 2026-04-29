import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface BashBackgroundInput {
  command: string;
  label?: string;
  cwd?: string;
  // Optional absolute runtime cap in milliseconds. When set, the
  // process is killed (SIGTERM with grace → SIGKILL) after this
  // many ms even if it's still running. Default undefined keeps
  // the long-running semantics (dev servers, watchers); set when
  // the model knows the job is bounded (a build, test run, one-
  // shot script) and wants protection against runaway loops.
  max_runtime_ms?: number;
}

export interface BashBackgroundOutput {
  process_id: string;
  os_pid: number;
  label: string | null;
  spawned_at: number;
}

export const bashBackgroundTool: Tool<BashBackgroundInput, BashBackgroundOutput> = {
  name: 'bash_background',
  description:
    'Spawn a long-running shell command in the background. Returns immediately with a process_id. Use bash_output to read incremental stdout/stderr and bash_kill to terminate. For short, blocking commands, use the bash tool instead.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute via `bash -c`.' },
      label: {
        type: 'string',
        description:
          'Short human-readable name for the process (e.g. "dev-server"). Surfaces in audit logs and future UI tray.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Defaults to session cwd.',
      },
      max_runtime_ms: {
        type: 'integer',
        minimum: 100,
        description:
          'Optional absolute runtime cap. Kills the process after this many ms via SIGTERM (with grace → SIGKILL). Omit for unbounded (dev servers, watchers).',
      },
    },
    required: ['command'],
  },
  metadata: {
    // Same category as `bash` so permission policies for bash apply
    // identically — operators don't need a second policy section to
    // gate background commands.
    category: 'bash',
    // Pessimistic: a background command typically writes (it's the
    // whole point of running a dev server, build, watcher, etc.).
    // Plan mode therefore blocks it without a `planSafe` predicate
    // — there's no read-only sense in which a long-running background
    // process makes sense in plan mode anyway.
    writes: true,
    exec: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 50 },
  },
  async execute(args, ctx): Promise<ToolResult<BashBackgroundOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before exec', { retryable: true });
    }
    if (ctx.bgManager === undefined) {
      // Configuration error, not user error — surface as a non-
      // retryable tool error so the model doesn't loop trying.
      return toolError(
        'bg.manager_unavailable',
        'bash_background requires a session-bound bg manager but none was provided',
        {
          hint: 'This usually means the harness was constructed without a bgManager. Check HarnessConfig.',
        },
      );
    }
    if (typeof args.command !== 'string' || args.command.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'command must be a non-empty string');
    }
    // Resolve cwd against the session: undefined → session cwd;
    // absolute → as-is; relative → resolve from session cwd. Same
    // pattern as the synchronous bash tool. Forwarding args.cwd
    // verbatim (or omitting it) makes the manager fall back to
    // process.cwd(), which silently runs commands in the wrong
    // directory whenever the harness was launched with a different
    // working dir than the session — e.g. evals (each case has its
    // own tmp cwd) and worktree subagents (M3+).
    const wd =
      args.cwd === undefined
        ? ctx.cwd
        : isAbsolute(args.cwd)
          ? args.cwd
          : resolve(ctx.cwd, args.cwd);

    try {
      const r = await ctx.bgManager.spawn({
        command: args.command,
        cwd: wd,
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.max_runtime_ms !== undefined ? { maxRuntimeMs: args.max_runtime_ms } : {}),
      });
      return {
        process_id: r.id,
        os_pid: r.osPid,
        label: r.label,
        spawned_at: r.spawnedAt,
      };
    } catch (e) {
      return toolError(
        'bg.spawn_failed',
        `bash_background spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};
