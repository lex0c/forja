import { isAbsolute, resolve } from 'node:path';
import { detectRedosShape } from '../../sanitize/index.ts';
import {
  type MonitorCondition,
  type MonitorEvent,
  type MonitorReason,
  monitor,
} from '../../wait/index.ts';
import { keysToSnake } from '../_keys.ts';
import { ERROR_CODES, type Tool, type ToolContext, type ToolResult, toolError } from '../types.ts';

// Tool-surface mirror of MonitorCondition (snake_case fields,
// JSON-friendly). pattern is string + is_regex (default false →
// literal escape). For monitor, the compiled RegExp ALWAYS carries
// /g — we need every match in the chunk, not just the first
// (opposite of wait_for's process_output, which rejects /g because
// `RegExp.exec` advances lastIndex across calls and breaks the
// per-poll re-read pattern).
export type MonitorForCondition =
  | { kind: 'process_output_lines'; process_id: string }
  | {
      kind: 'process_output_pattern';
      process_id: string;
      pattern: string;
      is_regex?: boolean;
    }
  | { kind: 'file_changes'; path: string };

export interface MonitorInput {
  condition: MonitorForCondition;
  // Wall-clock budget. Required — same rationale as wait_for's
  // timeout_ms: a model can't accidentally wait forever.
  duration_ms: number;
  max_events?: number;
  poll_interval_ms?: number;
}

