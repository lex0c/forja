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
// The file's top-level table is `[servers.<name>]`, so we reuse the
// generic `loadTomlSection(path, 'servers', …)` reader. Slice 1 supports
// stdio only — sse/http entries are skipped with a warning until slice 2.

import { projectAgentPath, userAgentPath } from '../config/agent-paths.ts';
import { loadTomlSection } from '../config/section.ts';
import {
  ABSOLUTE_MCP_BUDGET,
  DEFAULT_MCP_BUDGET,
  type McpServerBudget,
  type McpServerConfig,
  type McpServerSource,
  type McpStdioConfig,
} from './types.ts';

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  warnings: string[];
  paths: { user: string | null; project: string; local: string };
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

// Parse one `[servers.<name>]` entry. Returns null (with a warning) when
// the entry is unusable in this slice; the loader skips it.
const parseServerEntry = (
  name: string,
  raw: unknown,
  source: McpServerSource,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): McpServerConfig | null => {
  const where = `mcp.toml [servers.${name}] (${source})`;

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
  if (transport !== 'stdio') {
    if (transport === 'sse' || transport === 'http') {
      warnings.push(
        `${where}: transport '${transport}' is not supported yet (stdio only); skipped`,
      );
    } else {
      warnings.push(`${where}: missing or invalid transport (expected 'stdio'); skipped`);
    }
    return null;
  }

  const command = asStringArray(entry.command);
  if (command === null || command.length === 0) {
    warnings.push(`${where}: 'command' must be a non-empty array of strings; skipped`);
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
      for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          warnings.push(`${where}: env.${k} must be a string; ignored`);
          continue;
        }
        out[k] = resolveEnvVars(v, env, warnings, `${where} env.${k}`);
      }
      stdio.env = out;
    }
  }

  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== 'string') {
      warnings.push(`${where}: 'cwd' must be a string; ignored`);
    } else {
      const resolvedCwd = resolveEnvVars(entry.cwd, env, warnings, `${where} cwd`);
      // An unset `$VAR` resolves to '' — forwarding `cwd: ''` to the spawn is an
      // invalid working directory (ENOENT); drop it (run in the session cwd).
      if (resolvedCwd === '') {
        warnings.push(`${where}: 'cwd' resolves to an empty path; ignored`);
      } else {
        stdio.cwd = resolvedCwd;
      }
    }
  }

  // Forja-native: which model surface the server's tools sit on. Default
  // 'deferred' (reached via tool_search) so a many-tool server doesn't
  // bloat the base surface.
  let surface: McpServerConfig['surface'] = 'deferred';
  if (entry.surface !== undefined) {
    if (entry.surface === 'base' || entry.surface === 'deferred') {
      surface = entry.surface;
    } else {
      warnings.push(`${where}: 'surface' must be 'base' or 'deferred'; using 'deferred'`);
    }
  }

  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
    // A quoted bool (`disabled = "true"`) is a common TOML slip; without this
    // it would silently stay enabled, dropping the operator's disable intent.
    warnings.push(`${where}: 'disabled' must be a boolean; treating as not disabled`);
  }
  const disabled = entry.disabled === true;

  // Sandbox posture (MCP.md §2.3): default-on when a sandbox tool is available;
  // `false` is an explicit opt-out. A non-boolean warns and falls back to the
  // default.
  let sandbox: boolean | undefined;
  if (entry.sandbox !== undefined) {
    if (typeof entry.sandbox === 'boolean') {
      sandbox = entry.sandbox;
    } else {
      warnings.push(`${where}: 'sandbox' must be a boolean; using the default (on when available)`);
    }
  }

  // Network allowlist ([servers.<name>.network] allow_hosts). A non-empty list
  // grants the server network — bwrap is all-or-nothing, so the hosts are
  // advisory (surfaced in trust + audit), NOT kernel-enforced (MCP.md §2.3).
  let network: { allowHosts: readonly string[] } | undefined;
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
    transport: stdio,
    source,
    budget,
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(network !== undefined ? { network } : {}),
  };
};

const parseLayer = (
  path: string | null,
  source: McpServerSource,
  sourceLabel: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): McpServerConfig[] => {
  const section = loadTomlSection(path, 'servers', sourceLabel);
  if (section.kind === 'invalid') {
    warnings.push(section.warning);
    return [];
  }
  if (section.kind !== 'found') return [];
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(section.section)) {
    const parsed = parseServerEntry(name, raw, source, env, warnings);
    if (parsed !== null) out.push(parsed);
  }
  return out;
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
  const layers: Array<[McpServerConfig[], string]> = [
    [parseLayer(userPath, 'user', 'mcp user', env, warnings), 'user'],
    [parseLayer(projectPath, 'project_shared', 'mcp project', env, warnings), 'project'],
    [parseLayer(localPath, 'project_local', 'mcp local', env, warnings), 'local'],
  ];
  for (const [servers, layerLabel] of layers) {
    for (const server of servers) {
      if (merged.has(server.name)) {
        warnings.push(
          `mcp.toml: server '${server.name}' redefined in the ${layerLabel} layer; the higher-precedence definition wins`,
        );
      }
      merged.set(server.name, server);
    }
  }

  const servers = Array.from(merged.values()).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );

  return { servers, warnings, paths: { user: userPath, project: projectPath, local: localPath } };
};
