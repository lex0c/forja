import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectAgentPath } from '../../src/config/agent-paths.ts';
import { loadMcpConfig } from '../../src/mcp/config.ts';
import {
  ABSOLUTE_MCP_BUDGET,
  DEFAULT_MCP_BUDGET,
  type McpRemoteConfig,
  type McpServerConfig,
  type McpStdioConfig,
} from '../../src/mcp/types.ts';

// Narrow the transport union (a wrong-kind parse is a test bug, so throw).
const stdio = (s: McpServerConfig | undefined): McpStdioConfig => {
  if (s === undefined || s.transport.transport !== 'stdio') {
    throw new Error('expected a stdio transport');
  }
  return s.transport;
};
const remote = (s: McpServerConfig | undefined): McpRemoteConfig => {
  if (s === undefined || s.transport.transport === 'stdio') {
    throw new Error('expected a remote transport');
  }
  return s.transport;
};

let workdir: string;
let projectPath: string;
let localPath: string;
let userPath: string;

const env = { DATABASE_URL: 'postgres://secret@db/app', LOG: 'debug' } as NodeJS.ProcessEnv;

const load = (over: { userPathOverride?: string | null } = {}) =>
  loadMcpConfig({ cwd: workdir, env, userPathOverride: null, ...over });

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-mcp-config-'));
  projectPath = projectAgentPath(workdir, 'mcp.toml');
  localPath = projectAgentPath(workdir, 'mcp.local.toml');
  userPath = join(workdir, 'user-mcp.toml');
  mkdirSync(dirname(projectPath), { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('loadMcpConfig: stdio entry parsing', () => {
  test('parses a full stdio server', () => {
    writeFileSync(
      projectPath,
      `[servers.postgres]
transport = "stdio"
command = ["mcp-server-postgres", "--dsn", "\${DATABASE_URL}"]
env = { LOG_LEVEL = "$LOG" }
cwd = "/work"
`,
    );
    const { servers, warnings } = load();
    expect(warnings).toEqual([]);
    expect(servers).toHaveLength(1);
    const s = servers[0];
    if (!s) throw new Error('expected exactly one server');
    expect(s.name).toBe('postgres');
    expect(s.enabled).toBe(true);
    expect(s.surface).toBe('deferred'); // default
    expect(s.source).toBe('project_shared');
    expect(stdio(s).command).toBe('mcp-server-postgres');
    expect(stdio(s).args).toEqual(['--dsn', 'postgres://secret@db/app']); // $VAR resolved
    expect(stdio(s).env).toEqual({ LOG_LEVEL: 'debug' });
    expect(stdio(s).cwd).toBe('/work');
    expect(s.budget).toEqual(DEFAULT_MCP_BUDGET); // no budget fields → defaults
  });

  test('an unset $VAR substitutes empty and warns', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["bin", "$MISSING_VAR"]
`,
    );
    const { servers, warnings } = load();
    expect(stdio(servers[0]).args).toEqual(['']);
    expect(warnings.some((w) => w.includes('$MISSING_VAR'))).toBe(true);
  });

  test('disabled = true → enabled false', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["bin"]
disabled = true
`,
    );
    expect(load().servers[0]?.enabled).toBe(false);
  });

  test('surface = "base" is honored; an invalid surface warns + defaults', () => {
    writeFileSync(
      projectPath,
      `[servers.a]
transport = "stdio"
command = ["bin"]
surface = "base"

[servers.b]
transport = "stdio"
command = ["bin"]
surface = "weird"
`,
    );
    const { servers, warnings } = load();
    expect(servers.find((s) => s.name === 'a')?.surface).toBe('base');
    expect(servers.find((s) => s.name === 'b')?.surface).toBe('deferred');
    expect(warnings.some((w) => w.includes("'surface'"))).toBe(true);
  });
});

