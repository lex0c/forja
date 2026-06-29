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
// drift; a transport fault disconnects + surfaces a tool error. cleanup()
// closes every live client at teardown.
//
// Scoped to slice 1: stdio only; no per-server budget caps; no live
// re-trust modal (drift → degraded, the call errors until reconfigured);
// states are set directly here (the pure transition table in state.ts is the
// documented/tested reference, enforced more strictly in a later slice).

import type { DB } from '../storage/db.ts';
import {
  bumpServerCounters,
  deleteServer,
  getManifestDecision,
  getServer,
  insertServer,
  latestTrustedManifest,
  listServers,
  patchServer,
  recordManifestDecision,
} from '../storage/repos/mcp-servers.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import { createStdioMcpClient } from './client.ts';
import type { LoadedMcpConfig } from './config.ts';
import {
  canonicalManifestJson,
  canonicalizeManifest,
  hashManifest,
  hashManifestJson,
} from './manifest.ts';
import { isMcpTerminal, mcpTransition } from './state.ts';
import { buildMcpTool, mcpWireName } from './tool-factory.ts';
import type {
  ConfirmMcpTrust,
  McpCallResult,
  McpClient,
  McpManifestTool,
  McpSandboxArg,
  McpSandboxProfile,
  McpSandboxStatus,
  McpSandboxWrap,
  McpServerConfig,
  McpServerState,
  McpStdioConfig,
} from './types.ts';

export interface McpManagerDeps {
  db: DB;
  registry: ToolRegistry;
  config: LoadedMcpConfig;
  // Operator confirmation surface. Absent ⇒ headless ⇒ fail-closed unless the
  // server is in `autoApprove`.
  confirmTrust?: ConfirmMcpTrust;
  // --auto-approve-mcp <list>: servers granted without a prompt in headless.
  autoApprove?: ReadonlySet<string>;
  // Injectable client factory (tests pass a fake; production uses the SDK
  // stdio adapter).
  makeClient?: (cfg: McpStdioConfig, sandbox?: McpSandboxArg) => McpClient;
  // Sandbox wrap for spawned servers (MCP.md §2.3). `available` is the boot-time
  // tool detection (drives default-on + the modal status); `wrap` produces the
  // bwrap/sandbox-exec argv. Absent ⇒ no sandboxing (every server runs host).
  sandbox?: { available: boolean; wrap: McpSandboxWrap };
  // Injectable clock for decided_at / last_connected_at.
  now?: () => number;
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
  // Live status of every server in the runtime (name, current state, registered
  // tool count) for /mcp + status views — the McpInitReport snapshot, queryable
  // after init.
  status(): McpServerStatus[];
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
}

