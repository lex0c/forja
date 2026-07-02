// McpManager — owns the connection lifecycle for every configured MCP
// server. Built broker-style in bootstrap (eager, no sessionId needed),
// threaded via HarnessConfig, closed at session teardown.
//
// init() resolves trust per server and registers the tools of trusted ones
// into the shared ToolRegistry. Two paths:
//
//   • cached-trusted (a prior `granted` manifest exists) → register from the
//     cached manifest_json WITHOUT connecting (lazy; the spawn is deferred to
//     the first tools/call, MCP.md §1.3). Drift is caught at that first call.
//   • fresh / never-trusted → connect once to fetch the manifest, hash it,
//     resolve the trust decision (prompt / --auto-approve-mcp / fail-closed),
//     register on grant, then close (lazy reconnect on first call).
//
// callTool() lazy-connects, re-hashes the live manifest, and degrades on
// drift (pinned until re-trust); bounds each call at the per-server budget
// timeout (a timeout keeps the server active + the connection reusable, a
// transport fault disconnects); enforces the per-session call/token caps
// (MCP.md §5); degrades on a malformed result + recovers after 3 well-formed
// ones (§15.5); and surfaces a tool error. cleanup() closes every live client
// at teardown.
//
// Transport-agnostic: stdio (spawned + sandboxed + stderr-tee'd) and remote
// (sse / streamable-http, inherently egress) both arrive as an `McpClient` via
// createMcpClient; only the spawn-specific bits (sandbox, stderr, the boot
// UNSANDBOXED warning) branch on stdio. Scope notes: a finer soft-warning-
// before-hard-cap budget tier + remote OAuth are future; states are set directly
// here (the pure transition table in state.ts is the documented reference).

import { join } from 'node:path';
import type { FailureEventSink } from '../failures/index.ts';
import { charsToTokens } from '../providers/tokens.ts';
import type { DB } from '../storage/db.ts';
import {
  type McpServerRow,
  bumpServerCounters,
  deleteServer,
  getManifestDecision,
  getServer,
  insertServer,
  latestTrustedManifest,
  listServers,
  patchServer,
  recordManifestDecision,
  updateManifestDecision,
} from '../storage/repos/mcp-servers.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import { createMcpClient } from './client.ts';
import type { LoadedMcpConfig } from './config.ts';
import {
  canonicalManifestJson,
  canonicalizeManifest,
  hashManifest,
  hashManifestJson,
} from './manifest.ts';
import { isMcpTerminal, mcpTransition } from './state.ts';
import { buildMcpTool, mcpWireName } from './tool-factory.ts';
import { DEFAULT_MCP_BUDGET, McpCallError } from './types.ts';
import type {
  ConfirmMcpTrust,
  McpCallResult,
  McpClient,
  McpManifestTool,
  McpRemoteConfig,
  McpSandboxArg,
  McpSandboxProfile,
  McpSandboxStatus,
  McpSandboxWrap,
  McpServerConfig,
  McpServerSource,
  McpServerState,
  McpStdioConfig,
  McpTransportConfig,
  McpTrustAnswer,
} from './types.ts';

export interface McpManagerDeps {
  db: DB;
  registry: ToolRegistry;
  config: LoadedMcpConfig;
  // Operator confirmation surface. Absent ⇒ headless ⇒ fail-closed unless the
  // server is in `autoApprove`.
  confirmTrust?: ConfirmMcpTrust;
  // --auto-approve-mcp <list>: servers granted without a prompt (headless AND
  // interactive — an operator who listed a server opted out of both its prompts).
  autoApprove?: ReadonlySet<string>;
  // Session working directory — the fallback cwd a stdio server spawns in when it
  // declares no `cwd` (matches the client's `process.cwd()` spawn fallback). Folds
  // into the stdio trust identity so a relative executable launched from a
  // different directory re-triggers trust. Defaults to `process.cwd()`.
  cwd?: string;
  // Repo root of the current project, used as the STORAGE scope for project
  // servers (AUDIT §1.5): `sessions.db` is user-global but project config is
  // per-repo, so a project server's rows key on `(projectRoot, name)` to isolate
  // the same `<name>` across repos. `user` servers key on '' (global). Defaults
  // to the session cwd.
  projectRoot?: string;
  // Injectable client factory (tests pass a fake; production uses the SDK
  // stdio adapter). `stderrLogPath` is where the adapter tees the server's
  // stderr (mcp-<name>.log) — undefined ⇒ drain-to-discard.
  makeClient?: (
    cfg: McpTransportConfig,
    sandbox?: McpSandboxArg,
    stderrLogPath?: string,
  ) => McpClient;
  // Directory for per-server stderr logs (`<traceDir>/mcp-<name>.log`, read by
  // `/mcp logs`). Absent ⇒ stderr is drained-to-discard (still prevents the
  // child blocking on a full pipe), no on-disk trail.
  traceDir?: string;
  // Sandbox wrap for spawned servers (MCP.md §2.3). `available` is the boot-time
  // tool detection (drives default-on + the modal status); `wrap` produces the
  // bwrap/sandbox-exec argv. Absent ⇒ no sandboxing (every server runs host).
  sandbox?: { available: boolean; wrap: McpSandboxWrap };
  // Injectable clock for decided_at / last_connected_at.
  now?: () => number;
  // Audit sink for per-server budget/timeout failure_events (MCP.md §5/§15).
  // Absent ⇒ no audit rows (headless/test). Emits are best-effort — an audit
  // failure never breaks a tool call.
  failureSink?: FailureEventSink;
}

export interface McpServerStatus {
  name: string;
  state: McpServerState;
  tools: number;
}

export interface McpInitReport {
  registered: number;
  servers: McpServerStatus[];
  warnings: string[];
}