export interface MonitorOutput {
  events: MonitorEvent[];
  reason: MonitorReason;
  elapsed_ms: number;
  process_status?: 'running' | 'exited' | 'killed' | 'failed';
  process_exit_code?: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Hard cap on monitor wall-clock budget. Same rationale as
// wait_for's MAX_WAIT_MS — the harness's maxWallClockMs is the
// canonical upper bound, but this per-tool cap defends against
// operator configurations that bump the harness cap for long
// builds. 30min is generous for any real streaming-observation
// scenario.
const MAX_DURATION_MS = 30 * 60 * 1000;

const escapeRegexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildCondition = (
  raw: unknown,
  ctxCwd: string,
): { ok: true; cond: MonitorCondition } | { ok: false; message: string } => {
  if (!isObject(raw)) return { ok: false, message: 'condition must be an object' };
  const kind = raw.kind;
  if (typeof kind !== 'string') {
    return { ok: false, message: 'condition.kind must be a string' };
  }
  switch (kind) {
    case 'process_output_lines': {
      if (typeof raw.process_id !== 'string' || raw.process_id.length === 0) {
        return {
          ok: false,
          message: 'process_output_lines.process_id must be a non-empty string',
        };
      }
      return { ok: true, cond: { kind: 'process_output_lines', processId: raw.process_id } };
    }
    case 'process_output_pattern': {
      if (typeof raw.process_id !== 'string' || raw.process_id.length === 0) {
        return {
          ok: false,
          message: 'process_output_pattern.process_id must be a non-empty string',
        };
      }
      if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
        return {
          ok: false,
          message: 'process_output_pattern.pattern must be a non-empty string',
        };
      }
      const isRegex = raw.is_regex === true;
      if (isRegex) {
        // JS regex has no per-match timeout — reject obvious
        // catastrophic-backtracking shapes at compile time so a
        // pathological pattern can't freeze the monitor loop.
        // Literal mode bypasses this check because
        // escapeRegexLiteral neutralizes every meta first.
        const rejection = detectRedosShape(raw.pattern as string);
        if (rejection !== null) {
          return {
            ok: false,
            message: `process_output_pattern.pattern rejected (${rejection.code}): ${rejection.message}`,
          };
        }
      }
      let regex: RegExp;
      try {
        // Always /g for monitor — we want EVERY match in the
        // chunk via String.matchAll. Literal mode escapes regex
        // meta first, then compiles with /g.
        regex = isRegex
          ? new RegExp(raw.pattern as string, 'g')
          : new RegExp(escapeRegexLiteral(raw.pattern as string), 'g');
      } catch (e) {
        return {
          ok: false,
          message: `process_output_pattern.pattern is not a valid regex: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return {
        ok: true,
        cond: {
          kind: 'process_output_pattern',
          processId: raw.process_id,
          pattern: regex,
        },
      };
    }
    case 'file_changes': {
      if (typeof raw.path !== 'string' || raw.path.length === 0) {
        return { ok: false, message: 'file_changes.path must be a non-empty string' };
      }
      // Path traversal guard — same as wait_for. Rejects '..'
      // segments in both relative and absolute paths to close
      // the cheap information-leak vector. Operators wanting
      // to deny `tools.monitor.allow_paths` is documented as
      // a deferred risk.
      if (raw.path.split(/[\\/]/).includes('..')) {
        return {
          ok: false,
          message: "file_changes.path must not contain '..' segments",
        };
      }
      const resolvedPath = isAbsolute(raw.path) ? raw.path : resolve(ctxCwd, raw.path);
      return { ok: true, cond: { kind: 'file_changes', path: resolvedPath } };
    }
    default:
      return {
        ok: false,
        message: `unknown condition.kind '${kind}' (expected: process_output_lines | process_output_pattern | file_changes)`,
      };
  }
};

const containsProcessKind = (cond: MonitorCondition): boolean =>
  cond.kind === 'process_output_lines' || cond.kind === 'process_output_pattern';

// Per-leaf policy gate. monitor is category='misc' but `file_changes`
// reads filesystem state outside the model's bash_output cursor —
// same surface the existing tools.read_file allow_paths / deny_paths
// govern. process_output_* leaves were authorized at spawn time
// (tools.bash) and don't need re-gating. Mirrors wait_for's
// checkLeafPolicies; see that comment block for the full rationale.
const checkLeafPolicy = (
  cond: MonitorCondition,
  ctx: ToolContext,
): { ok: true } | { ok: false; reason: string } => {
  if (cond.kind === 'file_changes') {
    const decision = ctx.permissionCheck('read_file', 'fs.read', { path: cond.path });
    if (decision.kind !== 'allow') {
      return { ok: false, reason: `monitor file_changes: ${decision.reason}` };
    }
  }
  return { ok: true };
};

export const monitorTool: Tool<MonitorInput, MonitorOutput> = {
  name: 'monitor',
  description:
    "Stream and collect events over a wall-clock budget. Returns a list of events when the budget is exhausted (duration_ms hit, max_events reached, aborted, or — for process_output_* — the process exited). ZERO LLM calls during the monitor; the model runs once at the end with the full event batch. Use cases: tail every line of a bash_background process, capture every regex match against output, watch a file for repeated mtime changes. The monitor is observational — does NOT consume bytes from the model's bash_output cursor.",
  inputSchema: {
    type: 'object',
    properties: {
      condition: {
        type: 'object',
        description:
          'The source to monitor. Discriminated by `kind`: process_output_lines | process_output_pattern | file_changes.',
        properties: {
          kind: {
            type: 'string',
            enum: ['process_output_lines', 'process_output_pattern', 'file_changes'],
          },
          process_id: {
            type: 'string',
            description: 'For kind=process_output_*: the process_id returned by bash_background.',
          },
          pattern: {
            type: 'string',
            description:
              'For kind=process_output_pattern: text to match. Literal by default; set is_regex=true to interpret as a regex. The compiled regex always carries /g — every match in a chunk becomes an event.',
          },
          is_regex: {
            type: 'boolean',
            description:
              'For kind=process_output_pattern: when true, `pattern` compiles as a regex (with /g added). Default false (literal).',
          },
          path: {
            type: 'string',
            description:
              'For kind=file_changes: file path to watch. Relative paths resolve against the session cwd. `..` segments are rejected.',
          },
        },
        required: ['kind'],
      },
      duration_ms: {
        type: 'integer',
        minimum: 1,
        description: 'Wall-clock cap. Returns reason=duration on hit.',
      },
      max_events: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional cap on the number of events. Default 100 — bounded payload that fits in a typical model context.',
      },
      poll_interval_ms: {
        type: 'integer',
        minimum: 10,
        description: 'Poll interval. Default 200ms.',
      },
    },
    required: ['condition', 'duration_ms'],
  },
  metadata: {
    // Pure observational — no command, no path mutation. Same
    // category as wait_for.
    category: 'misc',
    writes: false,
    idempotent: false, // wall-clock dependent
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<MonitorOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before monitor', { retryable: true });
    }
    if (
      typeof args.duration_ms !== 'number' ||
      !Number.isFinite(args.duration_ms) ||
      !Number.isInteger(args.duration_ms) ||
      args.duration_ms < 1
    ) {
      return toolError(ERROR_CODES.invalidArg, 'duration_ms must be a positive integer (>=1ms)');
    }
    if (args.duration_ms > MAX_DURATION_MS) {
      return toolError(
        ERROR_CODES.invalidArg,
        `duration_ms exceeds maximum (${MAX_DURATION_MS}ms / 30min)`,
      );
    }
    // Schema constraints (poll_interval_ms minimum=10, max_events
    // minimum=1) are not guaranteed at runtime — model JSON arrives
    // unvalidated. Without these checks, poll_interval_ms=0 creates
    // a tight polling loop that hammers the filesystem / network
    // until duration_ms fires; max_events<1 would terminate before
    // the first poll could even emit. Reject runtime-side.
    if (args.poll_interval_ms !== undefined) {
      if (
        typeof args.poll_interval_ms !== 'number' ||
        !Number.isFinite(args.poll_interval_ms) ||
        !Number.isInteger(args.poll_interval_ms) ||
        args.poll_interval_ms < 10
      ) {
        return toolError(ERROR_CODES.invalidArg, 'poll_interval_ms must be an integer >= 10 (ms)');
      }
    }
    if (args.max_events !== undefined) {
      if (
        typeof args.max_events !== 'number' ||
        !Number.isFinite(args.max_events) ||
        !Number.isInteger(args.max_events) ||
        args.max_events < 1
      ) {
        return toolError(ERROR_CODES.invalidArg, 'max_events must be a positive integer');
      }
    }
    const built = buildCondition(args.condition, ctx.cwd);
    if (!built.ok) {
      return toolError(ERROR_CODES.invalidArg, built.message);
    }

    if (ctx.bgManager === undefined && containsProcessKind(built.cond)) {
      return toolError(
        'bg.manager_unavailable',
        'monitor: a process_output_* condition was used but no session-bound bg manager was provided',
      );
    }

    const policy = checkLeafPolicy(built.cond, ctx);
    if (!policy.ok) {
      return toolError(ERROR_CODES.permissionDenied, policy.reason);
    }

    const opts: {
      durationMs: number;
      pollIntervalMs?: number;
      maxEvents?: number;
      signal?: AbortSignal;
      bgManager?: typeof ctx.bgManager;
    } = {
      durationMs: args.duration_ms,
      signal: ctx.signal,
    };
    if (args.poll_interval_ms !== undefined) opts.pollIntervalMs = args.poll_interval_ms;
    if (args.max_events !== undefined) opts.maxEvents = args.max_events;
    if (ctx.bgManager !== undefined) opts.bgManager = ctx.bgManager;

    let result: Awaited<ReturnType<typeof monitor>>;
    try {
      result = await monitor(built.cond, opts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isNotFound = /not found|not in this session/i.test(message);
      if (isNotFound) {
        return toolError('bg.process_not_found', `monitor failed: ${message}`);
      }
      return toolError('monitor.internal_error', `monitor failed: ${message}`);
    }

    // Convert each event's payload keys to snake_case at the tool
    // boundary so the model sees a uniform convention. Events
    // themselves keep their { kind, timestamp, payload } shape
    // (already snake-friendly); only the payload fields convert.
    const events = result.events.map((e) => ({
      ...e,
      payload: keysToSnake(e.payload) as Record<string, unknown>,
    }));
    const out: MonitorOutput = {
      events,
      reason: result.reason,
      elapsed_ms: result.elapsedMs,
    };
    if (result.processStatus !== undefined) out.process_status = result.processStatus;
    if (result.processExitCode !== undefined) out.process_exit_code = result.processExitCode;
    return out;
  },
};
