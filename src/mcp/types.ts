// Shared MCP contracts. This module is the low-level type vocabulary for
// the subsystem and imports NEITHER the @modelcontextprotocol/sdk NOR the
// permission engine — so it can be consumed everywhere (storage, config,
// factory, manager) without dragging the SDK or a policy dependency in.
//
// The single SDK boundary is src/mcp/client.ts, which implements the
// `McpClient` interface declared here. Per-transport adapters (stdio + remote
// sse/http) all satisfy this same interface.

import type { ProviderToolInputSchema } from '../providers/types.ts';

// Where a server declaration came from — drives precedence (local >
// project > user) and the audit `source` column. Matches the AUDIT §1.5
// vocabulary.
export type McpServerSource = 'user' | 'project_shared' | 'project_local';

export interface McpStdioConfig {
  transport: 'stdio';
  // argv[0], $VAR-RESOLVED — what is actually spawned.
  command: string;
  args?: readonly string[];
  // The ORIGINAL, $VAR-UNRESOLVED argv ([command, ...args]) as written in
  // mcp.toml. Persisted to mcp_servers.command (redacted — never the resolved
  // secret value, AUDIT §1.5) and used for the command-change trust check +
  // the trust-modal command display. The binary the operator authorizes.
  rawArgv: readonly string[];
  // Extra env merged onto the minimal spawn env (PATH/HOME/USER).
  // Values may be `$VAR` references resolved from the agent session env.
  env?: Readonly<Record<string, string>>;
  // Working directory for the spawned server; defaults to the session cwd.
  cwd?: string;
}

// A REMOTE MCP server (MCP.md §2.2): no subprocess, no sandbox — the transport
// is an HTTP connection to `url`, so the tools are inherently EGRESS (the
// `mcp.egress` permission category). 'http' is streamable-HTTP (the modern
// transport); 'sse' is the legacy server-sent-events transport. Both go through
// the same `McpClient` via the SDK.
export interface McpRemoteConfig {
  transport: 'sse' | 'http';
  // The $VAR-RESOLVED endpoint the transport actually connects to. May carry a
  // secret a `$VAR` expanded into (e.g. `?token=<resolved>`), so it is NEVER
  // persisted or shown — only used for the live connection.
  url: string;
  // The ORIGINAL, $VAR-UNRESOLVED url as written in mcp.toml. The trust IDENTITY:
  // persisted to mcp_servers.url + shown in the trust modal (a change re-trusts,
  // the way a stdio `rawArgv` change does). Because it is unresolved, a
  // `url = "https://h/mcp?token=$TOKEN"` never lands at rest as the token value —
  // it stays `…?token=$TOKEN` (mirrors `McpStdioConfig.rawArgv`).
  rawUrl: string;
  // Resolved Authorization header value (e.g. `Bearer <token>`) from
  // `auth = { kind = "bearer", env = "X" }`. Resolved at load from the session
  // env — the TOKEN never persists (only the env-var NAME is in mcp.toml).
  // OAuth (`authProvider`) is a separate, later slice.
  authHeader?: string;
}

// What the manager spawns/connects. Discriminated by `transport`.
export type McpTransportConfig = McpStdioConfig | McpRemoteConfig;

// The sandbox profiles the MCP layer uses — a SUBSET of the permission engine's
// SandboxProfile, kept as a local union so this leaf module imports no policy
// dependency (the values match, so they interop at the bootstrap boundary).
// 'host' = unsandboxed.
export type McpSandboxProfile = 'host' | 'cwd-rw' | 'cwd-rw-net';

// The effective sandbox posture of a server, for the trust modal. 'sandboxed' =
// confined, no network; 'sandboxed-net' = confined + network (advisory
// allowlist, NOT host-filtered); 'opt-out' = operator set `sandbox = false`;
// 'unavailable' = sandboxing wired but no tool resolved (runs unconfined);
// 'remote' = a remote (sse/http) server — no subprocess to sandbox, inherently
// network egress (gated per-call by mcp.egress, not by a sandbox). The modal
// must NOT show a remote server as 'sandboxed' — it confines nothing.
export type McpSandboxStatus = 'sandboxed' | 'sandboxed-net' | 'opt-out' | 'unavailable' | 'remote';