const parseCachedManifestTools = (json: string): McpManifestTool[] => {
  try {
    const parsed = JSON.parse(json) as { tools?: unknown };
    if (!Array.isArray(parsed.tools)) return [];
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
    return [];
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
// lazy-connect. Combined with the session AbortSignal where one exists. The
// actual tools/call is NOT bounded here (a long tool is legitimate; per-call
// budget is a later slice).
const MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
const handshakeSignal = (sessionSignal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(MCP_HANDSHAKE_TIMEOUT_MS);
  return sessionSignal === undefined ? timeout : AbortSignal.any([sessionSignal, timeout]);
};

export const createMcpManager = (deps: McpManagerDeps): McpManager => {
  const { db, registry, config } = deps;
  const makeClient = deps.makeClient ?? createStdioMcpClient;

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

  // Build a client for a server, wrapping the spawn in the sandbox when the
  // resolved profile is non-host.
  const clientFor = (rt: ServerRuntime): McpClient => {
    const { profile } = resolveSandbox(rt.config);
    if (profile === 'host' || deps.sandbox === undefined) {
      return makeClient(rt.config.transport);
    }
    return makeClient(rt.config.transport, { profile, wrap: deps.sandbox.wrap });
  };
  const now = deps.now ?? (() => Date.now());
  const runtime = new Map<string, ServerRuntime>();

  const setState = (
    rt: ServerRuntime,
    state: McpServerState,
    patch: Record<string, unknown> = {},
  ) => {
    // Validate the edge against the lifecycle table (state.ts) — an undeclared
    // transition is a manager bug; throw rather than corrupt persisted state.
    mcpTransition(rt.state, state);
    rt.state = state;
    patchServer(db, rt.config.name, { state, ...patch });
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
    if (rt === undefined) throw new Error(`mcp: unknown server '${server}'`);
    if (isMcpTerminal(rt.state)) {
      throw new Error(`mcp: server '${server}' is ${rt.state}; not callable`);
    }
    if (rt.drifted) {
      // Pinned by a prior drift — do NOT reconnect/re-detect on every call.
      throw new Error(
        `mcp.manifest_drift: server '${server}' manifest changed since trust; reconfigure or re-trust`,
      );
    }

    if (!rt.connected) {
      const client = clientFor(rt);
      setState(rt, 'handshaking');
      try {
        const sig = handshakeSignal(ctx.signal);
        const info = await client.connect(sig);
        const liveTools = await client.listTools(sig);
        const liveHash = hashManifest(
          canonicalizeManifest({
            server,
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
          setState(rt, 'degraded', { last_error: 'manifest_drift' });
          await client.close().catch(() => {});
          throw new Error(
            `mcp.manifest_drift: server '${server}' manifest changed since it was trusted; reconfigure or re-trust`,
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
    try {
      const res = await client.callTool(toolName, args, ctx.signal);
      bumpServerCounters(db, server, { calls: 1 });
      return res;
    } catch (err) {
      rt.client = null;
      rt.connected = false;
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
    // Egress = the server can REACH the network: granted network (`cwd-rw-net`)
    // OR running unconfined (`host` — opt-out / no sandbox tool, which inherits
    // the full host network even with no `[network]` grant). Only a sandboxed
    // no-network server (`cwd-rw`) is non-egress (MCP.md §2.3).
    const egress = resolveSandbox(rt.config).profile !== 'cwd-rw';
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
      return 0;
    }
    const client = clientFor(rt);
    setState(rt, 'handshaking');
    try {
      const sig = handshakeSignal();
      const info = await client.connect(sig);
      const tools = await client.listTools(sig);
      const canonical = canonicalizeManifest({
        server: name,
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
        `mcp: server '${name}' handshake failed: ${err instanceof Error ? err.message : err}`,
      );
      return 0;
    } finally {
      await client.close().catch(() => {});
    }
  };

  // Returns true (granted) / false (denied), recording the decision in
  // mcp_manifest_history only when it's the FIRST for this (server, hash) — the
  // UNIQUE index forbids a second row, so a forced re-decision on an
  // already-recorded hash changes only this session's outcome.
  const resolveTrustDecision = async (
    rt: ServerRuntime,
    hash: string,
    manifestJson: string,
    info: { protocolVersion: string; serverVersion: string | null },
    tools: readonly McpManifestTool[],
    forceReprompt: boolean,
  ): Promise<boolean> => {
    const name = rt.config.name;
    const prior = getManifestDecision(db, name, hash);
    // Honor a prior same-hash decision UNLESS the command changed: a swapped
    // binary advertising the identical tool list must not inherit the grant.
    if (prior !== null && !forceReprompt) return prior.decision === 'granted';

    const record = (decision: 'granted' | 'denied', decidedBy: string) => {
      if (prior !== null) return; // (server, hash) already recorded — UNIQUE
      recordManifestDecision(db, {
        server_name: name,
        hash,
        // The hash this decision supersedes: the latest already-granted
        // manifest for this server (null on first trust). `rt.trustedHash` is
        // still null here (set only after the grant), so query the store.
        previous_hash: latestTrustedManifest(db, name)?.hash ?? null,
        manifest_json: manifestJson,
        protocol_version: info.protocolVersion,
        server_version: info.serverVersion,
        decision,
        decided_by: decidedBy,
        decided_at: now(),
        approval_id: null,
      });
    };

    if (deps.confirmTrust !== undefined) {
      const answer = await deps.confirmTrust({
        server: name,
        // The RAW (unresolved) command — never expose a resolved secret.
        command: rt.config.transport.rawArgv.join(' '),
        mode: forceReprompt || rt.trustedHash !== null ? 'drift' : 'first-visit',
        sandbox: resolveSandbox(rt.config).status,
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

    // Headless: fail-closed unless explicitly auto-approved.
    if (deps.autoApprove?.has(name) === true) {
      record('granted', 'auto_approve');
      return true;
    }
    record('denied', 'ci');
    return false;
  };

  // Refresh the "last trusted command" row (RAW/redacted argv) — written on
  // first sight, then refreshed (remove+insert, since command is immutable in
  // place — AUDIT §1.5) only when a grant re-authorizes a CHANGED command, so a
  // swap stays detectable across sessions until the operator re-approves it.
  const syncTrustedCommand = (rt: ServerRuntime) => {
    const rawCommandJson = JSON.stringify(rt.config.transport.rawArgv);
    const existing = getServer(db, rt.config.name);
    if (existing !== null && existing.command === rawCommandJson) return;
    if (existing !== null) deleteServer(db, rt.config.name);
    insertServer(db, {
      name: rt.config.name,
      transport: rt.config.transport.transport,
      command: rawCommandJson,
      url: null,
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
        };
        runtime.set(server.name, rt);

        // Ensure a row exists (command stored RAW/redacted). On an EXISTING
        // server whose configured command differs from the last-trusted one,
        // bypass the cache and force a re-trust — the binary was swapped.
        const rawCommandJson = JSON.stringify(server.transport.rawArgv);
        const existing = getServer(db, server.name);
        if (existing === null) {
          insertServer(db, {
            name: server.name,
            transport: server.transport.transport,
            command: rawCommandJson,
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

        // Surface every unconfined server: it spawns with full host access +
        // network (the modal shows it too, but headless / cached-trust paths
        // never open one). Both opt-out and no-tool land on the host profile.
        if (deps.sandbox !== undefined && resolveSandbox(server).profile === 'host') {
          warnings.push(
            resolveSandbox(server).status === 'opt-out'
              ? `mcp: server '${server.name}' runs UNSANDBOXED (sandbox=false) — full host access + network`
              : `mcp: server '${server.name}' will run UNSANDBOXED — no sandbox tool (bwrap/sandbox-exec) available`,
          );
        }

        const commandChanged = existing !== null && existing.command !== rawCommandJson;

        const cached = commandChanged ? null : latestTrustedManifest(db, server.name);
        // Defense-in-depth (FAILURE_MODES §14.2): the stored manifest_json is
        // the exact string that was hashed, so a granted row must re-hash to
        // its own `hash`. A mismatch means the row was tampered (DB write)
        // without updating the hash — reject the cache and re-handshake rather
        // than register from downgraded tool metadata.
        let cachedTools: McpManifestTool[] = [];
        if (cached !== null) {
          if (hashManifestJson(cached.manifest_json) === cached.hash) {
            cachedTools = parseCachedManifestTools(cached.manifest_json);
          } else {
            warnings.push(
              `mcp: cached manifest for '${server.name}' failed its hash check; re-handshaking`,
            );
          }
        }
        if (cached !== null && cachedTools.length > 0) {
          // Steady state: register from cache, no connect (lazy).
          const { registered: n, warnings: w } = registerServerTools(rt, cachedTools);
          warnings.push(...w);
          rt.trustedHash = cached.hash;
          setState(rt, 'trusted', { current_manifest_hash: cached.hash });
          registered += n;
        } else {
          if (cached !== null) {
            warnings.push(
              `mcp: cached manifest for '${server.name}' is unreadable; re-handshaking`,
            );
          }
          registered += await resolveFreshTrust(rt, warnings, commandChanged);
        }
        servers.push({ name: server.name, state: rt.state, tools: rt.registeredNames.length });
      }

      // AUDIT §1.5: an mcp_servers row is STATE — removed once the server leaves
      // config. Sweep orphans here (the append-only-forever manifest history
      // stays, so a re-added server re-uses its cached grant). Compared against
      // ALL configured names (incl. disabled), so toggling `disabled` keeps the
      // row.
      const configNames = new Set(config.servers.map((s) => s.name));
      for (const row of listServers(db)) {
        // Keep a REVOKED row even when its server leaves config: the revocation
        // must survive a config round-trip (remove + re-add), or the cached
        // forever-grant would silently re-register it. Non-revoked orphans sweep.
        if (!configNames.has(row.name) && row.revoked_at == null) deleteServer(db, row.name);
      }

      return { registered, servers, warnings };
    },

    callTool,

    state(server) {
      return runtime.get(server)?.state ?? null;
    },

    status() {
      return [...runtime.values()].map((rt) => ({
        name: rt.config.name,
        state: rt.state,
        tools: rt.registeredNames.length,
      }));
    },

    async revoke(server) {
      if (getServer(db, server) === null) {
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
      patchServer(db, server, { state: 'denied', revoked_at: now() });
      return { ok: true, tools };
    },

    async reconnect(server) {
      const cfg = config.servers.find((s) => s.name === server && s.enabled);
      if (cfg === undefined) {
        return { ok: false, reason: 'unknown or disabled server', registered: 0, warnings: [] };
      }
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
      };
      runtime.set(server, rt);
      const warnings: string[] = [];
      const registered = await resolveFreshTrust(rt, warnings, true);
      if (rt.state === 'trusted') {
        patchServer(db, server, { revoked_at: null });
        return { ok: true, registered, warnings };
      }
      // Re-denied or failed to connect: the server stays revoked + the result is
      // NOT ok, so the operator sees the real outcome (not a green "0 tools").
      return { ok: false, reason: rt.state, registered, warnings };
    },

    async cleanup() {
      for (const rt of runtime.values()) {
        const client = rt.client;
        rt.client = null;
        rt.connected = false;
        if (client !== null) await client.close().catch(() => {});
      }
    },
  };
};

// Re-export for callers building status views (/mcp, doctor) without
// importing the repo directly.
export { listServers as listMcpServerRows };
