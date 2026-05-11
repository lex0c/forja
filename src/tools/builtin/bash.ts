import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { BrokerRequest, BrokerResponse } from '../../broker/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

export interface BashInput {
  command: string;
  timeout_ms?: number;
  cwd?: string;
  read_only?: boolean;
}

export interface BashOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

// Pre-slice-82, this tool spawned bash directly via Bun.spawn. The
// PERMISSION_ENGINE.md §13.7 broker work moved the spawn into a
// worker subprocess (slice 81's createBashHandler). This tool now
// owns just the harness-facing surface: argument validation,
// cwd resolution, BrokerRequest construction, abort handling, and
// translation of BrokerResponse back into BashOutput / ToolError.
//
// The broker is REQUIRED — no inline-spawn fallback. Bootstrap
// (slice 82) wires a broker for every harness; tests inject a
// degenerate in-process broker via tests/tools/_helpers.ts. A
// missing broker surfaces `bash.spawn_failed` so misconfigured
// harnesses fail loudly rather than silently bypassing isolation.
//
// Truncation detection: the broker handler appends
// `\n[... truncated; N bytes omitted]` to capped streams. This
// tool inspects the trailing pattern to recover the `truncated`
// flag on BashOutput. Brittle by design — slice 83 may surface
// truncation via a dedicated BrokerResponse field if/when other
// handlers need it.
//
// Mid-exec abort (slice 83): passes ctx.signal to broker.execute.
// The broker propagates to the bash worker handler, which kills
// its bash subprocess via SIGTERM → SIGKILL escalation. The
// broker response then carries `error: 'aborted'`, which this
// tool maps to `tool.aborted`. No orphan subprocesses, no
// Promise.race workaround.

// Match BashSpawnFn message prefixes from src/broker/handlers/bash.ts.
const TIMED_OUT_PREFIX = 'bash handler: timed out after ';
const SPAWN_FAILED_PREFIX = 'bash handler: failed to spawn bash: ';
const HANDLER_PREFIX = 'bash handler: ';
const ABORTED_ERROR = 'aborted';
const TRUNCATION_FOOTER_RE = /\n\[\.\.\. truncated; \d+ bytes omitted]$/;

const isInvalidArgError = (msg: string): boolean =>
  msg.startsWith('bash handler: args.command must be') ||
  msg.startsWith('bash handler: args.cwd must be') ||
  msg.startsWith('bash handler: timeout_ms must be');

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  description:
    'Run a shell command via bash. Captures stdout/stderr, enforces a timeout, returns the exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute via `bash -c`.' },
      timeout_ms: {
        type: 'integer',
        minimum: 100,
        description: 'Kill the command after this many ms. Default 30000.',
      },
      cwd: { type: 'string', description: 'Working directory. Defaults to session cwd.' },
      read_only: {
        type: 'boolean',
        description:
          'Hint that the command is read-only. The permission engine may use this to allow without confirmation.',
      },
    },
    required: ['command'],
  },
  metadata: {
    category: 'bash',
    writes: true,
    escapesCwd: true,
    // Plan mode allows bash ONLY when the model declares the call
    // read-only via `args.read_only === true`. Strict equality —
    // string "true", truthy values, missing field all fail closed.
    planSafe: (args) => (args as { read_only?: unknown }).read_only === true,
    exec: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 100, max_output_bytes: 4 * 1024 * 1024 },
  },
  async execute(args, ctx): Promise<ToolResult<BashOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before exec', { retryable: true });
    }

    // Schema declares timeout_ms with minimum: 100 but providers
    // don't enforce schema constraints — model JSON arrives
    // unvalidated. The broker handler ALSO validates, but we keep
    // the harness-side check so the error code stays
    // `tool.invalid_arg` (the broker would surface its own message
    // which we map below; pre-validating just keeps the path tight).
    if (args.timeout_ms !== undefined) {
      if (
        typeof args.timeout_ms !== 'number' ||
        !Number.isFinite(args.timeout_ms) ||
        !Number.isInteger(args.timeout_ms) ||
        args.timeout_ms < 100
      ) {
        return toolError(ERROR_CODES.invalidArg, 'timeout_ms must be an integer >= 100');
      }
    }

    if (ctx.broker === undefined) {
      return toolError(
        ERROR_CODES.bashSpawnFailed,
        'bash tool requires a broker but none was configured',
      );
    }

    // Resolve cwd to absolute BEFORE handing off to the broker —
    // the broker handler resolves relative paths against its own
    // baseCwd (process.cwd() of the worker), which is NOT the same
    // as ctx.cwd. Passing an absolute path bypasses that.
    const resolvedCwd =
      args.cwd === undefined
        ? ctx.cwd
        : isAbsolute(args.cwd)
          ? args.cwd
          : resolvePath(ctx.cwd, args.cwd);

    const request: BrokerRequest = {
      toolName: 'bash',
      args: { ...args, cwd: resolvedCwd },
      // Capability strings come from the engine's resolved set. Not
      // surfaced through ToolContext today; broker handler doesn't
      // consume them, and the sandbox wrap (slice 79) reads from
      // sandboxProfile. A future slice will plumb resolved caps
      // through so audit + telemetry on the worker side can
      // discriminate scope.
      capabilities: [],
      sandboxProfile: ctx.sandboxProfile ?? null,
    };

    const start = Date.now();
    const response: BrokerResponse = await ctx.broker.execute(request, {
      signal: ctx.signal,
    });
    const duration_ms = Date.now() - start;

    // Map broker-side error messages to the tool's error vocabulary.
    if (response.error !== undefined) {
      if (response.error === ABORTED_ERROR) {
        return toolError(ERROR_CODES.aborted, 'bash command aborted by caller', {
          retryable: true,
          details: { duration_ms, command: args.command },
        });
      }
      if (response.error.startsWith(TIMED_OUT_PREFIX)) {
        const ms = response.error.slice(TIMED_OUT_PREFIX.length);
        return toolError(ERROR_CODES.bashTimeout, `bash command timed out after ${ms}`, {
          details: { duration_ms, command: args.command },
        });
      }
      if (response.error.startsWith(SPAWN_FAILED_PREFIX)) {
        const reason = response.error.slice(SPAWN_FAILED_PREFIX.length);
        return toolError(ERROR_CODES.bashSpawnFailed, `failed to spawn bash: ${reason}`);
      }
      if (isInvalidArgError(response.error)) {
        const msg = response.error.startsWith(HANDLER_PREFIX)
          ? response.error.slice(HANDLER_PREFIX.length)
          : response.error;
        return toolError(ERROR_CODES.invalidArg, msg);
      }
      // Unknown broker-side failure (broker closed, worker crashed,
      // sandbox-wrap refused, etc.). Surface as spawn_failed so the
      // model + audit see a clear "this didn't run" path.
      return toolError(ERROR_CODES.bashSpawnFailed, `bash broker call failed: ${response.error}`);
    }

    if (response.exitCode === undefined) {
      return toolError(ERROR_CODES.bashSpawnFailed, 'bash broker returned no exit code');
    }

    const stdoutTruncated = TRUNCATION_FOOTER_RE.test(response.stdout);
    const stderrTruncated = TRUNCATION_FOOTER_RE.test(response.stderr);

    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exit_code: response.exitCode,
      duration_ms,
      timed_out: false,
      truncated: stdoutTruncated || stderrTruncated,
    };
  },
};