describe('loadMcpConfig: skip + warn on unusable entries', () => {
  test('an invalid server name is skipped', () => {
    writeFileSync(
      projectPath,
      `[servers.Bad-Name]
transport = "stdio"
command = ["bin"]
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(0);
    expect(warnings.some((w) => w.includes('invalid server name'))).toBe(true);
  });

  test('a missing/empty command is skipped', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = []
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(0);
    expect(warnings.some((w) => w.includes('non-empty array'))).toBe(true);
  });

  test('a command whose executable resolves to empty (unset $VAR) is skipped', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["$MISSING_BIN", "serve"]
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(0);
    expect(warnings.some((w) => w.includes('empty executable'))).toBe(true);
  });
});

describe('loadMcpConfig: rawArgv (redacted persistence)', () => {
  test('rawArgv preserves the unresolved command; args resolve for spawn', () => {
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["bin", "--dsn", "\${DATABASE_URL}"]
`,
    );
    const s = load().servers[0];
    if (!s) throw new Error('expected one server');
    expect(stdio(s).rawArgv).toEqual(['bin', '--dsn', '${DATABASE_URL}']); // never the secret
    expect(stdio(s).args).toEqual(['--dsn', 'postgres://secret@db/app']); // resolved for spawn
  });
});

describe('loadMcpConfig: layering + precedence', () => {
  test('local overrides project overrides user by name (warns on conflict)', () => {
    writeFileSync(
      userPath,
      `[servers.db]
transport = "stdio"
command = ["user-bin"]
`,
    );
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["project-bin"]
`,
    );
    writeFileSync(
      localPath,
      `[servers.db]
transport = "stdio"
command = ["local-bin"]
`,
    );
    const { servers, warnings } = load({ userPathOverride: userPath });
    expect(servers).toHaveLength(1);
    expect(stdio(servers[0]).command).toBe('local-bin');
    expect(servers[0]?.source).toBe('project_local');
    expect(warnings.filter((w) => w.includes('redefined')).length).toBe(2);
  });

  test('distinct servers across layers all survive, sorted by name', () => {
    writeFileSync(userPath, `[servers.zeta]\ntransport="stdio"\ncommand=["z"]\n`);
    writeFileSync(projectPath, `[servers.mid]\ntransport="stdio"\ncommand=["m"]\n`);
    writeFileSync(localPath, `[servers.alpha]\ntransport="stdio"\ncommand=["a"]\n`);
    const { servers } = load({ userPathOverride: userPath });
    expect(servers.map((s) => s.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('userPathOverride: null keeps a real user file out of the result', () => {
    writeFileSync(userPath, `[servers.fromuser]\ntransport="stdio"\ncommand=["u"]\n`);
    const { servers } = load({ userPathOverride: null });
    expect(servers).toHaveLength(0);
  });
});

describe('loadMcpConfig: fail-soft + empty', () => {
  test('no mcp.toml anywhere → empty, no warnings', () => {
    const { servers, warnings, paths } = load();
    expect(servers).toEqual([]);
    expect(warnings).toEqual([]);
    expect(paths.project).toBe(projectPath);
    expect(paths.user).toBeNull();
  });

  test('a malformed TOML file warns but does not throw, other layers still load', () => {
    writeFileSync(projectPath, 'this is = = not valid toml [[[');
    writeFileSync(localPath, `[servers.ok]\ntransport="stdio"\ncommand=["bin"]\n`);
    const { servers, warnings } = load();
    expect(servers.map((s) => s.name)).toEqual(['ok']);
    expect(warnings.some((w) => w.toLowerCase().includes('parse'))).toBe(true);
  });
});

describe('loadMcpConfig: bad-type diagnostics (review hardening)', () => {
  test('a non-boolean disabled warns and stays enabled (intent not silently dropped)', () => {
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["bin"]
disabled = "true"
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.enabled).toBe(true);
    expect(warnings.some((w) => w.includes("'disabled' must be a boolean"))).toBe(true);
  });

  test('a cwd that resolves to empty ($UNSET) is dropped, not forwarded as cwd:""', () => {
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["bin"]
cwd = "$WORKDIR"
`,
    );
    const { servers, warnings } = load();
    expect(stdio(servers[0]).cwd).toBeUndefined();
    expect(warnings.some((w) => w.includes("'cwd' resolves to an empty path"))).toBe(true);
  });

  test('a non-string cwd warns and is ignored', () => {
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["bin"]
cwd = 123
`,
    );
    const { servers, warnings } = load();
    expect(stdio(servers[0]).cwd).toBeUndefined();
    expect(warnings.some((w) => w.includes("'cwd' must be a string"))).toBe(true);
  });

  test('a malformed brace reference (unclosed ${) warns instead of leaking silently', () => {
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["bin", "--token=\${DATABASE_URL"]
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(1);
    expect(warnings.some((w) => w.includes('malformed brace reference'))).toBe(true);
  });
});

describe('loadMcpConfig: sandbox + network (MCP.md §2.3)', () => {
  test('parses sandbox=false (opt-out) + a network.allow_hosts table', () => {
    writeFileSync(
      projectPath,
      `[servers.db]
transport = "stdio"
command = ["bin"]
sandbox = false

[servers.db.network]
allow_hosts = ["api.foo.com", "api.bar.com"]
`,
    );
    const { servers, warnings } = load();
    expect(warnings).toEqual([]);
    const s = servers[0];
    if (!s) throw new Error('expected a server');
    expect(s.sandbox).toBe(false);
    expect(s.network).toEqual({ allowHosts: ['api.foo.com', 'api.bar.com'] });
  });

  test('no sandbox/network keys → both undefined (default-on resolved at spawn)', () => {
    writeFileSync(projectPath, `[servers.db]\ntransport = "stdio"\ncommand = ["bin"]\n`);
    const { servers } = load();
    expect(servers[0]?.sandbox).toBeUndefined();
    expect(servers[0]?.network).toBeUndefined();
  });

  test('an empty allow_hosts grants no network', () => {
    writeFileSync(
      projectPath,
      `[servers.db]\ntransport = "stdio"\ncommand = ["bin"]\n\n[servers.db.network]\nallow_hosts = []\n`,
    );
    expect(load().servers[0]?.network).toBeUndefined();
  });

  test('a non-boolean sandbox warns', () => {
    writeFileSync(
      projectPath,
      `[servers.db]\ntransport = "stdio"\ncommand = ["bin"]\nsandbox = "yes"\n`,
    );
    expect(load().warnings.some((w) => w.includes("'sandbox' must be a boolean"))).toBe(true);
  });

  test('a non-array allow_hosts warns', () => {
    writeFileSync(
      projectPath,
      `[servers.db]\ntransport = "stdio"\ncommand = ["bin"]\n\n[servers.db.network]\nallow_hosts = "foo.com"\n`,
    );
    expect(load().warnings.some((w) => w.includes("'network.allow_hosts' must be an array"))).toBe(
      true,
    );
  });
});

describe('loadMcpConfig: per-server budget (§5)', () => {
  test('custom budget fields are honored', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["bin"]
timeout_ms = 45000
max_calls_per_session = 500
max_tokens_in_per_session = 120000
`,
    );
    const { servers, warnings } = load();
    expect(warnings).toEqual([]);
    expect(servers[0]?.budget).toEqual({
      timeoutMs: 45000,
      maxCallsPerSession: 500,
      maxTokensInPerSession: 120000,
    });
  });

  test('a value over the absolute cap is clamped + warns', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["bin"]
max_calls_per_session = 99999
`,
    );
    const { servers, warnings } = load();
    expect(servers[0]?.budget?.maxCallsPerSession).toBe(ABSOLUTE_MCP_BUDGET.maxCallsPerSession);
    expect(warnings.some((w) => w.includes('max_calls_per_session') && w.includes('clamped'))).toBe(
      true,
    );
  });

  test('a non-numeric / non-positive budget value warns + uses the default', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["bin"]
timeout_ms = "soon"
max_calls_per_session = 0
`,
    );
    const { servers, warnings } = load();
    expect(servers[0]?.budget?.timeoutMs).toBe(DEFAULT_MCP_BUDGET.timeoutMs);
    expect(servers[0]?.budget?.maxCallsPerSession).toBe(DEFAULT_MCP_BUDGET.maxCallsPerSession);
    expect(warnings.some((w) => w.includes('timeout_ms'))).toBe(true);
    expect(warnings.some((w) => w.includes('max_calls_per_session'))).toBe(true);
  });

  test('a fractional value < 1 warns + uses the default (would floor to 0)', () => {
    writeFileSync(
      projectPath,
      `[servers.x]
transport = "stdio"
command = ["bin"]
timeout_ms = 0.5
`,
    );
    const { servers, warnings } = load();
    expect(servers[0]?.budget?.timeoutMs).toBe(DEFAULT_MCP_BUDGET.timeoutMs); // not floored to 0
    expect(warnings.some((w) => w.includes('timeout_ms'))).toBe(true);
  });
});

