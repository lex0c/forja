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
  McpSandboxArg,
  McpSandboxWrap,
  McpServerConfig,
  McpStdioConfig,
} from '../../src/mcp/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  getServer,
  insertServer,
  latestTrustedManifest,
  listManifestHistory,
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
  listToolsError?: Error;
}
const fakeClientFactory = (spec: FakeSpec) => {
  const stats = {
    made: 0,
    connects: 0,
    closes: 0,
    calls: 0,
    lastConnectSignal: undefined as AbortSignal | undefined,
    lastSandbox: undefined as McpSandboxArg | undefined,
  };
  const makeClient = (_cfg: McpStdioConfig, sandbox?: McpSandboxArg): McpClient => {
    stats.made += 1;
    stats.lastSandbox = sandbox;
    return {
      async connect(signal) {
        stats.connects += 1;
        stats.lastConnectSignal = signal;
        if (spec.connectError) throw spec.connectError;
        return { protocolVersion: '2024-11-05', serverVersion: '1.0.0' };
      },
      async listTools() {
        if (spec.listToolsError) throw spec.listToolsError;
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

describe('McpManager: review hardening', () => {
  test('cached manifest with a tampered JSON fails its hash check and re-handshakes', async () => {
    // Record a granted row whose stored manifest_json does NOT hash to its
    // `hash` column — a DB tamper (e.g. flipping a tool's writes:false while
    // leaving the hash). The cached path must reject it, not register from it.
    const goodTools = [toolDef('query')];
    const canonical = canonicalizeManifest({
      server: 'db',
      protocolVersion: '2024-11-05',
      serverVersion: '1.0.0',
      tools: goodTools,
    });
    recordManifestDecision(db, {
      server_name: 'db',
      hash: hashManifest(canonical),
      previous_hash: null,
      manifest_json: '{"serverInfo":{"name":"db","version":"1.0.0"},"tools":[]}', // mismatched
      protocol_version: '2024-11-05',
      server_version: '1.0.0',
      decision: 'granted',
      decided_by: 'user',
      decided_at: 1,
      approval_id: null,
    });
    const fake = fakeClientFactory({ tools: goodTools });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    const report = await mgr.init();
    expect(report.warnings.some((w) => w.includes('failed its hash check'))).toBe(true);
    expect(fake.stats.connects).toBeGreaterThan(0); // re-handshaked instead of trusting the row
    expect(registry.has('mcp__db__query')).toBe(true);
    await mgr.cleanup();
  });

  test('a changed-manifest re-grant chains previous_hash to the prior trusted hash', async () => {
    // Session 1: grant manifest A.
    const fake1 = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr1 = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake1.makeClient,
    });
    await mgr1.init();
    const hashA = latestTrustedManifest(db, 'db')?.hash;
    await mgr1.cleanup();

    // Session 2: the command AND the tool set changed → manifest B, force-
    // reprompted (command swap), auto-approved.
    const fake2 = fakeClientFactory({ tools: [toolDef('query'), toolDef('mutate')] });
    const mgr2 = createMcpManager({
      db,
      registry: createToolRegistry(),
      config: config([
        serverConfig({
          transport: {
            transport: 'stdio',
            command: 'fake-bin-v2',
            args: [],
            rawArgv: ['fake-bin-v2'],
          },
        }),
      ]),
      autoApprove: new Set(['db']),
      makeClient: fake2.makeClient,
    });
    await mgr2.init();
    await mgr2.cleanup();

    const history = listManifestHistory(db, 'db');
    expect(history.length).toBe(2);
    const hashB = latestTrustedManifest(db, 'db')?.hash;
    expect(hashB).not.toBe(hashA);
    const rowB = history.find((h) => h.hash === hashB);
    expect(rowB?.previous_hash).toBe(hashA ?? null); // the chain forms (was always null before)
  });

  test('two tools that sanitize to the same wire name are de-duplicated, not dropped', async () => {
    const collide = (name: string): McpManifestTool => ({
      name,
      description: 'd',
      inputSchema: { type: 'object' },
      meta: {},
    });
    const fake = fakeClientFactory({ tools: [collide('foo.bar'), collide('foo/bar')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    const report = await mgr.init();
    expect(report.registered).toBe(2); // both registered, no throw
    expect(registry.has('mcp__db__foo_bar')).toBe(true);
    expect(registry.has('mcp__db__foo_bar_2')).toBe(true);
    await mgr.cleanup();
  });

  test('a connect failure lands the server in error state with a warning', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')], connectError: new Error('boom') });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    const report = await mgr.init();
    expect(report.registered).toBe(0);
    expect(mgr.state('db')).toBe('error');
    expect(report.warnings.some((w) => w.includes('handshake failed'))).toBe(true);
    await mgr.cleanup();
  });

  test('lazy-connect reaps the child when listTools fails after connect (no leak)', async () => {
    // Cached-trusted so init does not connect; the first callTool lazily
    // connects, then listTools throws — the manager must close() the client.
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      listToolsError: new Error('malformed tools/list'),
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(fake.stats.connects).toBe(0); // registered from cache, no connect

    // The manager rethrows the lazy-connect fault (the tool-factory wraps it
    // into a tool error); what matters here is that the child was reaped.
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow();
    expect(fake.stats.connects).toBe(1);
    expect(fake.stats.closes).toBe(1); // the fix: child reaped on the fault path, not orphaned
    await mgr.cleanup();
  });
});

describe('McpManager: sandbox profile resolution (MCP.md §2.3)', () => {
  // A spy wrap: the fake client never spawns, so we assert which profile the
  // manager resolved + passed to makeClient (the actual bwrap exec is proven by
  // the real-subprocess integration test).
  const wrap: McpSandboxWrap = (a) => ['bwrap', a.profile, '--', ...a.innerArgv];

  test('default-on: an available sandbox wraps a plain server as cwd-rw', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      sandbox: { available: true, wrap },
    });
    await mgr.init();
    expect(fake.stats.lastSandbox?.profile).toBe('cwd-rw');
    await mgr.cleanup();
  });

  test('a server with network resolves to cwd-rw-net', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ network: { allowHosts: ['api.example.com'] } })]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      sandbox: { available: true, wrap },
    });
    await mgr.init();
    expect(fake.stats.lastSandbox?.profile).toBe('cwd-rw-net');
    await mgr.cleanup();
  });

  test('sandbox=false opts out — no wrap passed (runs host)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ sandbox: false })]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      sandbox: { available: true, wrap },
    });
    await mgr.init();
    expect(fake.stats.lastSandbox).toBeUndefined();
    await mgr.cleanup();
  });

  test('no sandbox tool available → host + an UNSANDBOXED boot warning', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      sandbox: { available: false, wrap },
    });
    const report = await mgr.init();
    expect(fake.stats.lastSandbox).toBeUndefined();
    expect(report.warnings.some((w) => w.includes('UNSANDBOXED'))).toBe(true);
    await mgr.cleanup();
  });

  test('no sandbox dep wired → host, no warning (feature off, e.g. tests)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    const report = await mgr.init();
    expect(fake.stats.lastSandbox).toBeUndefined();
    expect(report.warnings.some((w) => w.includes('UNSANDBOXED'))).toBe(false);
    await mgr.cleanup();
  });
});

