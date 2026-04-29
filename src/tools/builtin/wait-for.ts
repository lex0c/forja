import { isAbsolute, resolve } from 'node:path';
import {
  type WaitCondition,
  type WaitConditionMet,
  type WaitResult,
  waitFor,
} from '../../wait/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// Tool-surface mirror of WaitCondition. Two differences from the
// internal type:
//   - field naming uses snake_case to match the schema convention
//     used by every other Forja tool (`process_id`, `max_bytes`,
//     etc.) — JSON-schema-friendly and consistent for the model.
//   - `path` arguments are tool-input strings; the tool resolves
//     them against `ctx.cwd` before passing to the wait module
//     (which only accepts absolute paths). Same lesson learned in
//     bash_background commit 509f964.
export type WaitForCondition =
  | { kind: 'sleep'; duration_ms: number }
  | { kind: 'file_exists'; path: string }
  | { kind: 'file_change'; path: string }
  | { kind: 'port_open'; host: string; port: number }
  | {
      kind: 'http_response';
      url: string;
      status?: number;
      redirect?: 'follow' | 'manual';
    }
  | { kind: 'process_exit'; process_id: string }
  | {
      kind: 'process_output';
      process_id: string;
      pattern: string;
      // When true, `pattern` compiles as a RegExp; when false (or
      // omitted), pattern is matched as a literal string with all
      // regex meta-characters escaped. Default false — models that
      // wait for "READY" don't want to discover later that the `.`
      // matched anything.
      is_regex?: boolean;
    };

export interface WaitForInput {
  condition: WaitForCondition;
  timeout_ms: number;
  poll_interval_ms?: number;
}

