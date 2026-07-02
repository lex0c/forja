// mcp.toml loader. MCP servers live in a DEDICATED config-file family
// (NOT a [section] of config.toml), per MCP.md §1.2:
//
//   user     ~/.config/forja/mcp.toml         (per-user global)
//   project  .forja/mcp.toml                  (per-project shared, committed)
//   local    .forja/mcp.local.toml            (per-project local, gitignored)
//
// Precedence: local > project > user — a server name redefined in a
// higher-precedence layer wins (a conflict is a warning, not an error).
// Fail-soft like the config.toml loaders: a malformed file / entry emits a
// warning and is skipped; it never aborts boot.
//
// The file's top-level table is `[servers.<name>]`, so we reuse the generic
// `loadTomlSection(path, 'servers', …)` reader. `transport` is "stdio" (a
// spawned subprocess) or "sse"/"http" (a remote endpoint at `url`, with optional
// env-bearer `auth`); OAuth auth is a later slice.

import { projectAgentPath, userAgentPath } from '../config/agent-paths.ts';
import { loadTomlSection } from '../config/section.ts';
import {
  ABSOLUTE_MCP_BUDGET,
  DEFAULT_MCP_BUDGET,
  type McpRemoteConfig,
  type McpServerBudget,
  type McpServerConfig,
  type McpServerSource,
  type McpStdioConfig,
  type McpTransportConfig,
} from './types.ts';

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  warnings: string[];
  paths: { user: string | null; project: string; local: string };
  // Sources whose layer did NOT load cleanly — the file failed to parse (bad
  // TOML) or at least one `[servers.<name>]` entry was skipped. Such a layer's
  // `servers` list is PARTIAL: a server the operator still has configured may be
  // missing. The manager consults this to avoid sweeping the storage scope of an
  // incompletely-loaded layer as "orphaned" (a temporary typo must not erase a
  // trusted server's persisted state/identity). Empty ⇒ every layer loaded fully.
  incompleteSources: ReadonlySet<McpServerSource>;
}

export interface LoadMcpConfigInput {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // Test seam (mirrors BootstrapInput.userPolicyPath / userAgentsDir):
  // override the user-layer mcp.toml path. `null` ⇒ no user file (hermetic
  // tests — keeps a developer's real ~/.config/forja/mcp.toml out of the
  // bootstrap 38-tool assertion); `undefined` ⇒ resolve from env.
  userPathOverride?: string | null;
}

// Server name must map cleanly onto the `mcp__<server>__<tool>` wire form;
// keep it to lowercase word chars so no sanitization is needed at the
// server half.
const NAME_RE = /^[a-z][a-z0-9_]*$/;
const NAME_MAX = 40;

// The operator-facing file each layer maps to, for the warning context — a first-
// time author can't act on the internal `project_local` enum, but CAN open
// `.forja/mcp.local.toml`.
const SOURCE_FILE: Record<McpServerSource, string> = {
  user: '~/.config/forja/mcp.toml',
  project_shared: '.forja/mcp.toml',
  project_local: '.forja/mcp.local.toml',
};
const LAYER_LABEL: Record<McpServerSource, string> = {
  user: 'user',
  project_shared: 'project',
  project_local: 'local',
};

// Recognized `[servers.<name>]` keys, split by applicability. Any key outside the
// applicable set is warned on (a typo'd optional key, or a key belonging to the
// OTHER transport) — TOML has no schema, so an unrecognized key is otherwise
// silently dropped with the author's intent.
const COMMON_KEYS = new Set([
  'transport',
  'surface',
  'disabled',
  'timeout_ms',
  'max_calls_per_session',
  'max_tokens_in_per_session',
]);
const STDIO_KEYS = new Set(['command', 'env', 'cwd', 'sandbox', 'network']);
const REMOTE_KEYS = new Set(['url', 'auth']);

// `$NAME` / `${NAME}` references resolved from the agent session env
// (MCP.md §1.2). An unset var substitutes empty + warns rather than
// leaking the literal `$NAME` into an argv the server would choke on.
const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

// A `${` NOT followed by a well-formed `NAME}` — an unclosed `${API_KEY`, an
// empty `${}`, or a `${1X}`. The resolver leaves these literal (the spec
// contract is "don't leak a half-reference into argv silently"), so flag them.
const MALFORMED_BRACE_RE = /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/;

