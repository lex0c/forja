import { isAbsolute, resolve } from 'node:path';
import { detectRedosShape } from '../../sanitize/index.ts';
import {
  type WaitCondition,
  type WaitConditionMet,
  type WaitResult,
  waitFor,
} from '../../wait/index.ts';
import { keysToSnake } from '../_keys.ts';
import { ERROR_CODES, type Tool, type ToolContext, type ToolResult, toolError } from '../types.ts';

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
    }
  // Composition: recursive WaitForCondition arrays. Sub-conditions
  // are validated and compiled by the same buildCondition routine.
  // Depth is capped to MAX_COMPOSITION_DEPTH so adversarial input
  // can't blow the stack with `all_of([all_of([all_of([...])])])`.
  | { kind: 'all_of'; conditions: WaitForCondition[] }
  | { kind: 'any_of'; conditions: WaitForCondition[] };

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

// Hard cap on composition recursion. Defensive against adversarial
// or buggy model output that emits nested all_of/any_of indefinitely.
// 5 covers any reasonable real workflow ("wait for either A or
// (B and (C or D))" is depth 3 and already gnarly to read).
const MAX_COMPOSITION_DEPTH = 5;

// Hard cap on wait wall-clock budget. The harness has its own
// `maxWallClockMs` (default 24h) that aborts any tool past that
// window — but operators that bump the harness cap for long-running
// builds re-open the gap. A model declaring `timeout_ms: 86400000`
// (24h) under a generous harness cap pins a tool slot for a day.
// 30min is generous for any real probe (build watches, dev-server
// readiness, slow integration paths) and conservative against the
// pathological case. Same cap covers the `sleep` condition's
// duration_ms, which is otherwise bounded only by timeout_ms.
const MAX_WAIT_MS = 30 * 60 * 1000;

// Validate + normalize the model-supplied condition. We refuse
// unknown kinds and missing required fields with clean tool errors
// rather than letting waitFor throw on a TypeError. Path resolution
// against ctx.cwd happens here too — relative paths land in the
// session dir, not process.cwd(). Depth tracks composition recursion
// for the all_of / any_of guard.
const buildCondition = (
  raw: unknown,
  ctxCwd: string,
  depth = 0,
): { ok: true; cond: WaitCondition } | { ok: false; message: string } => {
  if (depth > MAX_COMPOSITION_DEPTH) {
    return {
      ok: false,
      message: `composition depth exceeds limit (${MAX_COMPOSITION_DEPTH})`,
    };
  }
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
      if (typeof dur !== 'number' || !Number.isFinite(dur) || !Number.isInteger(dur) || dur < 0) {
        return { ok: false, message: 'sleep.duration_ms must be a non-negative integer' };
      }
      if (dur > MAX_WAIT_MS) {
        return {
          ok: false,
          message: `sleep.duration_ms exceeds maximum (${MAX_WAIT_MS}ms / 30min)`,
        };
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
      if (isRegex) {
        // JS regex has no per-match timeout, so an exponential
        // pattern like `(a+)+b` against a non-matching chunk would
        // freeze the harness for seconds. Reject obvious ReDoS
        // shapes at compile time (literal mode is already safe —
        // escapeRegexLiteral neutralizes every meta).
        const rejection = detectRedosShape(raw.pattern as string);
        if (rejection !== null) {
          return {
            ok: false,
            message: `process_output.pattern rejected (${rejection.code}): ${rejection.message}`,
          };
        }
      }
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
    case 'all_of':
    case 'any_of': {
      if (!Array.isArray(raw.conditions)) {
        return {
          ok: false,
          message: `${kind}.conditions must be an array of conditions`,
        };
      }
      // Recurse into each sub-condition, accumulating either the
      // first error or the validated WaitCondition list.
      const subs: WaitCondition[] = [];
      for (let i = 0; i < raw.conditions.length; i++) {
        const subRaw = raw.conditions[i];
        const subResult = buildCondition(subRaw, ctxCwd, depth + 1);
        if (!subResult.ok) {
          return {
            ok: false,
            message: `${kind}.conditions[${i}]: ${subResult.message}`,
          };
        }
        subs.push(subResult.cond);
      }
      return {
        ok: true,
        cond: { kind: kind as 'all_of' | 'any_of', conditions: subs },
      };
    }
    default:
      return {
        ok: false,
        message: `unknown condition.kind '${kind}' (expected: sleep | file_exists | file_change | port_open | http_response | process_exit | process_output | all_of | any_of)`,
      };
  }
};

