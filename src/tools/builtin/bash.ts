import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_TIMEOUT_GRACE_MS,
  type BrokerRequest,
  type BrokerResponse,
} from '../../broker/index.ts';
import { HEAD_TAIL_DEFAULT_LINES, headTailSummary } from '../output-summarizer.ts';
import {
  ERROR_CODES,
  type SummarizedOutput,
  type Tool,
  type ToolResult,
  toolError,
} from '../types.ts';
import { resolveAndValidateBashCwd } from './_bash-cwd.ts';

// Buffer above the handler's effective timeout for the broker
// outer guard. Covers worker startup (~100ms), JSON parse, bash
// handler setup, SIGTERM → SIGKILL grace window, and response
// emission. Generous so the outer fires ONLY when the handler
// itself hung; the handler's own SIGKILL is the precise per-
// command kill.
const BROKER_OUTER_BUFFER_MS = 10_000;

export interface BashInput {
  command: string;
  timeout_ms?: number;
  cwd?: string;
}

export interface BashOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
  // Set ONLY when a non-zero exit smells like a SANDBOX restriction (EROFS on
  // a write, or blocked egress) under a restrictive profile — a diagnosis that
  // points the model/operator at the lever (write inside cwd, or set
  // `[sandbox] network = on`). Absent for ordinary command failures and for
  // host/unsandboxed runs. PURE annotation: the call is NOT re-run or
  // re-confirmed (confirm is pre-execution; the profile is immutable). See
  // PERMISSION_ENGINE.md §6.5.
  sandbox_hint?: string;
}

// Substring markers of a kernel/sandbox denial surfacing in a child's stderr —
// the OS-level text emitted when bwrap's read-only base or unshared network
// blocks a syscall, distinct from an ordinary command error. Plain lower-cased
// substring match, NOT regex: the policy/permissions surface is deliberately
// regex-free (CLAUDE.md "No regex in policy/permissions"), and these are literal
// markers. Conservative: only strong, unambiguous text (EROFS; DNS /
// unreachable-network), never "connection refused" (a local service can refuse).
const SANDBOX_EROFS_MARKER = 'read-only file system';
const SANDBOX_NET_MARKERS: readonly string[] = [
  'network is unreachable',
  'could not resolve host',
  'temporary failure in name resolution',
  'name or service not known',
  'getaddrinfo',
];