const resolveEnvVars = (
  value: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
  ctx: string,
): string => {
  if (MALFORMED_BRACE_RE.test(value)) {
    warnings.push(`${ctx}: malformed brace reference (expected \${NAME}); left as-is`);
  }
  return value.replace(
    ENV_VAR_RE,
    (_full, braced: string | undefined, bare: string | undefined) => {
      const name = (braced ?? bare) as string;
      const resolved = env[name];
      if (resolved === undefined) {
        warnings.push(`${ctx}: environment variable $${name} is not set; substituted empty string`);
        return '';
      }
      return resolved;
    },
  );
};

// A per-server budget field (MCP.md §5): default when absent, warn + default on
// a non-positive/non-numeric value, clamp down to the absolute cap. Floored to
// an integer (calls/tokens are counts; ms is whole).
const parseBudgetField = (
  raw: unknown,
  field: string,
  def: number,
  cap: number,
  where: string,
  warnings: string[],
): number => {
  if (raw === undefined) return def;
  // Reject < 1 (not just <= 0): a fractional like 0.5 would otherwise pass and
  // then `Math.floor` to 0 — a timeout_ms of 0 fires instantly, a cap of 0 never
  // lets the server call.
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    warnings.push(`${where}: '${field}' must be a number ≥ 1; using ${def}`);
    return def;
  }
  if (raw > cap) {
    warnings.push(
      `${where}: '${field}' (${raw}) exceeds the absolute cap ${cap}; clamped to ${cap}`,
    );
    return cap;
  }
  return Math.floor(raw);
};

const asStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === 'string')) return null;
  return value as string[];
};