describe('loadMcpConfig: remote transport (sse / http)', () => {
  test('an sse server parses into a remote transport with its URL', () => {
    writeFileSync(
      projectPath,
      `[servers.gh]
transport = "sse"
url = "https://mcp.example.com/v1"
`,
    );
    const { servers, warnings } = load();
    expect(warnings).toEqual([]);
    expect(servers).toHaveLength(1);
    const t = remote(servers[0]);
    expect(t.transport).toBe('sse');
    expect(t.url).toBe('https://mcp.example.com/v1');
    expect(t.authHeader).toBeUndefined();
  });

  test('an http (streamable) server + env-bearer auth resolves the Authorization header', () => {
    writeFileSync(
      projectPath,
      `[servers.gh]
transport = "http"
url = "https://mcp.example.com/v1"
auth = { kind = "bearer", env = "DATABASE_URL" }
`,
    );
    const { servers, warnings } = load(); // env.DATABASE_URL is set in the fixture
    expect(warnings).toEqual([]);
    const t = remote(servers[0]);
    expect(t.transport).toBe('http');
    expect(t.authHeader).toBe('Bearer postgres://secret@db/app'); // resolved from env, never persisted
  });

  test('an unset bearer env var warns + sends no header', () => {
    writeFileSync(
      projectPath,
      `[servers.gh]
transport = "sse"
url = "https://mcp.example.com/v1"
auth = { kind = "bearer", env = "NOPE_MISSING" }
`,
    );
    const { servers, warnings } = load();
    expect(remote(servers[0]).authHeader).toBeUndefined();
    expect(warnings.some((w) => w.includes('NOPE_MISSING') && w.includes('not set'))).toBe(true);
  });

  test('a missing or non-http(s) url is skipped', () => {
    writeFileSync(projectPath, `[servers.a]\ntransport = "sse"\n`); // no url
    expect(load().servers).toHaveLength(0);
    writeFileSync(projectPath, `[servers.b]\ntransport = "http"\nurl = "ftp://x/y"\n`);
    const { servers, warnings } = load();
    expect(servers).toHaveLength(0);
    expect(warnings.some((w) => w.includes('http(s)'))).toBe(true);
  });

  test('a url with embedded credentials (user:pass@) is rejected — keep the token in auth.env', () => {
    // A literal secret, or a $VAR that resolves to one, must not land in the
    // persisted url. Both hit the same parsed.username/password gate.
    writeFileSync(
      projectPath,
      `[servers.gh]\ntransport = "http"\nurl = "https://user:s3cret@mcp.example.com/v1"\n`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(0);
    expect(warnings.some((w) => w.includes('must not embed credentials'))).toBe(true);
  });

  test('a $VAR-expanded secret in the url query stays out of the persisted/displayed identity', () => {
    // rawUrl (the trust identity — persisted + shown) keeps the UNEXPANDED form, so
    // a query/path token never lands at rest as its resolved value; only the live
    // `url` (used for the connection) carries it. Covers the query/path case the
    // userinfo (user:pass@) check above misses.
    writeFileSync(
      projectPath,
      `[servers.gh]\ntransport = "http"\nurl = "https://mcp.example.com/mcp?token=$LOG"\n`,
    );
    const { servers, warnings } = load(); // env.LOG = 'debug'
    expect(warnings).toEqual([]);
    const t = remote(servers[0]);
    expect(t.rawUrl).toBe('https://mcp.example.com/mcp?token=$LOG'); // identity: unexpanded
    expect(t.rawUrl).not.toContain('debug'); // the resolved value never enters the identity
    expect(t.url).toContain('token=debug'); // the live connection url DOES carry it
  });

  test('a blank (whitespace-only) bearer token warns + sends no header', () => {
    writeFileSync(
      projectPath,
      `[servers.gh]\ntransport = "sse"\nurl = "https://mcp.example.com/v1"\nauth = { kind = "bearer", env = "BLANK_TOKEN" }\n`,
    );
    const { servers, warnings } = loadMcpConfig({
      cwd: workdir,
      env: { ...env, BLANK_TOKEN: '   ' } as NodeJS.ProcessEnv,
      userPathOverride: null,
    });
    expect(remote(servers[0]).authHeader).toBeUndefined();
    expect(warnings.some((w) => w.includes('BLANK_TOKEN') && w.includes('blank'))).toBe(true);
  });

  test('sandbox / network on a remote server warn (not applicable, no subprocess)', () => {
    writeFileSync(
      projectPath,
      `[servers.gh]
transport = "sse"
url = "https://mcp.example.com/v1"
sandbox = false
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.sandbox).toBeUndefined();
    expect(warnings.some((w) => w.includes('do not apply to a remote server'))).toBe(true);
  });
});