// Wraps a server's spawn argv in the sandbox (bwrap / sandbox-exec). Returns the
// inner argv unchanged for 'host' or when no sandbox tool resolved (degrade);
// throws when the tool was present at boot but is gone now (fail-closed).
export type McpSandboxWrap = (args: {
  profile: McpSandboxProfile;
  cwd: string;
  innerArgv: readonly string[];
  env: NodeJS.ProcessEnv;
  // Vars that survive the sandbox's `--clearenv` regardless of the allowlist —
  // the server's declared `[servers.<name>.env]`.
  passthroughEnv?: Record<string, string>;
}) => readonly string[];

// Handed to the stdio client when a server is to be sandboxed. Absent ⇒ spawn
// unconfined (host).
export interface McpSandboxArg {
  profile: McpSandboxProfile;
  wrap: McpSandboxWrap;
}

// Per-server budget (MCP.md §5). Resolved by the loader: defaults applied, each
// field clamped to its absolute ceiling. These are the ENFORCED per-session caps
// — the manager disconnects a server that crosses a count cap and bounds every
// tools/call at `timeoutMs`. (A finer soft-warning-before-the-hard-cap tier is a
// later slice; today the configured value IS the hard cap.)
export interface McpServerBudget {
  timeoutMs: number;
  maxCallsPerSession: number;
  maxTokensInPerSession: number;
}

// §5 "Default" column — applied when an entry omits a budget field.
export const DEFAULT_MCP_BUDGET: McpServerBudget = {
  timeoutMs: 30_000,
  maxCallsPerSession: 200,
  maxTokensInPerSession: 50_000,
};

// §5 "Cap absoluto" column — the ceiling an operator's config can't exceed. The
// loader clamps each configured value DOWN to these (a `max_calls = 99999`
// becomes 1000); they are not a separate enforced threshold.
export const ABSOLUTE_MCP_BUDGET: McpServerBudget = {
  timeoutMs: 60_000,
  maxCallsPerSession: 1_000,
  maxTokensInPerSession: 500_000,
};

export interface McpServerConfig {
  // [a-z0-9_]; validated by the loader. Becomes the `<server>` half of
  // every `mcp__<server>__<tool>` wire name.
  name: string;
  // `disabled = true` in config flips this off; disabled servers are not
  // connected and their tools never register.
  enabled: boolean;
  // Whether the server's tools sit on the base model surface or behind
  // `tool_search` (the Forja-native lazy surface). Default 'deferred'.
  surface: 'base' | 'deferred';
  transport: McpTransportConfig;
  source: McpServerSource;
  // Sandbox posture (MCP.md §2.3). `undefined` ⇒ default-on when a sandbox tool
  // (bwrap / sandbox-exec) is available; `false` ⇒ explicit operator opt-out
  // (run the server unconfined).
  sandbox?: boolean;
  // Operator network allowlist ([servers.<name>.network] allow_hosts). Present
  // (non-empty) ⇒ the server is granted network. bwrap network is all-or-
  // nothing, so the host list is ADVISORY (surfaced in the trust modal + audit,
  // fed to confirm/score), NOT kernel-enforced — per-host filtering is future
  // (MCP.md §2.3).
  network?: { allowHosts: readonly string[] };
  // Per-server operational budget (MCP.md §5). Populated by the loader with
  // defaults+clamps; `undefined` only when a McpServerConfig is built directly
  // (tests) — the manager falls back to DEFAULT_MCP_BUDGET.
  budget?: McpServerBudget;
}

// The 8-state lifecycle machine (STATE_MACHINE §6.5). The transition
// table lives in src/mcp/state.ts; the persisted column is in mcp_servers.
export type McpServerState =
  | 'disconnected'
  | 'handshaking'
  | 'trust_pending'
  | 'trusted'
  | 'active'
  | 'degraded'
  | 'denied'
  | 'error';