// Resolve `auth = { kind = "bearer", env = "TOKEN" }` into the Authorization
// header value. Only env-bearer in this slice (OAuth's authProvider is later).
// The TOKEN comes from the session env, NEVER from config; an unset var warns +
// sends no header (the server decides if that's a 401).
const parseAuthHeader = (
  raw: unknown,
  env: NodeJS.ProcessEnv,
  where: string,
  warnings: string[],
): string | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${where}: 'auth' must be a table; ignored`);
    return undefined;
  }
  const auth = raw as Record<string, unknown>;
  if (auth.kind !== 'bearer') {
    warnings.push(
      `${where}: only auth.kind = "bearer" is supported (OAuth is a later slice); ignored`,
    );
    return undefined;
  }
  if (typeof auth.env !== 'string' || auth.env.length === 0) {
    warnings.push(`${where}: bearer auth needs 'env' (the env var holding the token); ignored`);
    return undefined;
  }
  const token = env[auth.env];
  // Reject empty AND whitespace-only tokens — a `Bearer    ` header is just a
  // silent 401 the operator would have to debug at first call.
  if (token === undefined || token.trim() === '') {
    warnings.push(
      `${where}: bearer token env var $${auth.env} is not set or blank; sending no Authorization header`,
    );
    return undefined;
  }
  return `Bearer ${token}`;
};

// The bearer auth env-var NAME from `auth = { kind = "bearer", env = "X" }`,
// for the trust identity (folded in so re-pointing the binding re-triggers
// trust). Just the NAME — never the token. No warnings here; parseAuthHeader
// owns validation. Returns the name even when the token is currently unset — the
// binding is what the operator authorized, independent of the runtime value.
const bearerEnvName = (raw: unknown): string | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const auth = raw as Record<string, unknown>;
  if (auth.kind !== 'bearer' || typeof auth.env !== 'string' || auth.env.length === 0) {
    return undefined;
  }
  return auth.env;
};

// Parse an sse/http `[servers.<name>]` entry into a remote transport config.
// `url` is required + $VAR-resolved + must be http(s). Returns null (skip) on a
// missing/invalid URL.
const parseRemoteTransport = (
  transport: 'sse' | 'http',
  entry: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  where: string,
  warnings: string[],
): McpRemoteConfig | null => {
  if (typeof entry.url !== 'string' || entry.url.length === 0) {
    warnings.push(`${where}: a '${transport}' server needs a non-empty 'url' string; skipped`);
    return null;
  }
  const resolvedUrl = resolveEnvVars(entry.url, env, warnings, `${where} url`);
  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    warnings.push(`${where}: 'url' is not a valid URL; skipped`);
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    warnings.push(`${where}: 'url' must be http(s) (got '${parsed.protocol}'); skipped`);
    return null;
  }
  // Credentials in the URL userinfo (`user:pass@host`). Reject them: a LITERAL
  // one would persist via `rawUrl`, and a $VAR-resolved one belongs in
  // `auth = { kind = "bearer", env = "…" }` (Bearer, never at rest) rather than
  // Basic auth in the URL. The persisted identity is `rawUrl` (the UNRESOLVED
  // form), so a `?token=$TOKEN` in the query/path never lands at rest as the
  // token value — only the live `url` below carries the resolved secret.
  if (parsed.username !== '' || parsed.password !== '') {
    warnings.push(
      `${where}: 'url' must not embed credentials (user:pass@) — use auth = { kind = "bearer", env = "…" }; skipped`,
    );
    return null;
  }
  const remote: McpRemoteConfig = { transport, url: parsed.toString(), rawUrl: entry.url };
  const authHeader = parseAuthHeader(entry.auth, env, where, warnings);
  if (authHeader !== undefined) remote.authHeader = authHeader;
  const authEnv = bearerEnvName(entry.auth);
  if (authEnv !== undefined) remote.authEnv = authEnv;
  return remote;
};

// Parse one `[servers.<name>]` entry. Returns null (with a warning) when
// the entry is unusable; the loader skips it.
const parseServerEntry = (
  name: string,
  raw: unknown,
  source: McpServerSource,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): McpServerConfig | null => {
  const where = `${SOURCE_FILE[source]} [servers.${name}]`;

  if (!NAME_RE.test(name) || name.length > NAME_MAX) {
    warnings.push(
      `${where}: invalid server name '${name}' (must match ${NAME_RE} and be ≤ ${NAME_MAX} chars); skipped`,
    );
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${where}: not a table; skipped`);
    return null;
  }
  const entry = raw as Record<string, unknown>;

  const transport = entry.transport;
  let transportConfig: McpTransportConfig;
  let sandbox: boolean | undefined;
  let network: { allowHosts: readonly string[] } | undefined;

  if (transport === 'sse' || transport === 'http') {
    const remote = parseRemoteTransport(transport, entry, env, where, warnings);
    if (remote === null) return null;
    transportConfig = remote;
    // `sandbox` / `network` inapplicability is warned by the transport-aware key
    // sweep below (it covers every stdio-only key uniformly).
  } else if (transport === 'stdio') {
    const command = asStringArray(entry.command);
    if (command === null || command.length === 0) {
      // The single most common stdio mistake is a string instead of an array;
      // show the array form either way so the fix is obvious.
      const example = 'e.g. command = ["npx", "-y", "@scope/server"]';
      warnings.push(
        typeof entry.command === 'string'
          ? `${where}: 'command' must be an ARRAY, not a string (${example}); skipped`
          : `${where}: 'command' must be a non-empty array of strings (${example}); skipped`,
      );
      return null;
    }
    const resolvedArgv = command.map((part) => resolveEnvVars(part, env, warnings, where));
    const head = resolvedArgv[0];
    if (head === undefined || head === '') {
      // Empty includes the unset-`$VAR` case (`["$BIN"]` with BIN unset resolves
      // to `""`) — skip cleanly at load instead of failing later at spawn.
      warnings.push(`${where}: 'command' resolves to an empty executable; skipped`);
      return null;
    }
    const stdio: McpStdioConfig = {
      transport: 'stdio',
      command: head,
      args: resolvedArgv.slice(1),
      // The unresolved argv, for redacted persistence + command-change trust.
      rawArgv: command,
    };
    // Optional env table (string → string), $VAR-resolved.
    if (entry.env !== undefined) {
      if (entry.env === null || typeof entry.env !== 'object' || Array.isArray(entry.env)) {
        warnings.push(`${where}: 'env' must be a table; ignored`);
      } else {
        const out: Record<string, string> = {};
        const rawOut: Record<string, string> = {};
        for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            warnings.push(`${where}: env.${k} must be a string; ignored`);
            continue;
          }
          out[k] = resolveEnvVars(v, env, warnings, `${where} env.${k}`);
          // Keep the UNRESOLVED binding for the trust identity — never the
          // resolved secret (mirrors rawArgv).
          rawOut[k] = v;
        }
        stdio.env = out;
        stdio.rawEnv = rawOut;
      }
    }
    if (entry.cwd !== undefined) {
      if (typeof entry.cwd !== 'string') {
        warnings.push(`${where}: 'cwd' must be a string; ignored`);
      } else {
        const resolvedCwd = resolveEnvVars(entry.cwd, env, warnings, `${where} cwd`);
        // An unset `$VAR` resolves to '' — `cwd: ''` is an invalid working dir
        // (ENOENT); drop it (run in the session cwd).
        if (resolvedCwd === '') {
          warnings.push(`${where}: 'cwd' resolves to an empty path; ignored`);
        } else {
          stdio.cwd = resolvedCwd;
        }
      }
    }
    transportConfig = stdio;

    // Sandbox + network apply only to a SPAWNED (stdio) server (MCP.md §2.3):
    // sandbox = default-on when a tool is available, `false` opts out; a non-
    // empty network.allow_hosts grants network (advisory — bwrap is all-or-
    // nothing, not kernel-enforced).
    if (entry.sandbox !== undefined) {
      if (typeof entry.sandbox === 'boolean') {
        sandbox = entry.sandbox;
      } else {
        warnings.push(
          `${where}: 'sandbox' must be a boolean (got ${JSON.stringify(entry.sandbox)}); using the default (on when available)`,
        );
      }
    }
    if (entry.network !== undefined) {
      if (
        entry.network === null ||
        typeof entry.network !== 'object' ||
        Array.isArray(entry.network)
      ) {
        warnings.push(`${where}: 'network' must be a table; ignored`);
      } else {
        const hosts = asStringArray((entry.network as Record<string, unknown>).allow_hosts);
        if (hosts === null) {
          warnings.push(`${where}: 'network.allow_hosts' must be an array of strings; ignored`);
        } else if (hosts.length > 0) {
          network = { allowHosts: hosts };
        }
      }
    }
  } else {
    warnings.push(
      entry.transport === undefined
        ? `${where}: missing 'transport' (expected 'stdio' / 'sse' / 'http'); skipped`
        : `${where}: invalid transport ${JSON.stringify(entry.transport)} (expected 'stdio' / 'sse' / 'http'); skipped`,
    );
    return null;
  }

  // Warn on any key not recognized for this transport — a typo'd optional key
  // (`disable`, `sanbox`, `surfce`) or a key that belongs to the OTHER transport
  // (`auth`/`url` on stdio, `command`/`env`/`sandbox`/`network` on remote) is
  // otherwise silently dropped, discarding the author's intent with no trace.
  const applicable = transport === 'stdio' ? STDIO_KEYS : REMOTE_KEYS;
  const otherKeys = transport === 'stdio' ? REMOTE_KEYS : STDIO_KEYS;
  for (const key of Object.keys(entry)) {
    if (COMMON_KEYS.has(key) || applicable.has(key)) continue;
    warnings.push(
      otherKeys.has(key)
        ? `${where}: '${key}' does not apply to a ${transport} server; ignored`
        : `${where}: unknown key '${key}'; ignored`,
    );
  }

  // Forja-native: which model surface the server's tools sit on. Default
  // 'deferred' (reached via tool_search) so a many-tool server doesn't bloat the
  // base surface.
  let surface: McpServerConfig['surface'] = 'deferred';
  if (entry.surface !== undefined) {
    if (entry.surface === 'base' || entry.surface === 'deferred') {
      surface = entry.surface;
    } else {
      warnings.push(
        `${where}: 'surface' must be 'base' or 'deferred' (got ${JSON.stringify(entry.surface)}); using 'deferred'`,
      );
    }
  }

  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
    // A quoted bool (`disabled = "true"`) is a common TOML slip; without this it
    // would silently stay enabled, dropping the operator's disable intent.
    warnings.push(`${where}: 'disabled' must be a boolean; treating as not disabled`);
  }
  const disabled = entry.disabled === true;

  // Per-server budget (MCP.md §5): timeout_ms / max_calls_per_session /
  // max_tokens_in_per_session, each defaulted + clamped to its absolute cap.
  const budget: McpServerBudget = {
    timeoutMs: parseBudgetField(
      entry.timeout_ms,
      'timeout_ms',
      DEFAULT_MCP_BUDGET.timeoutMs,
      ABSOLUTE_MCP_BUDGET.timeoutMs,
      where,
      warnings,
    ),
    maxCallsPerSession: parseBudgetField(
      entry.max_calls_per_session,
      'max_calls_per_session',
      DEFAULT_MCP_BUDGET.maxCallsPerSession,
      ABSOLUTE_MCP_BUDGET.maxCallsPerSession,
      where,
      warnings,
    ),
    maxTokensInPerSession: parseBudgetField(
      entry.max_tokens_in_per_session,
      'max_tokens_in_per_session',
      DEFAULT_MCP_BUDGET.maxTokensInPerSession,
      ABSOLUTE_MCP_BUDGET.maxTokensInPerSession,
      where,
      warnings,
    ),
  };

  return {
    name,
    enabled: !disabled,
    surface,
    transport: transportConfig,
    source,
    budget,
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(network !== undefined ? { network } : {}),
  };
};

