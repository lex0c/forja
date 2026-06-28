import { beforeEach, describe, expect, test } from 'bun:test';
import type { LoadedMcpConfig } from '../../src/mcp/config.ts';
import { createMcpManager } from '../../src/mcp/manager.ts';
import {
  canonicalManifestJson,
  canonicalizeManifest,
  hashManifest,
} from '../../src/mcp/manifest.ts';
import type {
  McpCallResult,
  McpClient,
  McpManifestTool,
  McpServerConfig,
  McpStdioConfig,
} from '../../src/mcp/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  getServer,
  insertServer,
  latestTrustedManifest,
  recordManifestDecision,
} from '../../src/storage/repos/mcp-servers.ts';
import { type ToolRegistry, createToolRegistry } from '../../src/tools/registry.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const ctx = { signal: new AbortController().signal } as unknown as ToolContext;

const toolDef = (name: string): McpManifestTool => ({
  name,
  description: `the ${name} tool`,
  inputSchema: { type: 'object' },
  meta: { writes: false },
});

const serverConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'db',
  enabled: true,
  surface: 'deferred',
  source: 'project_shared',
  transport: { transport: 'stdio', command: 'fake-bin', args: [], rawArgv: ['fake-bin'] },
  ...over,
});

const config = (servers: McpServerConfig[]): LoadedMcpConfig => ({
  servers,
  warnings: [],
  paths: { user: null, project: '/p/mcp.toml', local: '/p/mcp.local.toml' },
});

// A fake McpClient + a spy on the makeClient factory.
interface FakeSpec {
  tools: McpManifestTool[];
  callResult?: McpCallResult;
  connectError?: Error;
}
const fakeClientFactory = (spec: FakeSpec) => {
  const stats = {
    made: 0,
    connects: 0,
    closes: 0,
    calls: 0,
    lastConnectSignal: undefined as AbortSignal | undefined,
  };
  const makeClient = (_cfg: McpStdioConfig): McpClient => {
    stats.made += 1;
    return {
      async connect(signal) {
        stats.connects += 1;
        stats.lastConnectSignal = signal;
        if (spec.connectError) throw spec.connectError;
        return { protocolVersion: '2024-11-05', serverVersion: '1.0.0' };
      },
      async listTools() {
        return spec.tools;
      },
      async callTool() {
        stats.calls += 1;
        return spec.callResult ?? { isError: false, content: 'ok' };
      },
      async close() {
        stats.closes += 1;
      },
    };
  };
  return { makeClient, stats };
};

// Seed a granted manifest so init() takes the cached (no-connect) path.
const seedTrusted = (db: DB, server: string, tools: McpManifestTool[]): string => {
  const canonical = canonicalizeManifest({
    server,
    protocolVersion: '2024-11-05',
    serverVersion: '1.0.0',
    tools,
  });
  const hash = hashManifest(canonical);
  recordManifestDecision(db, {
    server_name: server,
    hash,
    previous_hash: null,
    manifest_json: canonicalManifestJson(canonical),
    protocol_version: '2024-11-05',
    server_version: '1.0.0',
    decision: 'granted',
    decided_by: 'user',
    decided_at: 1,
    approval_id: null,
  });
  return hash;
};

let db: DB;
let registry: ToolRegistry;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  registry = createToolRegistry();
});

describe('McpManager.init: fresh trust', () => {
  test('auto-approve grants, registers tools, persists trusted state + history', async () => {
    const { makeClient } = fakeClientFactory({ tools: [toolDef('query'), toolDef('list')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient,
      now: () => 100,
    });
    const report = await mgr.init();

    expect(report.registered).toBe(2);
    expect(registry.has('mcp__db__query')).toBe(true);
    expect(registry.has('mcp__db__list')).toBe(true);
    expect(mgr.state('db')).toBe('trusted');
    expect(getServer(db, 'db')?.state).toBe('trusted');
    expect(latestTrustedManifest(db, 'db')?.decided_by).toBe('auto_approve');
  });

  test('headless without auto-approve fails closed (denied, no tools)', async () => {
    const { makeClient } = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({ db, registry, config: config([serverConfig()]), makeClient });
    const report = await mgr.init();

    expect(report.registered).toBe(0);
    expect(registry.has('mcp__db__query')).toBe(false);
    expect(mgr.state('db')).toBe('denied');
    expect(latestTrustedManifest(db, 'db')).toBeNull();
  });

  test('confirmTrust "yes" grants, "no" denies', async () => {
    const yes = fakeClientFactory({ tools: [toolDef('query')] });
    const mgrYes = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      confirmTrust: async () => 'yes',
      makeClient: yes.makeClient,
    });
    await mgrYes.init();
    expect(mgrYes.state('db')).toBe('trusted');
    expect(registry.has('mcp__db__query')).toBe(true);

    const db2 = openMemoryDb();
    migrate(db2);
    const reg2 = createToolRegistry();
    const no = fakeClientFactory({ tools: [toolDef('query')] });
    const mgrNo = createMcpManager({
      db: db2,
      registry: reg2,
      config: config([serverConfig()]),
      confirmTrust: async () => 'no',
      makeClient: no.makeClient,
    });
    await mgrNo.init();
    expect(mgrNo.state('db')).toBe('denied');
    expect(reg2.has('mcp__db__query')).toBe(false);
  });
});