export interface McpManager {
  init(): Promise<McpInitReport>;
  callTool(
    server: string,
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<McpCallResult>;
  state(server: string): McpServerState | null;
  // The storage scopes this session owns (the current repo root + the global user
  // scope ''), for scoping `/mcp list` reads to the session's servers.
  scopes(): string[];
  // The storage scope of a configured server by name (from its source), or null
  // when the server isn't in this session's config — lets `/mcp show` read the
  // right `(scope, name)` row instead of guessing.
  scopeFor(server: string): string | null;
  // Live status of every server in the runtime (name, current state, registered
  // tool count) for /mcp + status views — the McpInitReport snapshot, queryable
  // after init.
  status(): McpServerStatus[];
  // Absolute path to a server's stderr log (`<traceDir>/mcp-<name>.log`) for
  // `/mcp logs`, or null when no traceDir is configured (headless/test). The
  // file is created lazily on the server's first stderr byte, so the path may
  // not exist yet — the caller checks.
  logPath(name: string): string | null;
  // Operator revocation (`/mcp revoke`): deny the server, unregister its tools
  // (the next turn's tool list drops them), and persist the revocation so a
  // relaunch keeps it denied. Between-turns only.
  revoke(server: string): Promise<{ ok: boolean; reason?: string; tools: number }>;
  // Operator re-trust (`/mcp reconnect`): clear any revocation, reset the
  // runtime, and re-run the trust handshake (re-prompting as needed) + re-
  // register the tools. Between-turns only.
  reconnect(
    server: string,
  ): Promise<{ ok: boolean; reason?: string; registered: number; warnings: string[] }>;
  cleanup(): Promise<void>;
}

interface ServerRuntime {
  config: McpServerConfig;
  state: McpServerState;
  trustedHash: string | null;
  client: McpClient | null;
  connected: boolean;
  // Pinned after a manifest drift — stops callTool from re-spawning and
  // re-detecting the same drift on every subsequent call.
  drifted: boolean;
  registeredNames: string[];
  // Per-SESSION budget counters (MCP.md §5), distinct from the DB's cumulative
  // total_calls / total_tokens_in (lifetime stats for /mcp show). Drive the
  // configured-cap disconnect. sessionCalls counts ATTEMPTS (incl. timeouts);
  // sessionTokensIn accrues only on a successful call's result. The manager is
  // broker-style — ONE instance across the process's many sessions (each REPL
  // prompt is a fresh session, MCP.md §1.1) — so callTool resets these when
  // `budgetSession` no longer matches the calling session, or they'd accumulate
  // process-wide instead of per-session (and the §15.6 "blocked until the next
  // session" never lifts).
  budgetSession: string | null;
  sessionCalls: number;
  sessionTokensIn: number;
  // mcp.budget.exceeded is emitted once per trip — the cap check re-fires on
  // every refused call (disconnected is not terminal), so gate the audit row.
  // Reset alongside the counters on a session change.
  budgetEmitted: boolean;
  // Consecutive well-formed outputs since an output.invalid degrade (MCP.md
  // §15.5). At 3 the server recovers degraded→active. Reset by any invalid
  // output. Only meaningful while output-degraded (a DRIFT degrade is pinned via
  // `drifted` and throws before the call, so it never reaches this counter).
  validStreak: number;
}

// Returns null when the cached JSON is structurally UNUSABLE (a parse error, or
// `tools` missing / not an array) — distinct from a valid manifest that simply
// declares ZERO tools (returns []). The caller relies on that distinction: a
// hash-verified empty manifest is a legitimate cached grant to register (nothing
// to add, but still trusted + no re-handshake), whereas null means re-handshake.
const parseCachedManifestTools = (json: string): McpManifestTool[] | null => {
  try {
    const parsed = JSON.parse(json) as { tools?: unknown };
    if (!Array.isArray(parsed.tools)) return null;
    return parsed.tools.filter((t): t is McpManifestTool => {
      const r = t as Record<string, unknown> | null;
      return (
        r !== null &&
        typeof r === 'object' &&
        typeof r.name === 'string' &&
        typeof r.description === 'string' &&
        // typeof null === 'object' and arrays are objects — exclude both so a
        // tampered row can't register a tool with a null/array inputSchema.
        r.inputSchema !== null &&
        typeof r.inputSchema === 'object' &&
        !Array.isArray(r.inputSchema) &&
        // `meta` is dereferenced by buildMetadata (`meta.writes`); a tampered
        // row with meta missing/null/array would otherwise throw mid-register.
        r.meta !== null &&
        typeof r.meta === 'object' &&
        !Array.isArray(r.meta)
      );
    });
  } catch {
    return null;
  }
};

// Append _2.._999 until the registry has no such tool, keeping ≤ 64 chars.
const dedupeWireName = (base: string, taken: (name: string) => boolean): string => {
  if (!taken(base)) return base;
  const stem = base.slice(0, 60);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}_${i}`;
    if (!taken(candidate)) return candidate;
  }
  return base; // exhausted — register() will throw and the caller warns
};

// Bound the handshake (connect + tools/list) so a wedged or hostile server
// can't hang the agent. This matters most at init(), which is on the bootstrap
// critical path with no operator to Ctrl-C; it also caps a mid-session
// lazy-connect. Combined with the session AbortSignal where one exists.
const MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
const handshakeSignal = (sessionSignal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(MCP_HANDSHAKE_TIMEOUT_MS);
  return sessionSignal === undefined ? timeout : AbortSignal.any([sessionSignal, timeout]);
};

// Bound a single tools/call at the server's budget timeout (MCP.md §5), combined
// with the session signal. The standalone `timeout` is returned so the caller
// can tell a TIMEOUT (→ stay active, surface a tool error, §15.3) from a session
// cancel or a transport fault (→ disconnect).
const callSignal = (
  timeoutMs: number,
  sessionSignal?: AbortSignal,
): { signal: AbortSignal; timeout: AbortSignal } => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = sessionSignal === undefined ? timeout : AbortSignal.any([sessionSignal, timeout]);
  return { signal, timeout };
};

// Rough token estimate of the result that flows back to the model — feeds the
// per-server max_tokens_in budget (a soft operational bound, not exact). Uses the
// shared chars→tokens heuristic. The structured-content stringify is wrapped:
// it can't throw on a JSON-origin value, but the estimate must NEVER crash the
// success path of an already-completed call.
const estimateResultTokens = (res: McpCallResult): number => {
  let chars = res.content.length;
  if (res.structured !== undefined) {
    try {
      chars += JSON.stringify(res.structured).length;
    } catch {
      // Unserializable (shouldn't happen for wire-parsed JSON) → content only.
    }
  }
  return charsToTokens(chars);
};

// The persisted stdio command identity: the raw argv + the EFFECTIVE working
// directory + the UNRESOLVED env bindings.
//
// `cwd` (`cfg.cwd`, else the session cwd — the same `cfg.cwd ?? process.cwd()`
// the client spawns AND sandbox-wraps with) is folded in because it is
// load-bearing twice over: it is the base a relative `argv[0]`/script resolves
// against (`["node", "./server.js"]` runs a DIFFERENT script from another
// directory) AND it is the sandbox's writable root (`cwd-rw` makes only the cwd
// writable). So ANY cwd change — even for an absolute or PATH-binary `argv[0]` —
// moves what runs or what the server can write, and must re-trigger the
// pre-connect gate + manifest prompt rather than ride the cached grant. The argv
// stays RAW (a `$VAR` binary never resolves at rest; the modal shows the literal).
//
// The env bindings are the UNRESOLVED table (`SECRET = "$SECRET"`) so adding or
// changing a credential re-trusts before the next spawn passes the newly-resolved
// secret to an approved command — without persisting the resolved value. Sorted
// for a determinism-stable identity; omitted entirely when there is no env.
//
// The CONTAINMENT posture is folded too — `sandbox: false` (opt-out) and a
// `network` grant both change what an approved server can reach (host FS / the
// network) yet touch neither argv, cwd, nor env. Without them in the identity a
// gitignored `.forja/mcp.local.toml` could flip `sandbox = false` (or add
// `network.allow_hosts`) on an already-trusted server and the cached grant would
// silently reuse — spawning it UNSANDBOXED with no re-prompt. The DECLARED intent
// is folded (config-derived, machine-independent), NOT the resolved profile
// (which depends on bwrap availability, so it must not perturb the identity across
// machines). Both are OMITTED at their default (sandboxed, no network) so a plain
// server's identity stays byte-identical to before this fold.
const stdioCommandIdentity = (
  t: McpStdioConfig,
  posture: Pick<McpServerConfig, 'sandbox' | 'network'>,
  sessionCwd: string,
): string => {
  const rawEnv = t.rawEnv;
  const env =
    rawEnv !== undefined && Object.keys(rawEnv).length > 0
      ? Object.fromEntries(Object.entries(rawEnv).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : undefined;
  const net =
    posture.network !== undefined
      ? [...posture.network.allowHosts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : undefined;
  return JSON.stringify({
    argv: t.rawArgv,
    cwd: t.cwd ?? sessionCwd,
    ...(env !== undefined ? { env } : {}),
    ...(posture.sandbox === false ? { sandbox: false } : {}),
    ...(net !== undefined ? { net } : {}),
  });
};

// The operator-facing command form for the trust modal: just the RAW argv. The
// env bindings + cwd are load-bearing risk surface (`LD_PRELOAD` / `NODE_OPTIONS`
// inject code into the spawned process, surviving even the sandbox `--clearenv`;
// a relocated cwd moves the writable root / a relative binary) — but they are
// carried as SEPARATE modal fields (see `trustModalFields`) and rendered on their
// own lines, NOT folded here: the command line is length-capped in the render, so
// folding them in would let a hostile config pad the argv to hide an injected env.
const stdioDisplay = (t: McpStdioConfig): string => t.rawArgv.join(' ');

// The stdio env bindings + explicit cwd for the trust modal — the UNRESOLVED
// bindings (`SECRET=$SECRET`), sorted, so no resolved secret enters the prompt.
// Empty for a remote server or a stdio server with no env/cwd.
const trustModalExtras = (
  cfg: McpServerConfig,
): { env?: { name: string; value: string }[]; cwd?: string } => {
  const t = cfg.transport;
  if (t.transport !== 'stdio') return {};
  const rawEnv = t.rawEnv;
  const env =
    rawEnv !== undefined && Object.keys(rawEnv).length > 0
      ? Object.entries(rawEnv)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, value]) => ({ name, value }))
      : undefined;
  return {
    ...(env !== undefined ? { env } : {}),
    ...(t.cwd !== undefined ? { cwd: t.cwd } : {}),
  };
};

// The persisted remote URL identity: the raw (unexpanded) URL + the RESOLVED
// ORIGIN + the bearer auth env-var NAME (when bound).
//
// The `origin` (scheme://host:port of the resolved endpoint) is folded in because
// a `url = "$MCP_URL"` re-pointed to a different origin keeps the SAME rawUrl
// (`$MCP_URL`), so the raw form alone wouldn't re-trigger trust — and the next
// connection would send the configured bearer to a new, unreviewed endpoint. The
// origin is NON-secret: a `$VAR` token expands into the path/query (never the
// authority), and userinfo (`user:pass@`) is rejected at parse — so persisting +
// showing the origin leaks nothing while catching an origin change. Only the auth
// NAME (never the token) enters the identity.
const resolvedOrigin = (t: McpRemoteConfig): string => {
  try {
    return new URL(t.url).origin;
  } catch {
    // parseRemoteTransport already validated http(s) at load; defensive fallback.
    return t.url;
  }
};

const remoteUrlIdentity = (t: McpRemoteConfig): string =>
  JSON.stringify({
    url: t.rawUrl,
    origin: resolvedOrigin(t),
    ...(t.authEnv !== undefined ? { auth: t.authEnv } : {}),
  });

// Operator-facing form for the trust modal: the RAW (unexpanded) URL, plus the
// resolved ORIGIN when the raw form doesn't already reveal it — e.g. `url =
// "$MCP_URL"` shows `$MCP_URL → https://actual-host` so the operator can verify
// WHICH host will receive the connection + bearer before approving. The origin is
// non-secret (see `resolvedOrigin`); a `$VAR` in the raw form stays literal, so no
// path/query secret leaks either way.
const remoteDisplay = (t: McpRemoteConfig): string => {
  const origin = resolvedOrigin(t);
  return t.rawUrl.startsWith(origin) ? t.rawUrl : `${t.rawUrl} → ${origin}`;
};

// The trust IDENTITY of a transport — what persists to mcp_servers and what a
// change re-triggers trust on. Secrets never land at rest — stdio: the raw argv +
// the effective cwd + the UNRESOLVED env bindings; remote: the raw (unexpanded)
// URL + the auth env-var NAME. `display` is the operator-facing form for the
// trust modal — the RAW argv (stdio) / the RAW URL + the resolved origin when the
// raw form hides it (remote); no folded metadata otherwise.
const transportIdentity = (
  cfg: McpServerConfig,
  sessionCwd: string,
): { command: string | null; url: string | null; display: string } => {
  const t = cfg.transport;
  return t.transport === 'stdio'
    ? { command: stdioCommandIdentity(t, cfg, sessionCwd), url: null, display: stdioDisplay(t) }
    : { command: null, url: remoteUrlIdentity(t), display: remoteDisplay(t) };
};

// Did the persisted server's transport identity change vs the configured one (a
// swapped binary / re-pointed URL / changed transport kind / moved cwd for a
// relative executable / changed credential binding / changed containment posture
// ⇒ force a re-trust)? Compares the persisted identity forms.
const transportChanged = (
  existing: McpServerRow,
  cfg: McpServerConfig,
  sessionCwd: string,
): boolean => {
  const t = cfg.transport;
  return (
    existing.transport !== t.transport ||
    (t.transport === 'stdio'
      ? existing.command !== stdioCommandIdentity(t, cfg, sessionCwd)
      : existing.url !== remoteUrlIdentity(t))
  );
};

export const createMcpManager = (deps: McpManagerDeps): McpManager => {
  const { db, registry, config } = deps;
  const makeClient = deps.makeClient ?? createMcpClient;
  // The cwd that folds into a stdio server's trust identity (see
  // stdioCommandIdentity). Matches the client's `process.cwd()` spawn fallback so
  // the identity tracks the directory a relative executable actually resolves in.
  const sessionCwd = deps.cwd ?? process.cwd();
  // Storage scope (AUDIT §1.5): project servers key their rows on the repo root,
  // `user` servers on '' (global, shared across repos). Isolates the same `<name>`
  // in different repos so approving one repo's server can't clobber another's.
  const projectRoot = deps.projectRoot ?? sessionCwd;
  const scopeOf = (cfg: { source: McpServerSource }): string =>
    cfg.source === 'user' ? '' : projectRoot;

  // Resolve a server's effective sandbox posture (MCP.md §2.3): default-ON when
  // a tool is available; `sandbox = false` opts out; a wired-but-unavailable
  // tool degrades to host (and warns at init). `deps.sandbox` absent ⇒ feature
  // off ⇒ host with no warning.
  const resolveSandbox = (
    cfg: McpServerConfig,
  ): { profile: McpSandboxProfile; status: McpSandboxStatus } => {
    if (cfg.sandbox === false) return { profile: 'host', status: 'opt-out' };
    if (deps.sandbox === undefined || !deps.sandbox.available) {
      return { profile: 'host', status: 'unavailable' };
    }
    if (cfg.network !== undefined) return { profile: 'cwd-rw-net', status: 'sandboxed-net' };
    return { profile: 'cwd-rw', status: 'sandboxed' };
  };

  // Per-server stderr log path (`<traceDir>/mcp-<name>.log`). Every name that
  // reaches here is config-validated to `^[a-z][a-z0-9_]*$` (clientFor uses
  // `rt.config.name`; `/mcp logs` gates on `getServer`), but `logPath` is public
  // on the interface — co-locate a defensive traversal guard so a future un-
  // gated caller can't escape `traceDir`. undefined ⇒ drain-to-discard.
  const serverLogPath = (name: string): string | undefined => {
    if (deps.traceDir === undefined) return undefined;
    if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..')) {
      return undefined;
    }
    return join(deps.traceDir, `mcp-${name}.log`);
  };