// `complete` is false when this layer may have DROPPED a server the operator
// still has configured: the file failed to parse, or an individual entry was
// skipped. The loader propagates it so the manager won't sweep an incompletely-
// loaded layer's scope (a typo must not erase a trusted server's persisted row).
// An ABSENT file is complete (legitimately no servers — an intentional removal).
const parseLayer = (
  path: string | null,
  source: McpServerSource,
  sourceLabel: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): { servers: McpServerConfig[]; complete: boolean } => {
  const section = loadTomlSection(path, 'servers', sourceLabel);
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return { servers: [], complete: false };
  }
  if (section.kind !== 'found') return { servers: [], complete: true };
  const out: McpServerConfig[] = [];
  let complete = true;
  for (const [name, raw] of Object.entries(section.section)) {
    const parsed = parseServerEntry(name, raw, source, env, warnings);
    if (parsed !== null) out.push(parsed);
    else complete = false; // a skipped entry — the layer's server set is partial
  }
  return { servers: out, complete };
};

export const loadMcpConfig = (input: LoadMcpConfigInput): LoadedMcpConfig => {
  const env = input.env ?? process.env;
  const warnings: string[] = [];

  const userPath =
    input.userPathOverride !== undefined ? input.userPathOverride : userAgentPath('mcp.toml', env);
  const projectPath = projectAgentPath(input.cwd, 'mcp.toml');
  const localPath = projectAgentPath(input.cwd, 'mcp.local.toml');

  // Merge by name with increasing precedence: user < project < local.
  // A later layer overriding an earlier one is a warning, not an error.
  const merged = new Map<string, McpServerConfig>();
  const incompleteSources = new Set<McpServerSource>();
  const collect = (
    layer: { servers: McpServerConfig[]; complete: boolean },
    source: McpServerSource,
  ): McpServerConfig[] => {
    if (!layer.complete) incompleteSources.add(source);
    return layer.servers;
  };
  const layers: Array<[McpServerConfig[], string]> = [
    [collect(parseLayer(userPath, 'user', 'mcp user', env, warnings), 'user'), 'user'],
    [
      collect(
        parseLayer(projectPath, 'project_shared', 'mcp project', env, warnings),
        'project_shared',
      ),
      'project',
    ],
    [
      collect(parseLayer(localPath, 'project_local', 'mcp local', env, warnings), 'project_local'),
      'local',
    ],
  ];
  for (const [servers, layerLabel] of layers) {
    for (const server of servers) {
      const prev = merged.get(server.name);
      if (prev !== undefined) {
        warnings.push(
          `mcp.toml: server '${server.name}' redefined in the ${layerLabel} layer, overriding the ${LAYER_LABEL[prev.source]} layer (precedence: local > project > user)`,
        );
      }
      merged.set(server.name, server);
    }
  }

  const servers = Array.from(merged.values()).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  return {
    servers,
    warnings,
    paths: { user: userPath, project: projectPath, local: localPath },
    incompleteSources,
  };
};
