import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectAgentPath } from '../../src/config/agent-paths.ts';
import { loadMcpConfig } from '../../src/mcp/config.ts';
import { ABSOLUTE_MCP_BUDGET, DEFAULT_MCP_BUDGET } from '../../src/mcp/types.ts';

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
    expect(s.transport.command).toBe('mcp-server-postgres');
    expect(s.transport.args).toEqual(['--dsn', 'postgres://secret@db/app']); // $VAR resolved
    expect(s.transport.env).toEqual({ LOG_LEVEL: 'debug' });
    expect(s.transport.cwd).toBe('/work');
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
    expect(servers[0]?.transport.args).toEqual(['']);
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
  test('sse/http transport is skipped with a not-supported-yet warning', () => {
    writeFileSync(
      projectPath,
      `[servers.remote]
transport = "sse"
url = "https://example.com/mcp"
`,
    );
    const { servers, warnings } = load();
    expect(servers).toHaveLength(0);
    expect(warnings.some((w) => w.includes('not supported yet'))).toBe(true);
  });

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
    expect(s.transport.rawArgv).toEqual(['bin', '--dsn', '${DATABASE_URL}']); // never the secret
    expect(s.transport.args).toEqual(['--dsn', 'postgres://secret@db/app']); // resolved for spawn
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
    expect(servers[0]?.transport.command).toBe('local-bin');
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
    expect(servers[0]?.transport.cwd).toBeUndefined();
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
    expect(servers[0]?.transport.cwd).toBeUndefined();
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