  // Build a client for a server. A remote server has no subprocess — no sandbox,
  // no stderr log; the createMcpClient dispatch handles the transport. A stdio
  // server is wrapped in the sandbox when the resolved profile is non-host.
  const clientFor = (rt: ServerRuntime): McpClient => {
    const transport = rt.config.transport;
    if (transport.transport !== 'stdio') {
      return makeClient(transport, undefined, undefined);
    }
    const { profile } = resolveSandbox(rt.config);
    const logPath = serverLogPath(rt.config.name);
    if (profile === 'host' || deps.sandbox === undefined) {
      return makeClient(transport, undefined, logPath);
    }
    return makeClient(transport, { profile, wrap: deps.sandbox.wrap }, logPath);
  };
  const now = deps.now ?? (() => Date.now());
  const runtime = new Map<string, ServerRuntime>();

  // Best-effort budget/timeout audit row (MCP.md §5/§15). Session-scoped, so it
  // takes the call's ctx.sessionId; an emit failure must never break the call.
  const emitFailure = (event: {
    code: string;
    recovery: string;
    userVisible: boolean;
    sessionId: string;
    payload: Record<string, unknown>;
  }): void => {
    // No sink, or no real session to key the chain to — a malformed ctx would
    // otherwise default to BOOTSTRAP_SESSION_ID and pollute the bootstrap chain
    // with per-session events.
    if (deps.failureSink === undefined || !event.sessionId) return;
    try {
      deps.failureSink.emit({
        code: event.code,
        classe: 'mcp',
        recovery_action: event.recovery,
        user_visible: event.userVisible,
        session_id: event.sessionId,
        payload: event.payload,
      });
    } catch {
      // Audit is best-effort; the tool call proceeds regardless.
    }
  };