// Diagnose (NEVER remediate) a non-zero bash result that looks sandbox-caused.
// Returns an actionable hint or undefined. `host`/unsandboxed (null/undefined)
// runs are never the sandbox's doing → undefined. Messages are accurate PER
// PROFILE (each has a different writable area), and the `[sandbox] network = on`
// toggle only upgrades `cwd-rw` (the profile an exec:arbitrary call lands), so
// the network hint is suggested ONLY there — proposing it for `ro`/`home-rw`
// would point at a lever that changes nothing for those profiles.
const classifySandboxDenial = (
  stderr: string,
  profile: string | null | undefined,
): string | undefined => {
  if (profile === undefined || profile === null || profile === 'host') return undefined;
  const lower = stderr.toLowerCase();
  if (lower.includes(SANDBOX_EROFS_MARKER)) {
    if (profile === 'ro') {
      // 'ro' = whole FS read-only (the call resolved no write capability) — there
      // is NO writable area, so do NOT advise "write inside the working directory".
      return "sandbox: this call resolved to no write capability, so the entire filesystem is read-only ('ro' profile). If the command legitimately writes, its write intent wasn't detected for this call.";
    }
    if (profile === 'home-rw') {
      return "sandbox: a write was blocked (read-only file system) under 'home-rw' — the target is outside the writable area ($HOME).";
    }
    // cwd-rw / cwd-rw-net: the working directory is the writable area.
    return `sandbox: a write was blocked (read-only file system) under '${profile}' — the target is OUTSIDE the writable working directory.`;
  }
  // Network: only `cwd-rw` is actually upgraded by `[sandbox] network = on` (the
  // posture bumps an exec:arbitrary call's cwd-rw → cwd-rw-net). For `ro` /
  // `home-rw` the toggle wouldn't change the plan, so don't suggest it there.
  if (profile === 'cwd-rw' && SANDBOX_NET_MARKERS.some((m) => lower.includes(m))) {
    return `sandbox: network egress is blocked under the 'cwd-rw' profile. To let this project fetch dependencies, set [sandbox] network = "on" in its .forja/config.toml (the directory must also be trusted).`;
  }
  return undefined;
};

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
// Truncation detection (slice 117): BrokerResponse now carries
// `stdoutTruncated` / `stderrTruncated` boolean flags from the
// handler's read-capped primitive. Pre-slice we regex-tested the
// trailing `\n[... truncated; N bytes omitted]` pattern, which
// false-positive'd on user output happening to end in that exact
// string (e.g., `echo "[... truncated; 0 bytes omitted]"`). The
// boolean flags carry the truthful handler-side state.
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
    },
    required: ['command'],
  },
  metadata: {
    category: 'bash',
    writes: true,
    escapesCwd: true,
    exec: true,
    idempotent: false,
    display: 'raw',
    cost: { latency_ms_typical: 100, max_output_bytes: 4 * 1024 * 1024 },
    summarize: (result) => summarizeBashOutput(result),
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

    // Slice 150 (review): type-check cwd BEFORE `isAbsolute`. Model
    // JSON arrives unvalidated by the provider; if `args.cwd` is a
    // number / object / null, `isAbsolute(args.cwd)` throws
    // ERR_INVALID_ARG_TYPE deep inside path resolution and the
    // harness surfaces it as `internalError` rather than a clean
    // tool error. Pre-validate so the error code matches schema
    // intent and the model sees a structured "fix your input"
    // signal instead of a stack trace.
    if (args.cwd !== undefined && typeof args.cwd !== 'string') {
      return toolError(ERROR_CODES.invalidArg, 'cwd must be a string');
    }

    // Slice 160 (review): resolve + validate cwd against the session
    // subtree. Pre-slice this accepted any absolute path, letting a
    // model emit `bash {command:"cat foo", cwd:"/etc"}` to read
    // outside the engine's attribution of `read-fs:<session>/foo`.
    // The helper canonicalizes (defeating symlink escapes) and
    // refuses cwd outside session subtree. See _bash-cwd.ts.
    const cwdResult = resolveAndValidateBashCwd({ argsCwd: args.cwd, sessionCwd: ctx.cwd });
    if (!cwdResult.ok) {
      return toolError(ERROR_CODES.invalidArg, cwdResult.error);
    }
    const resolvedCwd = cwdResult.cwd;

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

    // Broker-level outer guard. The bash handler's args.timeout_ms
    // is the precise per-command kill (SIGTERM → SIGKILL); this
    // is the outer ceiling for the worker process itself in case
    // the handler logic hangs. Width = handler timeout + grace +
    // buffer; never narrower than handler timeout.
    const handlerTimeoutMs =
      typeof args.timeout_ms === 'number' ? args.timeout_ms : BASH_DEFAULT_TIMEOUT_MS;
    const brokerTimeoutMs = handlerTimeoutMs + BASH_TIMEOUT_GRACE_MS + BROKER_OUTER_BUFFER_MS;

    const start = Date.now();
    const response: BrokerResponse = await ctx.broker.execute(request, {
      signal: ctx.signal,
      timeoutMs: brokerTimeoutMs,
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

    // Slice 117 (R7 P1): read truthful truncation flags from the
    // BrokerResponse. Pre-slice we inferred via TRUNCATION_FOOTER_RE
    // matching the trailing pattern — user output ending in
    // `\n[... truncated; N bytes omitted]` (e.g., a bash command
    // that echoed that literal text) was falsely reported as
    // truncated. The handler's readCapped now carries its truthful
    // truncated flag across the wire; we read it directly.
    // Undefined (older handler / non-bash) treated as false.
    const stdoutTruncated = response.stdoutTruncated === true;
    const stderrTruncated = response.stderrTruncated === true;

    const out: BashOutput = {
      stdout: response.stdout,
      stderr: response.stderr,
      exit_code: response.exitCode,
      duration_ms,
      timed_out: false,
      truncated: stdoutTruncated || stderrTruncated,
    };
    // Annotate (never remediate) a sandbox-caused failure so the model/operator
    // sees the lever instead of an opaque EROFS / unreachable-network error.
    if (response.exitCode !== 0) {
      const hint = classifySandboxDenial(response.stderr, ctx.sandboxProfile);
      if (hint !== undefined) out.sandbox_hint = hint;
    }
    return out;
  },
};

// Per-stream byte threshold for the head-tail summarizer. Set
// lower than bash's 4 MiB raw-output cap on purpose — even a 64 KB
// stdout is heavy to carry across multiple turns, while a typical
// bash command produces a few hundred bytes. The threshold is the
// inflection point where keeping the full output costs more in
// context than the elision marker costs in fidelity.
const BASH_SUMMARIZE_THRESHOLD = 16 * 1024;

// Bash result summarizer. Head-tails stdout and stderr
// independently (operators read each as a separate stream;
// concatenating before slicing would mix them). Leaves the small
// scalar fields (`exit_code`, `duration_ms`, `timed_out`,
// `truncated`) untouched — they're load-bearing and tiny.
//
// Contract: invoked only on success results. The harness routes
// ToolError shapes through a separate path that never reaches
// `metadata.summarize`.
const summarizeBashOutput = (result: unknown): SummarizedOutput => {
  const out = result as BashOutput;
  const opts = {
    maxBytes: BASH_SUMMARIZE_THRESHOLD,
    headLines: HEAD_TAIL_DEFAULT_LINES,
    tailLines: HEAD_TAIL_DEFAULT_LINES,
  };
  const stdoutSummary = headTailSummary(out.stdout, opts);
  const stderrSummary = headTailSummary(out.stderr, opts);
  const reduced = stdoutSummary.reduced || stderrSummary.reduced;
  if (!reduced) {
    return {
      result,
      reduced: false,
      originalBytes: stdoutSummary.originalBytes + stderrSummary.originalBytes,
      policy: 'noop',
    };
  }
  return {
    result: {
      ...out,
      stdout: stdoutSummary.text,
      stderr: stderrSummary.text,
    },
    reduced: true,
    originalBytes: stdoutSummary.originalBytes + stderrSummary.originalBytes,
    policy: 'head_tail',
  };
};
