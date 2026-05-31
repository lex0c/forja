import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';
import { resolveAndValidateBashCwd } from './_bash-cwd.ts';

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
    writes: true,
    // See bash.ts — same rationale: bg commands typically spawn
    // processes and may touch filesystem outside cwd. Drives the
    // checkpoint-restore warning.
    escapesCwd: true,
    exec: true,
    // Hard dependency on `ToolContext.bgManager`. Without it
    // every invocation returns the bgmanager-missing tool-error;
    // the subagent validator pulls the failure forward to
    // bootstrap-time so an author whose whitelist includes this
    // tool finds out before first invocation.
    requiresBgManager: true,
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
    // Schema declares `minimum: 100` but providers may not enforce
    // schema constraints — model JSON arrives unvalidated. Without
    // these checks, a non-numeric value (e.g. "abc") gets coerced
    // by setTimeout into a silly delay (NaN → 1ms-ish), and a
    // numeric value below 100ms terminates the process before any
    // useful work could happen — defeating the documented
    // "minimum runtime cap" semantics. Reject runtime-side with
    // a clean tool error that matches the schema declaration.
    // No upper bound: bash_background is the right tool for long
    // dev servers / watchers / pytest --watch where the runtime is
    // legitimately unbounded.
    if (args.max_runtime_ms !== undefined) {
      if (
        typeof args.max_runtime_ms !== 'number' ||
        !Number.isFinite(args.max_runtime_ms) ||
        !Number.isInteger(args.max_runtime_ms) ||
        args.max_runtime_ms < 100
      ) {
        return toolError(ERROR_CODES.invalidArg, 'max_runtime_ms must be an integer >= 100 (ms)');
      }
    }
    // Slice 150 (review): type-check label and cwd. Pre-slice both
    // were forwarded to the manager without a runtime type guard.
    //   - `label` non-string (e.g. `label: 42` or `label: {x: 1}`)
    //     reached the storage layer and landed in audit logs / UI
    //     tray as a non-string, breaking downstream renders that
    //     expect string|null. Spec §17.4 documents label as a
    //     human-readable name.
    //   - `cwd` non-string would throw ERR_INVALID_ARG_TYPE inside
    //     `isAbsolute(args.cwd)`, surfaced as `internalError` from
    //     the harness instead of a clean tool error. Same gap the
    //     sync bash tool had pre-slice; fixed here in parallel.
    if (args.label !== undefined && typeof args.label !== 'string') {
      return toolError(ERROR_CODES.invalidArg, 'label must be a string');
    }
    if (args.cwd !== undefined && typeof args.cwd !== 'string') {
      return toolError(ERROR_CODES.invalidArg, 'cwd must be a string');
    }
    // Slice 160 (review): same cwd-subtree refuse as the synchronous
    // bash tool. Pre-slice forwarding args.cwd verbatim let a model
    // emit `bash_background {command:"...", cwd:"/etc"}` and run a
    // long-lived process outside the engine's capability attribution.
    // The helper resolves + canonicalizes + refuses cwd outside the
    // session subtree. See _bash-cwd.ts.
    const cwdResult = resolveAndValidateBashCwd({ argsCwd: args.cwd, sessionCwd: ctx.cwd });
    if (!cwdResult.ok) {
      return toolError(ERROR_CODES.invalidArg, cwdResult.error);
    }
    const wd = cwdResult.cwd;

    try {
      const r = await ctx.bgManager.spawn({
        command: args.command,
        cwd: wd,
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.max_runtime_ms !== undefined ? { maxRuntimeMs: args.max_runtime_ms } : {}),
        // §6.5: pass the engine's chosen profile through so the bg
        // manager's Bun.spawn wraps with bwrap when applicable.
        ...(ctx.sandboxProfile !== undefined ? { sandboxProfile: ctx.sandboxProfile } : {}),
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
