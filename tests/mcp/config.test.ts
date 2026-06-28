import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectAgentPath } from '../../src/config/agent-paths.ts';
import { loadMcpConfig } from '../../src/mcp/config.ts';

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
