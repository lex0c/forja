import { isAbsolute, resolve } from 'node:path';
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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB per CONTRACTS §2.6.3
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const truncate = (s: string): { text: string; truncated: boolean } => {
  if (s.length <= MAX_OUTPUT_BYTES) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, MAX_OUTPUT_BYTES)}\n[... truncated; ${s.length - MAX_OUTPUT_BYTES} bytes omitted]`,
    truncated: true,
  };
};

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
    writes: true, // pessimistic per CONTRACTS §2.6.3
    exec: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 100, max_output_bytes: MAX_OUTPUT_BYTES },
  },
  async execute(args, ctx): Promise<ToolResult<BashOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before exec', { retryable: true });
    }

    const timeout = Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const wd =
      args.cwd === undefined
        ? ctx.cwd
        : isAbsolute(args.cwd)
          ? args.cwd
          : resolve(ctx.cwd, args.cwd);
    const start = Date.now();

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(['bash', '-c', args.command], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: wd,
        // Bun's spawn signal typing is narrow; cast at the boundary.
        // biome-ignore lint/suspicious/noExplicitAny: Bun spawn signal typing
        ...({ signal: ctx.signal } as any),
      });
    } catch (e) {
      return toolError(
        ERROR_CODES.bashSpawnFailed,
        `failed to spawn bash: ${(e as Error).message}`,
      );
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Both kills can race against the proc exiting on its own; either
      // throws ESRCH on a dead pid. Wrap both so the timeout path never
      // leaks an exception out of the timer callback.
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      // Escalate to SIGKILL after a brief grace period.
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, 2000);
    }, timeout);

    let stdout = '';
    let stderr = '';
    let exitCode = -1;
    try {
      const [outText, errText, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      stdout = outText;
      stderr = errText;
      exitCode = code;
    } finally {
      clearTimeout(timer);
    }

    const duration_ms = Date.now() - start;

    if (timedOut) {
      return toolError(ERROR_CODES.bashTimeout, `bash command timed out after ${timeout}ms`, {
        details: { duration_ms, command: args.command },
      });
    }

    const out = truncate(stdout);
    const err = truncate(stderr);
    return {
      stdout: out.text,
      stderr: err.text,
      exit_code: exitCode,
      duration_ms,
      timed_out: false,
      truncated: out.truncated || err.truncated,
    };
  },
};