describe('McpManager: network server → mcp.egress category (MCP.md §2.3)', () => {
  test("a network-granted server's tools register under the egress category", async () => {
    const fake = fakeClientFactory({ tools: [toolDef('fetch')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ network: { allowHosts: ['api.example.com'] } })]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(registry.get('mcp__db__fetch')?.metadata.category).toBe('mcp.egress');
    await mgr.cleanup();
  });

  test('a SANDBOXED plain (no-network) server stays in the mcp category', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      // Available sandbox ⇒ cwd-rw (no network) ⇒ non-egress.
      sandbox: { available: true, wrap: (a) => ['bwrap', a.profile, '--', ...a.innerArgv] },
    });
    await mgr.init();
    expect(registry.get('mcp__db__query')?.metadata.category).toBe('mcp');
    await mgr.cleanup();
  });

  test('an UNSANDBOXED server (no tool / opt-out) IS egress — it has full host network', async () => {
    // No sandbox dep ⇒ host profile ⇒ the server can reach the network even
    // with no [network] grant ⇒ egress (the finder-caught hole).
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(registry.get('mcp__db__query')?.metadata.category).toBe('mcp.egress');
    await mgr.cleanup();
  });

  test('opt-out (sandbox=false) server IS egress + warns at boot', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ sandbox: false })]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      sandbox: { available: true, wrap: (a) => ['bwrap', a.profile, '--', ...a.innerArgv] },
    });
    const report = await mgr.init();
    expect(registry.get('mcp__db__query')?.metadata.category).toBe('mcp.egress');
    expect(report.warnings.some((w) => w.includes('UNSANDBOXED (sandbox=false)'))).toBe(true);
    await mgr.cleanup();
  });
});

describe('McpManager.status()', () => {
  test('returns live name/state/tool-count for each runtime server', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query'), toolDef('list')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.status()).toEqual([{ name: 'db', state: 'trusted', tools: 2 }]);
    await mgr.cleanup();
  });

  test('a denied (headless fail-closed) server appears with 0 tools', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.status()).toEqual([{ name: 'db', state: 'denied', tools: 0 }]);
    await mgr.cleanup();
  });
});