// Standard regex-literal escape. Source:
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
const escapeRegexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Walks a (possibly composed) WaitCondition and reports whether any
// leaf is a process_* condition. Used to gate bgManager presence at
// the tool boundary — composition like
// `any_of([process_exit, sleep])` still needs the manager even
// though the top-level kind is any_of.
const containsProcessCondition = (cond: WaitCondition): boolean => {
  if (cond.kind === 'process_exit' || cond.kind === 'process_output') return true;
  if (cond.kind === 'all_of' || cond.kind === 'any_of') {
    return cond.conditions.some(containsProcessCondition);
  }
  return false;
};

// Per-leaf policy gating. wait_for is category='misc' (the harness's
// engine.check returns allow for misc), but several leaf kinds DO
// touch resources that the existing fs/web policy sections govern:
//   - file_exists / file_change → fs.read (tools.read_file)
//   - http_response             → web.fetch (tools.fetch_url)
//   - port_open                 → web.fetch (tools.fetch_url) via
//     a synthesized http://host:port URL — the engine extracts the
//     hostname and matches against allow_hosts/deny_hosts. Port is
//     informational; FetchPolicy is host-based today.
// Without this pass, a strict deployment that locks down
// tools.fetch_url and tools.read_file would still see wait_for probe
// arbitrary internal URLs / sensitive paths because misc-category
// tools auto-allow at the harness gate.
//
// process_* leaves are NOT re-gated: the bg process was authorized
// at spawn time via tools.bash, and reading status / log output of
// an already-running process is not a new resource access. sleep
// has no resource access.
//
// Confirm decisions also block here — the leaf has no UI surface to
// escalate a per-condition prompt. Operators that want a leaf-only
// confirm flow can opt-in by configuring deny rules instead, which
// surface a clean error back to the model.
//
// `ctx.permissionCheck` is required on ToolContext (not optional),
// so tests and production paths both inject a concrete predicate —
// no silent fall-through-allow to mask a future entrypoint that
// forgets to wire the engine.
const checkLeafPolicies = (
  cond: WaitCondition,
  ctx: ToolContext,
): { ok: true } | { ok: false; reason: string } => {
  switch (cond.kind) {
    case 'sleep':
    case 'process_exit':
    case 'process_output':
      return { ok: true };
    case 'file_exists':
    case 'file_change': {
      const decision = ctx.permissionCheck('read_file', 'fs.read', { path: cond.path });
      if (decision.kind !== 'allow') {
        return { ok: false, reason: `wait_for ${cond.kind}: ${decision.reason}` };
      }
      return { ok: true };
    }
    case 'port_open': {
      // Synthesize an http URL so the engine's URL parser extracts
      // the hostname for allow_hosts/deny_hosts matching. IPv6
      // literals (any host containing `:`) must be bracket-wrapped
      // — otherwise `http://::1:22` fails URL parsing and the
      // engine denies on "invalid URL", systematically blocking
      // legitimate IPv6 readiness checks even when allow_hosts
      // would permit. The bracketed form is what `new URL().hostname`
      // returns for IPv6, so operators writing IPv6 in allow_hosts
      // / deny_hosts must use the bracketed form (`[::1]`) — same
      // convention fetch_url already requires for IPv6 URL inputs.
      // Hostnames and IPv4 addresses pass through unchanged.
      const wrapped =
        cond.host.includes(':') && !cond.host.startsWith('[') ? `[${cond.host}]` : cond.host;
      const synthUrl = `http://${wrapped}:${cond.port}`;
      const decision = ctx.permissionCheck('fetch_url', 'web.fetch', { url: synthUrl });
      if (decision.kind !== 'allow') {
        return { ok: false, reason: `wait_for port_open: ${decision.reason}` };
      }
      return { ok: true };
    }
    case 'http_response': {
      const decision = ctx.permissionCheck('fetch_url', 'web.fetch', { url: cond.url });
      if (decision.kind !== 'allow') {
        return { ok: false, reason: `wait_for http_response: ${decision.reason}` };
      }
      return { ok: true };
    }
    case 'all_of':
    case 'any_of': {
      for (const sub of cond.conditions) {
        const r = checkLeafPolicies(sub, ctx);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
  }
};

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
          'The condition to wait for. Discriminated by `kind`: sleep | file_exists | file_change | port_open | http_response | process_exit | process_output | all_of | any_of (composition).',
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
              'all_of',
              'any_of',
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
              "For kind=http_response: 'follow' (default) follows 3xx and matches the final status; 'manual' surfaces the literal status of the requested URL.",
          },
          process_id: {
            type: 'string',
            description: 'For kind=process_exit | process_output: process_id from bash_background.',
          },
          pattern: {
            type: 'string',
            description:
              'For kind=process_output: literal text to match (or a regex when is_regex=true).',
          },
          is_regex: {
            type: 'boolean',
            description:
              'For kind=process_output: compile `pattern` as a regex (no /g flag). Default false.',
          },
          conditions: {
            type: 'array',
            description:
              'For kind=all_of | any_of: nested WaitForCondition array. all_of waits for ALL to match (AND, short-circuits on first failure); any_of races for the first match (OR, cancels siblings on success). Empty all_of([]) matches immediately; empty any_of([]) waits out the timeout. Composition depth is capped (5).',
            items: { type: 'object' },
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
    // no policy decision worth gating. The conditions are read-only
    // probes — file existence checks, TCP connect+close, HTTP HEAD.
    category: 'misc',
    writes: false,
    idempotent: false, // wall-clock dependent
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
      !Number.isInteger(args.timeout_ms) ||
      args.timeout_ms < 1
    ) {
      return toolError(ERROR_CODES.invalidArg, 'timeout_ms must be a positive integer (>=1ms)');
    }
    if (args.timeout_ms > MAX_WAIT_MS) {
      return toolError(
        ERROR_CODES.invalidArg,
        `timeout_ms exceeds maximum (${MAX_WAIT_MS}ms / 30min). The harness wall-clock cap is the upper bound; this per-tool cap is defense in depth so a generous harness configuration doesn't pin a tool slot indefinitely.`,
      );
    }
    // Schema declares minimum: 10 but providers may not enforce
    // schema constraints — model JSON arrives unvalidated.
    // poll_interval_ms < 10 (or 0, or negative) creates a near-
    // tight polling loop that hammers the filesystem / network
    // until the outer timeout fires. Reject runtime-side.
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
    const built = buildCondition(args.condition, ctx.cwd);
    if (!built.ok) {
      return toolError(ERROR_CODES.invalidArg, built.message);
    }

    // process_* conditions need a session-bound bg manager. Surface
    // the absence as the same error code bash_output / bash_kill use
    // when ctx.bgManager is missing — consistent operator-facing
    // shape across all bg-aware tools. Walk the (possibly composed)
    // condition tree so a nested `any_of([process_exit, sleep])`
    // also surfaces the missing manager as a clean tool error
    // instead of failing mid-wait with wait.internal_error.
    if (ctx.bgManager === undefined && containsProcessCondition(built.cond)) {
      return toolError(
        'bg.manager_unavailable',
        'wait_for: a process_* condition was used but no session-bound bg manager was provided',
      );
    }

    // Per-leaf policy gate. Runs AFTER buildCondition (which already
    // resolved relative paths against ctx.cwd) so allow_paths /
    // deny_paths match against the canonical absolute path the leaf
    // will probe. See checkLeafPolicies for the full rationale.
    const policy = checkLeafPolicies(built.cond, ctx);
    if (!policy.ok) {
      return toolError(ERROR_CODES.permissionDenied, policy.reason);
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
    // Convert payload keys to snake_case at the tool boundary so
    // the model sees a uniform convention across every Forja tool
    // (top-level fields AND nested payload).
    if (result.payload !== undefined) {
      out.payload = keysToSnake(result.payload) as Record<string, unknown>;
    }
    return out;
  },
};