export interface WaitForOutput {
  matched: boolean;
  condition_met: WaitConditionMet;
  elapsed_ms: number;
  payload?: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Validate + normalize the model-supplied condition. We refuse
// unknown kinds and missing required fields with clean tool errors
// rather than letting waitFor throw on a TypeError. Path resolution
// against ctx.cwd happens here too — relative paths land in the
// session dir, not process.cwd().
const buildCondition = (
  raw: unknown,
  ctxCwd: string,
): { ok: true; cond: WaitCondition } | { ok: false; message: string } => {
  if (!isObject(raw)) return { ok: false, message: 'condition must be an object' };
  const kind = raw.kind;
  if (typeof kind !== 'string') {
    return { ok: false, message: 'condition.kind must be a string' };
  }
  const resolvePath = (p: unknown, label: string): string | { error: string } => {
    if (typeof p !== 'string' || p.length === 0) {
      return { error: `${label} must be a non-empty string` };
    }
    // Reject `..` segments — both in relative paths (where they
    // would let the model probe outside the session cwd) and in
    // absolute paths (where they obscure the actual target). Same
    // pattern as the eval loader's workspace-containment check.
    // Absolute paths without `..` are still allowed: a model
    // legitimately waiting for `/tmp/build/done.txt` is the
    // common case, and operators trusting `wait_for` at all need
    // to trust the model with absolute paths anyway. The deeper
    // path-policy gap (no `tools.wait_for.allow_paths` section)
    // is documented in BACKLOG risks; this fix closes the cheap
    // information-leak vector without policy-engine work.
    if (p.split(/[\\/]/).includes('..')) {
      return { error: `${label} must not contain '..' segments` };
    }
    return isAbsolute(p) ? p : resolve(ctxCwd, p);
  };
  switch (kind) {
    case 'sleep': {
      const dur = raw.duration_ms;
      if (typeof dur !== 'number' || !Number.isFinite(dur) || dur < 0) {
        return { ok: false, message: 'sleep.duration_ms must be a non-negative number' };
      }
      return { ok: true, cond: { kind: 'sleep', durationMs: dur } };
    }
    case 'file_exists': {
      const r = resolvePath(raw.path, 'file_exists.path');
      if (typeof r !== 'string') return { ok: false, message: r.error };
      return { ok: true, cond: { kind: 'file_exists', path: r } };
    }
    case 'file_change': {
      const r = resolvePath(raw.path, 'file_change.path');
      if (typeof r !== 'string') return { ok: false, message: r.error };
      return { ok: true, cond: { kind: 'file_change', path: r } };
    }
    case 'port_open': {
      if (typeof raw.host !== 'string' || raw.host.length === 0) {
        return { ok: false, message: 'port_open.host must be a non-empty string' };
      }
      if (
        typeof raw.port !== 'number' ||
        !Number.isInteger(raw.port) ||
        raw.port < 1 ||
        raw.port > 65535
      ) {
        return { ok: false, message: 'port_open.port must be an integer in [1, 65535]' };
      }
      return { ok: true, cond: { kind: 'port_open', host: raw.host, port: raw.port } };
    }
    case 'http_response': {
      if (typeof raw.url !== 'string' || raw.url.length === 0) {
        return { ok: false, message: 'http_response.url must be a non-empty string' };
      }
      const status = raw.status;
      if (status !== undefined) {
        if (
          typeof status !== 'number' ||
          !Number.isInteger(status) ||
          status < 100 ||
          status > 599
        ) {
          return { ok: false, message: 'http_response.status must be an integer in [100, 599]' };
        }
      }
      const redirect = raw.redirect;
      if (redirect !== undefined && redirect !== 'follow' && redirect !== 'manual') {
        return { ok: false, message: "http_response.redirect must be 'follow' or 'manual'" };
      }
      const cond: WaitCondition = { kind: 'http_response', url: raw.url };
      if (typeof status === 'number') cond.status = status;
      if (redirect === 'follow' || redirect === 'manual') cond.redirect = redirect;
      return { ok: true, cond };
    }
    case 'process_exit': {
      if (typeof raw.process_id !== 'string' || raw.process_id.length === 0) {
        return { ok: false, message: 'process_exit.process_id must be a non-empty string' };
      }
      return { ok: true, cond: { kind: 'process_exit', processId: raw.process_id } };
    }
    case 'process_output': {
      if (typeof raw.process_id !== 'string' || raw.process_id.length === 0) {
        return { ok: false, message: 'process_output.process_id must be a non-empty string' };
      }
      if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
        return { ok: false, message: 'process_output.pattern must be a non-empty string' };
      }
      const isRegex = raw.is_regex === true;
      let regex: RegExp;
      try {
        // Literal mode escapes regex meta so "1.0" doesn't match
        // "100". Regex mode compiles directly. Reject the global
        // flag — RegExp.exec without /g is stateless across
        // calls; with /g, repeated exec advances lastIndex which
        // breaks our per-poll re-read pattern.
        regex = isRegex
          ? new RegExp(raw.pattern as string)
          : new RegExp(escapeRegexLiteral(raw.pattern as string));
        if (regex.global) {
          return {
            ok: false,
            message: "process_output.pattern must not use the global ('g') flag",
          };
        }
      } catch (e) {
        return {
          ok: false,
          message: `process_output.pattern is not a valid regex: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return {
        ok: true,
        cond: { kind: 'process_output', processId: raw.process_id, pattern: regex },
      };
    }
    default:
      return {
        ok: false,
        message: `unknown condition.kind '${kind}' (expected: sleep | file_exists | file_change | port_open | http_response | process_exit | process_output)`,
      };
  }
};

// Standard regex-literal escape. Source:
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
const escapeRegexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const waitForTool: Tool<WaitForInput, WaitForOutput> = {
  name: 'wait_for',
  description:
    "Block until a condition is met or a timeout fires. ZERO LLM cost during the wait — only wall-clock. Conditions: sleep N ms; wait for a file to appear or change; wait for a TCP port to open; wait for an HTTP endpoint to respond; wait for a bash_background process to exit; wait for a regex/literal pattern to appear in a bash_background process's output. For process_output, the wait is observational — it does NOT consume bytes, so a subsequent bash_output sees the same content (including the matched window).",
  inputSchema: {
    type: 'object',
    properties: {
      condition: {
        type: 'object',
        description:
          'The condition to wait for. Discriminated by `kind`: sleep | file_exists | file_change | port_open | http_response | process_exit | process_output.',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'sleep',
              'file_exists',
              'file_change',
              'port_open',
              'http_response',
              'process_exit',
              'process_output',
            ],
          },
          duration_ms: {
            type: 'integer',
            minimum: 0,
            description: 'For kind=sleep: how long to sleep, in milliseconds.',
          },
          path: {
            type: 'string',
            description:
              'For kind=file_exists | file_change: file path to watch. Relative paths resolve against the session cwd.',
          },
          host: {
            type: 'string',
            description: 'For kind=port_open: host to probe (e.g. "127.0.0.1").',
          },
          port: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            description: 'For kind=port_open: TCP port to probe.',
          },
          url: {
            type: 'string',
            description: 'For kind=http_response: URL to probe with HEAD.',
          },
          status: {
            type: 'integer',
            minimum: 100,
            maximum: 599,
            description:
              'For kind=http_response: optional exact status code to match. Default: any 2xx.',
          },
          redirect: {
            type: 'string',
            enum: ['follow', 'manual'],
            description:
              "For kind=http_response: 'follow' (default) traverses 3xx redirects and matches the FINAL status; 'manual' surfaces the literal status of the requested URL.",
          },
          process_id: {
            type: 'string',
            description:
              'For kind=process_exit | process_output: the process_id returned by bash_background.',
          },
          pattern: {
            type: 'string',
            description:
              'For kind=process_output: text to match in the process output. Literal string by default; set is_regex=true to interpret as a regex.',
          },
          is_regex: {
            type: 'boolean',
            description:
              'For kind=process_output: when true, `pattern` compiles as a regex. Default false (literal). The global (g) flag is rejected.',
          },
        },
        required: ['kind'],
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1,
        description: 'Hard cap on the wait. Returns matched=false on hit.',
      },
      poll_interval_ms: {
        type: 'integer',
        minimum: 10,
        description:
          'Poll interval for non-streaming conditions (file_*, port_open, http_response). Default 500ms.',
      },
    },
    required: ['condition', 'timeout_ms'],
  },
  metadata: {
    // Pure observational primitive: no command, no path mutation,
    // no policy decision worth gating beyond plan-mode (which
    // doesn't fire for misc tools). The conditions are read-only
    // probes — file existence checks, TCP connect+close, HTTP HEAD.
    category: 'misc',
    writes: false,
    idempotent: false, // wall-clock dependent
    planSafe: true, // observational; safe in plan mode
    display: 'raw',
    cost: { latency_ms_typical: 0 }, // dominated by wait, not LLM
  },
  async execute(args, ctx): Promise<ToolResult<WaitForOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before wait', { retryable: true });
    }
    if (
      typeof args.timeout_ms !== 'number' ||
      !Number.isFinite(args.timeout_ms) ||
      args.timeout_ms < 1
    ) {
      return toolError(ERROR_CODES.invalidArg, 'timeout_ms must be a positive integer (>=1ms)');
    }
    const built = buildCondition(args.condition, ctx.cwd);
    if (!built.ok) {
      return toolError(ERROR_CODES.invalidArg, built.message);
    }

    // process_* conditions need a session-bound bg manager. Surface
    // the absence as the same error code bash_output / bash_kill use
    // when ctx.bgManager is missing — consistent operator-facing
    // shape across all bg-aware tools.
    if (
      (built.cond.kind === 'process_exit' || built.cond.kind === 'process_output') &&
      ctx.bgManager === undefined
    ) {
      return toolError(
        'bg.manager_unavailable',
        `wait_for(${built.cond.kind}) requires a session-bound bg manager but none was provided`,
      );
    }

    const opts: {
      timeoutMs: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      bgManager?: typeof ctx.bgManager;
    } = {
      timeoutMs: args.timeout_ms,
      signal: ctx.signal,
    };
    if (args.poll_interval_ms !== undefined) opts.pollIntervalMs = args.poll_interval_ms;
    if (ctx.bgManager !== undefined) opts.bgManager = ctx.bgManager;

    let result: WaitResult;
    try {
      result = await waitFor(built.cond, opts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // waitFor throws synchronously when a process_* condition
      // references an unknown id or a cross-session id (mgr.getStatus
      // returned null, mgr.readOutput threw). Surface as the same
      // bg.process_not_found code that bash_output / bash_kill use.
      const isNotFound = /not found|not in this session/i.test(message);
      if (isNotFound) {
        return toolError('bg.process_not_found', `wait_for failed: ${message}`);
      }
      // Other throws are defensive guards that shouldn't fire under
      // normal use; surface as a wait-internal error.
      return toolError('wait.internal_error', `wait_for failed: ${message}`);
    }

    const out: WaitForOutput = {
      matched: result.matched,
      condition_met: result.conditionMet,
      elapsed_ms: result.elapsedMs,
    };
    if (result.payload !== undefined) out.payload = result.payload;
    return out;
  },
};
