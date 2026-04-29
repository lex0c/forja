import { isAbsolute, resolve } from 'node:path';
import { scrubEnv } from '../../sanitize/index.ts';
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
  stopSignal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> => {
  const reader = stream.getReader();
  // Optional stop hook — when the caller signals "no more reads needed",
  // cancel the reader so any pending `read()` resolves with done=true.
  // Used by the bash tool to break out when the spawned process exits
  // but its orphaned children keep the pipe fd open. Without this,
  // `bash -c 'sleep 60 &'` (which exits immediately but leaves a
  // background sleep holding stdout) would block this function for
  // the full 60 seconds.
  const onStop = (): void => {
    reader.cancel().catch(() => {
      /* already cancelled */
    });
  };
  if (stopSignal !== undefined) {
    if (stopSignal.aborted) onStop();
    else stopSignal.addEventListener('abort', onStop, { once: true });
  }
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
    if (stopSignal !== undefined) stopSignal.removeEventListener('abort', onStop);
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

    // SIGTERM → SIGKILL escalation grace. Same window the bg manager
    // uses for per-call kill (DEFAULT_KILL_GRACE_MS=5000ms) — keeping
    // sibling parity per CODER_PLAYBOOK §4. A tighter 2s on the
    // timeout path because timeouts are already a symptom of "this
    // ran longer than expected" — no reason to give it 5 more.
    const ABORT_GRACE_MS = 5000;
    const TIMEOUT_GRACE_MS = 2000;
    let timedOut = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
    const escalateToSigkill = (graceMs: number): void => {
      killEscalationTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, graceMs);
    };
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
      escalateToSigkill(TIMEOUT_GRACE_MS);
    }, timeout);

    // Caller-abort handler. Bun.spawn honors `signal` natively (sends
    // SIGTERM on abort), but it does NOT escalate to SIGKILL if the
    // child ignores SIGTERM. A misbehaving process (e.g., one with a
    // SIGTERM trap that loops) would survive the abort and leave the
    // OS holding a process slot until natural exit. This listener
    // mirrors the bg manager's grace cycle so caller-abort gets the
    // same "polite then forceful" treatment that operator-initiated
    // kill gets via bash_kill.
    let abortObserved = false;
    const onAbort = (): void => {
      abortObserved = true;
      escalateToSigkill(ABORT_GRACE_MS);
    };
    if (ctx.signal.aborted) {
      // Pre-flight check fired above already returned, so this
      // branch is theoretically unreachable — but if a future
      // refactor moves the pre-flight check, this path keeps the
      // contract honest.
      onAbort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    // When the bash subshell dies but spawned a child (e.g.
    // `bash -c 'sleep 60 &'`), the orphaned child keeps the stdout/
    // stderr pipe fds open. Reading from those pipes blocks until
    // the orphan exits naturally — defeating the whole point of
    // the kill (the tool returns ~60s late on a 100ms abort). Once
    // the bash process itself is gone, signal the readers to stop
    // so any pending `read()` resolves with done=true. The child
    // process is now an OS-level orphan; cleanup of orphans is a
    // separate concern (M3+ resource caps), but the tool must not
    // block waiting for them.
    const readStopAc = new AbortController();
    void proc.exited.then(() => readStopAc.abort());

    let out: { text: string; truncated: boolean } = { text: '', truncated: false };
    let err: { text: string; truncated: boolean } = { text: '', truncated: false };
    let exitCode = -1;
    try {
      const [outRes, errRes, code] = await Promise.all([
        readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES, readStopAc.signal),
        readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_OUTPUT_BYTES, readStopAc.signal),
        proc.exited,
      ]);
      out = outRes;
      err = errRes;
      exitCode = code;
    } finally {
      clearTimeout(timer);
      if (killEscalationTimer !== undefined) clearTimeout(killEscalationTimer);
      ctx.signal.removeEventListener('abort', onAbort);
    }

    const duration_ms = Date.now() - start;

    // Abort takes precedence over timeout: if the caller (harness
    // wall-clock, user Ctrl+C, parent abort) cancelled the call, the
    // model should see `tool.aborted`, not a misleading 'timed out'
    // or a bare exit_code 143 from the SIGTERM kill. Surface the
    // dedicated terminal so audit / event handling routes correctly.
    if (abortObserved) {
      return toolError(ERROR_CODES.aborted, 'bash command aborted by caller', {
        retryable: true,
        details: { duration_ms, command: args.command, exit_code: exitCode },
      });
    }

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