describe('McpManager.init: cached-trusted is lazy (no connect)', () => {
  test('registers from cache without ever constructing a client', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    const report = await mgr.init();

    expect(report.registered).toBe(1);
    expect(registry.has('mcp__db__query')).toBe(true);
    expect(mgr.state('db')).toBe('trusted');
    expect(fake.stats.made).toBe(0); // never connected at init
  });
});

describe('McpManager.callTool', () => {
  test('lazy-connects on first call, reuses the connection, bumps counters', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'rows' },
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();

    const r1 = await mgr.callTool('db', 'query', { sql: 'x' }, ctx);
    expect(r1.content).toBe('rows');
    expect(fake.stats.connects).toBe(1);
    expect(mgr.state('db')).toBe('active');

    await mgr.callTool('db', 'query', { sql: 'y' }, ctx);
    expect(fake.stats.connects).toBe(1); // reused
    expect(getServer(db, 'db')?.total_calls).toBe(2);
  });

  test('manifest drift on first call → degraded + throws', async () => {
    seedTrusted(db, 'db', [toolDef('query')]); // cached hash from {query}
    const fake = fakeClientFactory({ tools: [toolDef('query'), toolDef('SNEAKY')] }); // live differs
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();

    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/manifest_drift/);
    expect(mgr.state('db')).toBe('degraded');
  });

  test('a denied server is not callable', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init(); // headless → denied
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/denied/);
  });
});

describe('McpManager.cleanup', () => {
  test('closes a live client', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // opens a connection
    await mgr.cleanup();
    expect(fake.stats.closes).toBeGreaterThanOrEqual(1);
  });
});

describe('McpManager: disabled servers are skipped', () => {
  test('a disabled server registers nothing', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ enabled: false })]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    const report = await mgr.init();
    expect(report.registered).toBe(0);
    expect(fake.stats.made).toBe(0);
  });
});

describe('McpManager: code-review hardening', () => {
  // A prior session's mcp_servers row pinning the last-trusted command.
  const priorRow = (command: string[]) =>
    insertServer(db, {
      name: 'db',
      transport: 'stdio',
      command: JSON.stringify(command),
      url: null,
      source: 'project_shared',
      state: 'trusted',
    });

  test('headless fail-closed denies WITHOUT spawning the binary', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init(); // no confirmTrust, no autoApprove
    expect(fake.stats.made).toBe(0); // never executed the untrusted server
    expect(mgr.state('db')).toBe('denied');
  });

  test('a swapped command bypasses the cache and re-validates (auto-approve re-grants)', async () => {
    priorRow(['old-bin']); // last-trusted command differs from config's 'fake-bin'
    seedTrusted(db, 'db', [toolDef('query')]); // same tools → same manifest hash
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(fake.stats.made).toBe(1); // re-handshaked rather than trusting the swap from cache
    expect(mgr.state('db')).toBe('trusted');
  });

  test('a swapped command in headless fails closed WITHOUT spawning', async () => {
    priorRow(['old-bin']);
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(fake.stats.made).toBe(0); // never ran the swapped binary
    expect(mgr.state('db')).toBe('denied');
  });

  test('an unchanged command restart uses the cache (no re-handshake)', async () => {
    priorRow(['fake-bin']); // matches serverConfig's rawArgv
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(fake.stats.made).toBe(0); // cached — no spurious re-validation
    expect(mgr.state('db')).toBe('trusted');
  });

  test('after drift, a second call does NOT reconnect (pinned)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query'), toolDef('SNEAKY')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/manifest_drift/);
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/manifest_drift/);
    expect(fake.stats.connects).toBe(1); // pinned — did not reconnect on the 2nd call
  });

  test('init threads a bounded handshake signal into connect (no unbounded hang)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(fake.stats.connects).toBe(1);
    // Was `undefined` before the fix — init now bounds the handshake so a
    // wedged server can't hang bootstrap.
    expect(fake.stats.lastConnectSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('McpManager: stale-row sweep (AUDIT §1.5)', () => {
  test('init removes mcp_servers rows for servers no longer in config (history survives)', async () => {
    // A row + granted manifest from a prior session for a server now GONE.
    insertServer(db, {
      name: 'gone',
      transport: 'stdio',
      command: '["x"]',
      url: null,
      source: 'project_shared',
      state: 'trusted',
    });
    seedTrusted(db, 'gone', [toolDef('q')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]), // only 'db' is configured now
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(getServer(db, 'gone')).toBeNull(); // orphan STATE row swept
    expect(latestTrustedManifest(db, 'gone')).not.toBeNull(); // history is forever
    expect(getServer(db, 'db')).not.toBeNull(); // configured server kept
  });

  test('a disabled server keeps its row (still in config, just off)', async () => {
    insertServer(db, {
      name: 'db',
      transport: 'stdio',
      command: '["fake-bin"]',
      url: null,
      source: 'project_shared',
      state: 'trusted',
    });
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ enabled: false })]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(getServer(db, 'db')).not.toBeNull(); // disabled ≠ removed from config
  });
});