// `_meta.agentic_cli.*` — the server's self-declared, NON-authoritative
// hints (MCP.md §3.1). The harness decides policy; these only tune
// defaults. `category` is a raw string here (not a PolicyCategory) so this
// module stays decoupled from the permission engine. NOTE: in this version
// the tool-factory IGNORES `category` and always assigns the 'mcp' category
// (a server must not self-select a softer one, e.g. 'read'); the field is
// still parsed + hashed, so a change re-prompts, but it never reaches policy.
export interface McpToolMeta {
  category?: string;
  writes?: boolean;
  network?: boolean;
  parallel_safe?: boolean;
  deferred?: boolean;
  idempotent?: boolean;
}

// One tool as parsed from a `tools/list` response (namespace NOT yet
// applied — `name` is the server-local name). `inputSchema` is normalized
// to a `{ type: 'object', ... }` shape by the client adapter.
export interface McpManifestTool {
  name: string;
  description: string;
  inputSchema: ProviderToolInputSchema;
  meta: McpToolMeta;
}

// A normalized manifest ready to hash / persist. Tools are sorted by name
// (see src/mcp/manifest.ts).
export interface CanonicalManifest {
  server: string;
  protocolVersion: string;
  serverVersion: string | null;
  tools: readonly McpManifestTool[];
}

// Result of a `tools/call`, with content blocks flattened to text. The
// manager maps `isError` to a Forja `toolError`.
export interface McpCallResult {
  isError: boolean;
  content: string;
  structured?: unknown;
  // The adapter flagged the raw result as malformed (MCP.md §15.5: a clear
  // protocol violation — `content` not an array, a non-object block, or a text
  // block with non-string `text`). Drives the `active`→`degraded`→recover loop.
  // Absent ⇒ well-formed.
  invalid?: boolean;
  // The serialized raw `content` (truncated), captured ONLY when `invalid` — the
  // flattened `content` above loses the malformed structure (a non-array raw
  // flattens to ''), so this preserves what actually came over the wire for the
  // §15.5 audit row + the model's error.
  invalidRaw?: string;
}

// The thin SDK abstraction. src/mcp/client.ts is the ONLY implementer;
// everything else depends on this interface. All methods accept an
// AbortSignal so a session cancel / hard budget aborts an in-flight call.
export interface McpClient {
  // Spawn + `initialize` handshake. Returns the negotiated protocol +
  // declared server version.
  connect(signal?: AbortSignal): Promise<{ protocolVersion: string; serverVersion: string | null }>;
  listTools(signal?: AbortSignal): Promise<McpManifestTool[]>;
  callTool(tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

// Trust prompt vocabulary. 'first-visit' = never-seen manifest hash;
// 'drift' = a previously-trusted server whose manifest hash changed.
export type McpTrustMode = 'first-visit' | 'drift';

export interface McpTrustRequest {
  server: string;
  // The command + args being spawned — the REAL risk surface. The modal
  // must show this: trust = "I authorize running this binary."
  command: string;
  mode: McpTrustMode;
  // The effective sandbox posture (MCP.md §2.3) so the operator sees the
  // containment they are authorizing (sandboxed / unsandboxed + why).
  sandbox: McpSandboxStatus;
  // `writes` mirrors the tool's effective checkpoint behavior (`meta.writes ??
  // true`), so the modal can mark side-effecting tools the operator is about to
  // authorize — surfacing a server's self-declared `writes:false`. EMPTY on a
  // pre-connect identity gate (the tools aren't fetched yet — that's the point).
  tools: ReadonlyArray<{ name: string; description: string; writes: boolean }>;
  manifestHash: string;
  // The PRE-CONNECT identity gate (MCP.md §1.5): authorize reaching the server
  // (running the command / opening the URL with auth) BEFORE the handshake, so a
  // hostile config never spawns code or leaks a bearer token just to fetch the
  // manifest. When true the modal shows only the identity (no tools/hash — not
  // fetched); the manifest-trust prompt with the tool list follows post-connect.
  preConnect?: boolean;
}

export type McpTrustAnswer = 'yes' | 'no' | 'cancel';

// Operator confirmation callback. Absent in headless contexts ⇒
// fail-closed (deny) unless the server is in --auto-approve-mcp.
export type ConfirmMcpTrust = (req: McpTrustRequest) => Promise<McpTrustAnswer>;