  const setState = (
    rt: ServerRuntime,
    state: McpServerState,
    patch: Record<string, unknown> = {},
  ) => {
    // Validate the edge against the lifecycle table (state.ts) — an undeclared
    // transition is a manager bug; throw rather than corrupt persisted state.
    mcpTransition(rt.state, state);
    rt.state = state;
    patchServer(db, scopeOf(rt.config), rt.config.name, { state, ...patch });
  };

  // Forward declaration: the tool `call` closure captures this; it is always
  // invoked AFTER init() assigns everything.
  const callTool = async (
    server: string,
    toolName: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<McpCallResult> => {
    const rt = runtime.get(server);
    if (rt === undefined)
      throw new McpCallError('mcp.unknown_server', `mcp: unknown server '${server}'`, false);
    if (isMcpTerminal(rt.state)) {
      // Terminal (denied / error): retrying is futile until the operator acts.
      throw new McpCallError(
        'mcp.not_callable',
        `mcp: server '${server}' is ${rt.state}; not callable — run /mcp reconnect ${server}`,
        false,
      );
    }
    if (rt.drifted) {
      // Pinned by a prior drift — do NOT reconnect/re-detect on every call, and do
      // NOT tell the model to retry (it will throw identically until a re-trust).
      throw new McpCallError(
        'mcp.manifest_drift',
        `mcp.manifest_drift: server '${server}' manifest changed since trust; not retryable — run /mcp reconnect ${server}`,
        false,
      );
    }

    // Reset the per-session counters when a new session calls this server (the
    // broker-style manager outlives any one session). This is what makes the cap
    // per-SESSION and lifts the §15.6 "blocked until the next session" disconnect
    // — a server budget-disconnected last session gets a fresh budget now.
    if (rt.budgetSession !== ctx.sessionId) {
      rt.budgetSession = ctx.sessionId;
      rt.sessionCalls = 0;
      rt.sessionTokensIn = 0;
      rt.budgetEmitted = false;
    }

    // Per-session budget (MCP.md §5/§15.6): a runaway server that has burned its
    // configured call/token cap is disconnected for the rest of the session —
    // checked BEFORE any (re)connect so a capped server can't even re-spawn. The
    // cap is the operator's configured value (the loader already clamped it to
    // the absolute ceiling). A finer soft-warning-then-hard tier lands later.
    const budget = rt.config.budget ?? DEFAULT_MCP_BUDGET;
    if (
      rt.sessionCalls >= budget.maxCallsPerSession ||
      rt.sessionTokensIn >= budget.maxTokensInPerSession
    ) {
      if (rt.client !== null) await rt.client.close().catch(() => {});
      rt.client = null;
      rt.connected = false;
      setState(rt, 'disconnected', { last_error: 'mcp.budget.exceeded' });
      // Once per trip — the cap check re-fires on every refused call this session
      // (disconnected is not terminal), but the breach happened once.
      if (!rt.budgetEmitted) {
        rt.budgetEmitted = true;
        emitFailure({
          code: 'mcp.budget.exceeded',
          recovery: 'pending_repair', // disconnected, awaiting next session / reconnect
          userVisible: true,
          sessionId: ctx.sessionId,
          payload: {
            server,
            calls: rt.sessionCalls,
            tokens_in: rt.sessionTokensIn,
            max_calls: budget.maxCallsPerSession,
            max_tokens_in: budget.maxTokensInPerSession,
          },
        });
      }
      throw new McpCallError(
        'mcp.budget.exceeded',
        `mcp.budget.exceeded: server '${server}' hit its budget cap (calls=${rt.sessionCalls}/${budget.maxCallsPerSession}, tokens_in=${rt.sessionTokensIn}/${budget.maxTokensInPerSession}); disconnected until the next session — not retryable this session`,
        false,
      );
    }

    // Charge the ATTEMPT against the per-session cap BEFORE (re)connecting or
    // calling. A handshake that FAILS (connect/listTools throws or times out)
    // must consume the budget too — otherwise the increment below (past the
    // handshake) never runs, and a broken/malicious server that dies during every
    // handshake would be respawned on each model retry indefinitely, never
    // tripping the budget-disconnect above. Counts once per callTool invocation.
    rt.sessionCalls += 1;

    if (!rt.connected) {
      const client = clientFor(rt);
      setState(rt, 'handshaking');
      try {
        const sig = handshakeSignal(ctx.signal);
        const info = await client.connect(sig);
        const liveTools = await client.listTools(sig);
        const liveHash = hashManifest(
          canonicalizeManifest({
            serverName: info.serverName,
            protocolVersion: info.protocolVersion,
            serverVersion: info.serverVersion,
            tools: liveTools,
          }),
        );
        if (rt.trustedHash !== null && liveHash !== rt.trustedHash) {
          // Pin the server: flag + set degraded BEFORE closing, so a throwing
          // close can't bounce us into the catch and mislabel the drift as a
          // transport fault. The flag stops the next call from reconnecting.
          rt.drifted = true;
          // Dotted form, matching the sibling persisted codes (mcp.budget.exceeded,
          // mcp.output.invalid) + the thrown McpCallError code — one spelling.
          setState(rt, 'degraded', { last_error: 'mcp.manifest_drift' });
          await client.close().catch(() => {});
          throw new McpCallError(
            'mcp.manifest_drift',
            `mcp.manifest_drift: server '${server}' manifest changed since it was trusted; not retryable — run /mcp reconnect ${server}`,
            false,
          );
        }
        rt.client = client;
        rt.connected = true;
        setState(rt, 'active', {
          last_connected_at: now(),
          protocol_version: info.protocolVersion,
          server_version: info.serverVersion,
          last_error: null,
        });
      } catch (err) {
        // Reap the child: connect() may have succeeded before the fault (e.g.
        // listTools threw / aborted), so dropping `client` without closing
        // would orphan the subprocess — and the model retries the tool call,
        // leaking one child per retry. (A drift throw already closed above; a
        // second close is a swallowed no-op.)
        await client.close().catch(() => {});
        rt.client = null;
        rt.connected = false;
        // A drift throw already set 'degraded'; only a connect/list fault
        // disconnects.
        if (rt.state === 'handshaking') {
          setState(rt, 'disconnected', {
            last_error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
    }

    const client = rt.client;
    if (client === null) throw new Error(`mcp: server '${server}' has no live client`);
    const { signal, timeout } = callSignal(budget.timeoutMs, ctx.signal);
    try {
      const res = await client.callTool(toolName, args, signal);
      // Successful call: charge tokens to the in-memory budget + the lifetime DB
      // counters (/mcp show). Lifetime total_calls counts completed calls.
      const tokensIn = estimateResultTokens(res);
      bumpServerCounters(db, scopeOf(rt.config), server, { calls: 1, tokensIn });
      rt.sessionTokensIn += tokensIn;

      // Output-validity loop (MCP.md §15.5). A malformed result degrades the
      // server and returns an ERROR to the model (retry / fall back — not
      // automatic); a streak of 3 well-formed outputs recovers it to active.
      // (A DRIFT degrade is pinned via `drifted` and throws before the call, so
      // it never reaches this recovery path.)
      if (res.invalid === true) {
        rt.validStreak = 0;
        if (rt.state === 'active') setState(rt, 'degraded', { last_error: 'mcp.output.invalid' });
        const rawTruncated = res.invalidRaw ?? '';
        emitFailure({
          code: 'mcp.output.invalid',
          recovery: 'degraded',
          userVisible: false,
          sessionId: ctx.sessionId,
          payload: { server, tool: toolName, raw_truncated: rawTruncated },
        });
        return {
          isError: true,
          // A transient, recoverable degrade — the `content` advises "retry or
          // fall back", so mark it retryable so the structured flag AGREES with
          // the human text (the factory otherwise defaults an isError to
          // non-retryable, which a flag-keying model would obey over the advice).
          retryable: true,
          content:
            `mcp.output.invalid: server '${server}' tool '${toolName}' returned a malformed result` +
            `${rawTruncated ? ` (raw: ${rawTruncated})` : ''}; retry or fall back`,
        };
      }
      if (rt.state === 'degraded') {
        rt.validStreak += 1;
        if (rt.validStreak >= 3) {
          rt.validStreak = 0;
          setState(rt, 'active', { last_error: null }); // mcp.recover_ok
        }
      }
      return res;
    } catch (err) {
      // A per-call TIMEOUT (the budget timeout fired, not a session cancel) is
      // NOT a transport fault (MCP.md §15.3): stay ACTIVE + keep the connection.
      // Safe to reuse — the SDK correlates responses to requests by JSON-RPC id,
      // so the aborted call's late reply is discarded, not mis-read as the next
      // call's; and a genuinely broken connection self-heals (the next call
      // faults and disconnects through the branch below).
      if (timeout.aborted && (ctx.signal === undefined || !ctx.signal.aborted)) {
        // Per-call event — each timeout is a distinct call failure, so (unlike
        // the once-per-trip budget row) this fires per timed-out call.
        emitFailure({
          code: 'mcp.timeout',
          recovery: 'ignored',
          userVisible: false,
          sessionId: ctx.sessionId,
          payload: { server, tool: toolName, timeout_ms: budget.timeoutMs },
        });
        throw new McpCallError(
          'mcp.timeout',
          `mcp.timeout: server '${server}' tool '${toolName}' exceeded ${budget.timeoutMs}ms`,
          true, // a timeout is transient — retrying is reasonable
        );
      }
      // Reap the failed client BEFORE dropping the reference. A transport fault
      // or session abort leaves the stdio child + pipe alive otherwise (the SDK
      // won't reap it), and the model's retry spins up a fresh client each time —
      // one leaked child per retry. Mirror the handshake-failure path above.
      await client.close().catch(() => {});
      rt.client = null;
      rt.connected = false;
      rt.validStreak = 0; // a fresh connection starts a fresh recovery streak
      setState(rt, 'disconnected', {
        last_error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const registerServerTools = (
    rt: ServerRuntime,
    tools: readonly McpManifestTool[],
  ): { registered: number; warnings: string[] } => {
    const warnings: string[] = [];
    let registered = 0;
    // Egress = the server can REACH the network. A REMOTE server is inherently
    // egress (the transport IS a network connection). A stdio server is egress
    // when it has granted network (`cwd-rw-net`) OR runs unconfined (`host` —
    // opt-out / no sandbox tool, which inherits the full host network). Only a
    // sandboxed no-network stdio server (`cwd-rw`) is non-egress (MCP.md §2.3).
    const egress =
      rt.config.transport.transport !== 'stdio' || resolveSandbox(rt.config).profile !== 'cwd-rw';
    for (const tool of tools) {
      const wire = dedupeWireName(mcpWireName(rt.config.name, tool.name), (n) => registry.has(n));
      if (registry.has(wire)) {
        warnings.push(
          `mcp: tool '${rt.config.name}:${tool.name}' collides with an existing tool (${wire}); skipped`,
        );
        continue;
      }
      try {
        registry.register(
          buildMcpTool({
            name: wire,
            server: rt.config.name,
            tool,
            serverSurface: rt.config.surface,
            egress,
            call: (args, ctx) => callTool(rt.config.name, tool.name, args, ctx),
          }),
        );
        rt.registeredNames.push(wire);
        registered += 1;
      } catch (err) {
        warnings.push(
          `mcp: failed to register '${wire}': ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return { registered, warnings };
  };

  // Connect once, hash, resolve the trust decision, register-or-deny, close.
  // `forceReprompt` (the command changed since trust) makes the decision
  // ignore a prior same-hash grant — a swapped binary must be re-authorized.
  const resolveFreshTrust = async (
    rt: ServerRuntime,
    warnings: string[],
    forceReprompt: boolean,
  ): Promise<number> => {
    const name = rt.config.name;
    // Fail-closed BEFORE spawning: with no way to grant trust (no interactive
    // prompt and not auto-approved), deny WITHOUT executing the binary. A
    // denied/untrusted server must never run — especially in CI/headless.
    if (deps.confirmTrust === undefined && deps.autoApprove?.has(name) !== true) {
      setState(rt, 'denied');
      // Say WHY + how to fix it. Otherwise a headless/CI run just silently has no
      // MCP tools — every other deny/fail path warns, this one must too.
      warnings.push(
        `mcp: server '${name}' denied — no interactive trust prompt (headless); add it to --auto-approve-mcp to enable`,
      );
      return 0;
    }
    // PRE-CONNECT IDENTITY GATE (MCP.md §1.5): authorize REACHING this server —
    // running the command / opening the URL with any configured auth — BEFORE the
    // handshake. A hostile `mcp.toml` must not spawn code or leak a bearer token
    // just to fetch the manifest, even if the operator then declines. An
    // auto-approved server (`--auto-approve-mcp`) skips it in EITHER mode — the
    // operator who listed the server opted out of its prompts, so an interactive
    // run must honor that too rather than still blocking startup on the modal; the
    // manifest decision below applies the same precedence.
    if (deps.autoApprove?.has(name) !== true && deps.confirmTrust !== undefined) {
      let answer: McpTrustAnswer;
      try {
        answer = await deps.confirmTrust({
          server: name,
          command: transportIdentity(rt.config, sessionCwd).display,
          ...trustModalExtras(rt.config),
          mode: forceReprompt ? 'drift' : 'first-visit',
          sandbox:
            rt.config.transport.transport === 'stdio' ? resolveSandbox(rt.config).status : 'remote',
          tools: [],
          manifestHash: '',
          preConnect: true,
        });
      } catch (err) {
        // A modal fault/abort during the identity gate must NOT escape init()
        // uncaught. Fail closed: `denied` (the server never reached `handshaking`,
        // so `error` would be an illegal transition from `disconnected`; `denied`
        // is the legal pre-handshake terminal, and a server we couldn't get
        // approval for must not run). The warning carries the real cause.
        setState(rt, 'denied', { last_error: err instanceof Error ? err.message : String(err) });
        warnings.push(
          `mcp: server '${name}' identity prompt failed: ${err instanceof Error ? err.message : err}`,
        );
        return 0;
      }
      if (answer !== 'yes') {
        setState(rt, 'denied');
        return 0;
      }
    }
    const client = clientFor(rt);
    setState(rt, 'handshaking');
    try {
      const sig = handshakeSignal();
      const info = await client.connect(sig);
      const tools = await client.listTools(sig);
      const canonical = canonicalizeManifest({
        serverName: info.serverName,
        protocolVersion: info.protocolVersion,
        serverVersion: info.serverVersion,
        tools,
      });
      const hash = hashManifest(canonical);
      setState(rt, 'trust_pending', {
        protocol_version: info.protocolVersion,
        server_version: info.serverVersion,
      });

      const granted = await resolveTrustDecision(
        rt,
        hash,
        canonicalManifestJson(canonical),
        info,
        tools,
        forceReprompt,
      );
      if (!granted) {
        setState(rt, 'denied');
        return 0;
      }
      // Record the now-trusted command so a future swap re-triggers the
      // command-change re-prompt (and a benign restart skips it).
      syncTrustedCommand(rt);
      const { registered, warnings: regWarnings } = registerServerTools(rt, tools);
      warnings.push(...regWarnings);
      rt.trustedHash = hash;
      setState(rt, 'trusted', { current_manifest_hash: hash });
      return registered;
    } catch (err) {
      setState(rt, 'error', { last_error: err instanceof Error ? err.message : String(err) });
      warnings.push(
        `mcp: server '${name}' handshake failed: ${err instanceof Error ? err.message : err} — run /mcp reconnect ${name} to retry`,
      );
      return 0;
    } finally {
      await client.close().catch(() => {});
    }
  };

  // Returns true (granted) / false (denied), recording the decision in
  // mcp_manifest_history. The (server, hash) pair is UNIQUE, so a forced
  // re-decision on an already-recorded hash UPDATES that row in place — a decline
  // the operator later approves (via `/mcp reconnect` or `--auto-approve-mcp`)
  // must persist the grant, not be dropped and re-prompted on the next boot; and
  // an identity change that re-hashes to the SAME manifest refreshes the row's
  // decided_at/decided_by so the audit trail shows who approved the new identity.
  const resolveTrustDecision = async (
    rt: ServerRuntime,
    hash: string,
    manifestJson: string,
    info: { protocolVersion: string; serverVersion: string | null },
    tools: readonly McpManifestTool[],
    forceReprompt: boolean,
  ): Promise<boolean> => {
    const name = rt.config.name;
    const scope = scopeOf(rt.config);
    const prior = getManifestDecision(db, scope, name, hash);
    // Honor a prior same-hash decision UNLESS the command changed: a swapped
    // binary advertising the identical tool list must not inherit the grant.
    if (prior !== null && !forceReprompt) return prior.decision === 'granted';

    const record = (decision: 'granted' | 'denied', decidedBy: string) => {
      if (prior !== null) {
        // Reaching here with a prior row means a FORCED re-decision — the early
        // return above already honored any non-forced same-hash decision, so this
        // path is only a changed identity (a swapped command/URL) or an explicit
        // `/mcp reconnect` re-prompting the operator. The (scope, server, hash)
        // triple is UNIQUE, so update the row in place to stamp THIS decision's
        // decided_at/decided_by — even when the decision VALUE is unchanged. A
        // swapped binary that re-hashes identically is still a fresh
        // authorization; `/mcp show` + the forever history must record WHO
        // approved the new identity and WHEN, not keep the stale original grant.
        updateManifestDecision(db, scope, name, hash, {
          decision,
          decided_by: decidedBy,
          decided_at: now(),
        });
        return;
      }
      recordManifestDecision(db, {
        scope,
        server_name: name,
        hash,
        // The hash this decision supersedes: the latest already-granted
        // manifest for this server (null on first trust). `rt.trustedHash` is
        // still null here (set only after the grant), so query the store.
        previous_hash: latestTrustedManifest(db, scope, name)?.hash ?? null,
        manifest_json: manifestJson,
        protocol_version: info.protocolVersion,
        server_version: info.serverVersion,
        decision,
        decided_by: decidedBy,
        decided_at: now(),
        approval_id: null,
      });
    };

    // Auto-approve wins over the prompt: an operator who listed this server in
    // `--auto-approve-mcp` opted out of its trust prompts, so grant without
    // prompting in EITHER mode (checked BEFORE confirmTrust so an interactive run
    // honors the flag instead of still opening the modal).
    if (deps.autoApprove?.has(name) === true) {
      record('granted', 'auto_approve');
      return true;
    }

    if (deps.confirmTrust !== undefined) {
      const answer = await deps.confirmTrust({
        server: name,
        // The RAW (unresolved) command / the remote URL — never a resolved secret.
        command: transportIdentity(rt.config, sessionCwd).display,
        // Env bindings + cwd as their own fields (rendered on separate lines so a
        // length-capped command can't hide an injected env — never resolved).
        ...trustModalExtras(rt.config),
        mode: forceReprompt || rt.trustedHash !== null ? 'drift' : 'first-visit',
        // A remote server has no subprocess — show 'remote' (egress, no sandbox),
        // never a stdio-oriented 'sandboxed' status that would imply containment.
        sandbox:
          rt.config.transport.transport === 'stdio' ? resolveSandbox(rt.config).status : 'remote',
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          writes: t.meta.writes ?? true,
        })),
        manifestHash: hash,
      });
      const granted = answer === 'yes';
      record(granted ? 'granted' : 'denied', 'user');
      return granted;
    }

    // Headless with no auto-approve: fail-closed.
    record('denied', 'ci');
    return false;
  };

  // Refresh the "last trusted command" row (RAW/redacted argv) — written on
  // first sight, then refreshed (remove+insert, since command is immutable in
  // place — AUDIT §1.5) only when a grant re-authorizes a CHANGED command, so a
  // swap stays detectable across sessions until the operator re-approves it.
  const syncTrustedCommand = (rt: ServerRuntime) => {
    const scope = scopeOf(rt.config);
    const id = transportIdentity(rt.config, sessionCwd);
    const existing = getServer(db, scope, rt.config.name);
    if (existing !== null && !transportChanged(existing, rt.config, sessionCwd)) return;
    if (existing !== null) deleteServer(db, scope, rt.config.name);
    insertServer(db, {
      scope,
      name: rt.config.name,
      transport: rt.config.transport.transport,
      command: id.command,
      url: id.url,
      source: rt.config.source,
      state: rt.state,
    });
  };

  return {
    async init() {
      const warnings = [...config.warnings];
      let registered = 0;
      const servers: McpServerStatus[] = [];

      for (const server of config.servers) {
        if (!server.enabled) continue;
        const rt: ServerRuntime = {
          config: server,
          state: 'disconnected',
          trustedHash: null,
          client: null,
          connected: false,
          drifted: false,
          registeredNames: [],
          budgetSession: null,
          sessionCalls: 0,
          sessionTokensIn: 0,
          budgetEmitted: false,
          validStreak: 0,
        };
        runtime.set(server.name, rt);

        // Ensure a row exists so the trust flow's state transitions persist — but
        // WITHOUT an identity yet (command + url null). The real identity is written
        // only when a grant succeeds (syncTrustedCommand). Persisting the configured
        // identity HERE would survive a DENIED re-add (the row is inserted before the
        // pre-connect identity gate runs), and the next boot — seeing `existing !==
        // null` with a matching command — would reuse the old `mcp_manifest_history`
        // grant by name, running the very command the operator just declined. With a
        // null identity, `transportChanged` reports a mismatch until a grant lands, so
        // a never-granted (or declined) server always re-trusts through the gate.
        const scope = scopeOf(server);
        const existing = getServer(db, scope, server.name);
        if (existing === null) {
          insertServer(db, {
            scope,
            name: server.name,
            transport: server.transport.transport,
            command: null,
            url: null,
            source: server.source,
            state: 'disconnected',
          });
        }
        // Operator revoked this server (`/mcp revoke`, migration 082): stay
        // denied until an explicit `/mcp reconnect` re-trusts. Do NOT re-register
        // from the cached grant (which lives in the append-only history forever).
        // Checked BEFORE the unsandboxed warning below — a revoked server never
        // spawns, so warning about its host access every boot is just noise.
        if (existing?.revoked_at != null) {
          setState(rt, 'denied');
          servers.push({ name: server.name, state: 'denied', tools: 0 });
          continue;
        }

        // Surface every unconfined STDIO server: it spawns with full host access
        // + network (the modal shows it too, but headless / cached-trust paths
        // never open one). Both opt-out and no-tool land on the host profile. A
        // remote server has no subprocess to sandbox — its egress is gated by the
        // mcp.egress permission category, not this boot warning.
        if (
          server.transport.transport === 'stdio' &&
          deps.sandbox !== undefined &&
          resolveSandbox(server).profile === 'host'
        ) {
          warnings.push(
            resolveSandbox(server).status === 'opt-out'
              ? `mcp: server '${server.name}' runs UNSANDBOXED (sandbox=false) — full host access + network`
              : `mcp: server '${server.name}' will run UNSANDBOXED — no sandbox tool (bwrap/sandbox-exec) available`,
          );
        }

        const commandChanged = existing !== null && transportChanged(existing, server, sessionCwd);

        // Reuse the cached grant ONLY when the identity-bearing row is present: the
        // row holds the command/URL that `commandChanged` verifies. If the row was
        // swept (server removed from mcp.toml, then re-added) the grant survives by
        // NAME in the append-only history, but its identity is gone — reusing it
        // would let a re-added server pointing at a DIFFERENT command/URL inherit
        // the old trust without the pre-connect identity gate. So `existing === null`
        // forces re-trust: the identity gate re-confirms the command/URL (a matching
        // manifest still honors the prior hash-decision, so only the IDENTITY is
        // re-prompted, not the tool set).
        const cached =
          commandChanged || existing === null
            ? null
            : latestTrustedManifest(db, scope, server.name);
        // Defense-in-depth (FAILURE_MODES §14.2): the stored manifest_json is
        // the exact string that was hashed, so a granted row must re-hash to
        // its own `hash`. A mismatch means the row was tampered (DB write)
        // without updating the hash — reject the cache and re-handshake rather
        // than register from downgraded tool metadata.
        let cachedTools: McpManifestTool[] | null = null;
        if (cached !== null) {
          if (hashManifestJson(cached.manifest_json) === cached.hash) {
            cachedTools = parseCachedManifestTools(cached.manifest_json);
            if (cachedTools === null) {
              warnings.push(
                `mcp: cached manifest for '${server.name}' is unreadable; re-handshaking`,
              );
            }
          } else {
            warnings.push(
              `mcp: cached manifest for '${server.name}' failed its hash check; re-handshaking`,
            );
          }
        }
        if (cached !== null && cachedTools !== null) {
          // Steady state: register from cache, no connect (lazy). A hash-verified
          // manifest with ZERO tools is a legitimate grant — register nothing but
          // stay trusted and still skip the handshake (don't re-spawn / re-auth a
          // server just because it exposes no tools).
          const { registered: n, warnings: w } = registerServerTools(rt, cachedTools);
          warnings.push(...w);
          rt.trustedHash = cached.hash;
          setState(rt, 'trusted', { current_manifest_hash: cached.hash });
          registered += n;
        } else {
          registered += await resolveFreshTrust(rt, warnings, commandChanged);
        }
        servers.push({ name: server.name, state: rt.state, tools: rt.registeredNames.length });
      }

      // AUDIT §1.5: an mcp_servers row is STATE — removed once the server leaves
      // config. Scope-aware: rows are keyed by `(scope, name)`, so this sweep only
      // considers THIS invocation's scopes — the current repo root + the global
      // user scope `''` — and deletes a `(scope, name)` no longer in config. Rows
      // of ANOTHER repo (a different scope) aren't even listed, so their cached
      // trust is never touched. Compared against ALL configured servers (incl.
      // disabled), so toggling `disabled` keeps the row. A revoked row always
      // survives (the revocation must outlast a config round-trip).
      // The '' (user) scope is GLOBAL, and a merged config can SHADOW a user
      // server with a same-named PROJECT server (project layer wins), hiding the
      // user entry from config.servers. So a '' row is orphaned only when its NAME
      // is absent from config entirely (not when merely shadowed), or a user
      // server this repo shadows would lose its cached trust. A project-scoped row
      // uses the exact (scope, name). Keys join on a space (names are
      // ^[a-z][a-z0-9_]*$, no spaces, so `<scope> <name>` can't alias).
      // A layer that fail-softed (invalid TOML, or a skipped `[servers.<name>]`
      // entry) drops its servers from config.servers even though the operator
      // never removed them. Sweeping that layer's storage scope would then delete
      // the persisted state + trust identity + cumulative counters of a still-
      // configured server — a temporary typo silently erasing cached trust. So
      // skip the sweep for any scope fed by an incompletely-loaded layer (measure
      // twice, cut once); its orphans linger harmlessly until the config parses
      // cleanly. The '' scope is fed by the user layer; projectRoot by project +
      // local (either incomplete taints the whole scope).
      const dirtyScopes = new Set<string>();
      for (const src of config.incompleteSources) dirtyScopes.add(scopeOf({ source: src }));

      const configuredKeys = new Set(config.servers.map((s) => `${scopeOf(s)} ${s.name}`));
      const configuredNames = new Set(config.servers.map((s) => s.name));
      for (const row of listServers(db, [projectRoot, ''])) {
        if (row.revoked_at != null) continue;
        if (dirtyScopes.has(row.scope)) continue;
        const orphan =
          row.scope === ''
            ? !configuredNames.has(row.name)
            : !configuredKeys.has(`${row.scope} ${row.name}`);
        if (orphan) deleteServer(db, row.scope, row.name);
      }

      return { registered, servers, warnings };
    },

    callTool,

    state(server) {
      return runtime.get(server)?.state ?? null;
    },

    scopes() {
      return [projectRoot, ''];
    },

    scopeFor(server) {
      const cfg = config.servers.find((s) => s.name === server);
      return cfg !== undefined ? scopeOf(cfg) : null;
    },

    status() {
      return [...runtime.values()].map((rt) => ({
        name: rt.config.name,
        state: rt.state,
        tools: rt.registeredNames.length,
      }));
    },

    logPath(name) {
      return serverLogPath(name) ?? null;
    },

    async revoke(server) {
      // Resolve the scope from the configured server (incl. disabled); a server
      // not in config can't be scoped and is treated as unknown.
      const cfg = config.servers.find((s) => s.name === server);
      const scope = cfg !== undefined ? scopeOf(cfg) : null;
      if (scope === null || getServer(db, scope, server) === null) {
        return { ok: false, reason: 'unknown server', tools: 0 };
      }
      const rt = runtime.get(server);
      const tools = rt?.registeredNames.length ?? 0;
      if (rt !== undefined) {
        for (const wire of rt.registeredNames) registry.unregister(wire);
        rt.registeredNames = [];
        if (rt.client !== null) {
          await rt.client.close().catch(() => {});
          rt.client = null;
          rt.connected = false;
        }
        rt.drifted = false;
        // Set directly (not via setState): revoke is a deliberate operator
        // override that must work from ANY state, including the terminal `error`
        // sink that mcpTransition would reject.
        rt.state = 'denied';
      }
      // Durable across relaunch (init skips the cached grant while revoked_at is
      // set); also covers a configured-but-not-in-runtime (disabled) server.
      patchServer(db, scope, server, { state: 'denied', revoked_at: now() });
      return { ok: true, tools };
    },

    async reconnect(server) {
      const cfg = config.servers.find((s) => s.name === server && s.enabled);
      if (cfg === undefined) {
        return { ok: false, reason: 'unknown or disabled server', registered: 0, warnings: [] };
      }
      const scope = scopeOf(cfg);
      const old = runtime.get(server);
      if (old !== undefined) {
        for (const wire of old.registeredNames) registry.unregister(wire);
        if (old.client !== null) await old.client.close().catch(() => {});
      }
      // Reset to a fresh runtime and force a re-trust (resolveFreshTrust re-
      // handshakes, re-hashes, re-prompts, re-registers; it captures its own
      // errors into the returned warnings + an error/denied state). The
      // revocation is NOT cleared up-front — a FAILED or DENIED reconnect must
      // stay revoked, or the next relaunch would silently re-register the server
      // from the cached (forever) grant. Clear it only after a successful trust.
      const rt: ServerRuntime = {
        config: cfg,
        state: 'disconnected',
        trustedHash: null,
        client: null,
        connected: false,
        drifted: false,
        registeredNames: [],
        budgetSession: null,
        sessionCalls: 0,
        sessionTokensIn: 0,
        budgetEmitted: false,
        validStreak: 0,
      };
      runtime.set(server, rt);
      const warnings: string[] = [];
      const registered = await resolveFreshTrust(rt, warnings, true);
      if (rt.state === 'trusted') {
        patchServer(db, scope, server, { revoked_at: null });
        return { ok: true, registered, warnings };
      }
      // Re-denied or failed to connect: REVOKE durably so the next relaunch's
      // init() skips the cached forever grant. Without this, a reconnect of a
      // NEVER-revoked (drifted) server that the operator just declined would leave
      // the old grant intact — next launch re-registers the stale trusted manifest
      // and a later call spawns/connects to the very server they declined. Set
      // revoked_at only when it isn't already set, so an already-revoked server
      // keeps its original (operator-revoke) timestamp. The result is NOT ok, so
      // the operator sees the real outcome.
      if (getServer(db, scope, server)?.revoked_at == null) {
        patchServer(db, scope, server, { revoked_at: now() });
      }
      return { ok: false, reason: rt.state, registered, warnings };
    },

    async cleanup() {
      for (const rt of runtime.values()) {
        const client = rt.client;
        rt.client = null;
        rt.connected = false;
        // Drop a LIVE state to `disconnected` so a later callTool on this
        // broker instance (it outlives sessions) re-handshakes through a legal
        // edge — `active`/`degraded` → `handshaking` is undeclared. Set directly
        // (like revoke): cleanup is a teardown override, not a lifecycle step.
        if (rt.state === 'active' || rt.state === 'degraded') rt.state = 'disconnected';
        if (client !== null) await client.close().catch(() => {});
      }
    },
  };
};
