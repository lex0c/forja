import { beforeEach, describe, expect, test } from 'bun:test';
import {
  type EmitFailureEventInput,
  type FailureEventSink,
  createSqliteFailureSink,
} from '../../src/failures/index.ts';
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
  McpTransportConfig,
} from '../../src/mcp/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listFailureEventsBySession } from '../../src/storage/repos/failure-events.ts';
import {
  getServer,
  insertServer,
  latestTrustedManifest,
  listManifestHistory,
  recordManifestDecision,
} from '../../src/storage/repos/mcp-servers.ts';
import { type ToolRegistry, createToolRegistry } from '../../src/tools/registry.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const ctx = {
  signal: new AbortController().signal,
  sessionId: 'sess-1',
} as unknown as ToolContext;

// Capturing failure_event sink — records every emit for assertion.
const captureSink = (): { sink: FailureEventSink; emits: EmitFailureEventInput[] } => {
  const emits: EmitFailureEventInput[] = [];
  const sink: FailureEventSink = {
    emit: (i) => {
      emits.push(i);
      return { id: 'fake', this_chain_hash: 'fake' };
    },
    verifyChain: () => ({ ok: true, rows: 0 }),
  };
  return { sink, emits };
};

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

const remoteServerConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'gh',
  enabled: true,
  surface: 'deferred',
  source: 'project_shared',
  transport: { transport: 'http', url: 'https://mcp.example.com/v1' },
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
  // callTool rejects immediately with this (a non-timeout transport fault), to
  // exercise the disconnect-and-reap branch.
  callError?: Error;
  // callTool never resolves on its own — only rejects when the passed signal
  // aborts (exercises the per-call timeout path).
  callHangs?: boolean;
  // Per-call results in order (falls back to callResult / default when drained).
  // Lets a test sequence invalid→valid outputs for the §15.5 recovery loop.
  callResultsQueue?: McpCallResult[];
}
const fakeClientFactory = (spec: FakeSpec) => {
  const stats = {
    made: 0,
    connects: 0,
    closes: 0,
    calls: 0,
    lastConnectSignal: undefined as AbortSignal | undefined,
    lastSandbox: undefined as McpSandboxArg | undefined,
    lastLogPath: undefined as string | undefined,
  };
  const makeClient = (
    _cfg: McpTransportConfig,
    sandbox?: McpSandboxArg,
    stderrLogPath?: string,
  ): McpClient => {
    stats.made += 1;
    stats.lastSandbox = sandbox;
    stats.lastLogPath = stderrLogPath;
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
      async callTool(_tool, _args, signal) {
        stats.calls += 1;
        if (spec.callError) throw spec.callError;
        if (spec.callHangs) {
          return new Promise<McpCallResult>((_res, rej) => {
            signal?.addEventListener('abort', () => rej(new Error('aborted')));
          });
        }
        if (spec.callResultsQueue && spec.callResultsQueue.length > 0) {
          return spec.callResultsQueue.shift() as McpCallResult;
        }
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

describe('McpManager.init: pre-connect identity gate (MCP.md §1.5)', () => {
  test('declining the identity gate denies WITHOUT connecting (no spawn, no token sent)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const preConnectFlags: boolean[] = [];
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      confirmTrust: async (req) => {
        preConnectFlags.push(req.preConnect === true);
        return 'no'; // decline at the identity gate
      },
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.state('db')).toBe('denied');
    expect(fake.stats.made).toBe(0); // never built a client → never spawned / connected
    expect(preConnectFlags).toEqual([true]); // only the pre-connect identity prompt fired
  });

  test('the identity gate precedes the manifest prompt; approving both connects + registers', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const preConnectFlags: boolean[] = [];
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      confirmTrust: async (req) => {
        preConnectFlags.push(req.preConnect === true);
        return 'yes';
      },
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.state('db')).toBe('trusted');
    expect(registry.has('mcp__db__query')).toBe(true);
    expect(preConnectFlags).toEqual([true, false]); // identity gate FIRST, then the manifest review
    expect(fake.stats.connects).toBe(1); // connected only AFTER the identity was authorized
  });

  test('a remote server: the bearer URL is not opened until the identity is authorized', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([remoteServerConfig()]),
      confirmTrust: async () => 'no',
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.state('gh')).toBe('denied');
    expect(fake.stats.made).toBe(0); // no connect → the Authorization: Bearer header is never sent
  });

  test('approving the identity then declining the manifest review denies (after connecting)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    let call = 0;
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      // 'yes' to the identity gate, 'no' to the manifest review that follows.
      confirmTrust: async () => (call++ === 0 ? 'yes' : 'no'),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.state('db')).toBe('denied');
    expect(registry.has('mcp__db__query')).toBe(false);
    expect(fake.stats.connects).toBe(1); // identity approved → connected, THEN the tools declined
    expect(call).toBe(2); // both prompts fired
  });

  test('headless auto-approve connects + trusts with NO identity prompt', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      // No confirmTrust (headless) + auto-approved → neither the identity gate nor
      // the manifest prompt can fire; the server still connects + trusts.
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(mgr.state('db')).toBe('trusted');
    expect(registry.has('mcp__db__query')).toBe(true);
    expect(fake.stats.connects).toBe(1);
  });

  test('a modal fault during the identity gate fails closed (denied, not uncaught)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      confirmTrust: async () => {
        throw new Error('modal crashed');
      },
      makeClient: fake.makeClient,
    });
    // init must not reject — the per-server fault is contained + fails closed.
    await mgr.init();
    expect(mgr.state('db')).toBe('denied');
    expect(fake.stats.made).toBe(0); // faulted at the gate → never connected
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

  test('a non-timeout call fault reaps the failed client (no leak across retries)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callError: new Error('transport fault'),
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();

    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow('transport fault');
    expect(mgr.state('db')).toBe('disconnected');
    expect(fake.stats.closes).toBe(1); // the failed client was closed, not orphaned

    // The model retries: a fresh client is built (the old one was reaped) and the
    // next fault reaps it too — closes track made, so children don't accumulate.
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow('transport fault');
    expect(fake.stats.made).toBe(2); // one client per attempt
    expect(fake.stats.closes).toBe(2); // each attempt reaps its own — no leak
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

describe('McpManager: revoke / reconnect (registry hot-swap)', () => {
  test('revoke unregisters the tools, denies, and persists revoked_at', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query'), toolDef('list')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(registry.has('mcp__db__query')).toBe(true);

    const r = await mgr.revoke('db');
    expect(r).toEqual({ ok: true, tools: 2 });
    expect(registry.has('mcp__db__query')).toBe(false); // unregistered (next turn drops them)
    expect(registry.has('mcp__db__list')).toBe(false);
    expect(mgr.state('db')).toBe('denied');
    expect(getServer(db, 'db')?.revoked_at).not.toBeNull(); // durable
    await mgr.cleanup();
  });

  test('a revoked server stays DENIED across a relaunch (init skips the cached grant)', async () => {
    const f1 = fakeClientFactory({ tools: [toolDef('query')] });
    const m1 = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: f1.makeClient,
    });
    await m1.init();
    await m1.revoke('db');
    await m1.cleanup();

    // Relaunch: a fresh registry + manager over the SAME db must NOT re-register
    // the revoked server's tools from the cached (forever) grant.
    const reg2 = createToolRegistry();
    const f2 = fakeClientFactory({ tools: [toolDef('query')] });
    const m2 = createMcpManager({
      db,
      registry: reg2,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: f2.makeClient,
    });
    const report = await m2.init();
    expect(report.registered).toBe(0);
    expect(reg2.has('mcp__db__query')).toBe(false);
    expect(m2.state('db')).toBe('denied');
    expect(latestTrustedManifest(db, 'db')).not.toBeNull(); // the grant survives forever (durability builds on it)
    expect(f2.stats.made).toBe(0); // never even spawned
    await m2.cleanup();
  });

  test('reconnect clears the revocation and re-registers the tools', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.revoke('db');
    expect(registry.has('mcp__db__query')).toBe(false);

    const r = await mgr.reconnect('db');
    expect(r.ok).toBe(true);
    expect(r.registered).toBe(1);
    expect(registry.has('mcp__db__query')).toBe(true); // re-registered
    expect(mgr.state('db')).toBe('trusted');
    expect(getServer(db, 'db')?.revoked_at).toBeNull(); // revocation cleared
    await mgr.cleanup();
  });

  test('a FAILED reconnect (server unreachable) stays revoked — revoked_at NOT cleared', async () => {
    seedTrusted(db, 'db', [toolDef('query')]); // init registers from cache (no connect)
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      connectError: new Error('ECONNREFUSED'),
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      // autoApprove so reconnect's resolveFreshTrust passes the fail-closed
      // pre-check and actually ATTEMPTS the connect (which then fails).
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      now: () => 999,
    });
    await mgr.init();
    await mgr.revoke('db');
    expect(getServer(db, 'db')?.revoked_at).toBe(999);

    // reconnect hits the connect error → error state. The revocation must NOT be
    // cleared, or the next relaunch silently re-registers from the cached grant.
    const r = await mgr.reconnect('db');
    expect(r.ok).toBe(false);
    expect(mgr.state('db')).toBe('error');
    expect(getServer(db, 'db')?.revoked_at).toBe(999); // still revoked
    await mgr.cleanup();
  });

  test('revoke records revoked_at from the injected clock', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      now: () => 12345,
    });
    await mgr.init();
    await mgr.revoke('db');
    expect(getServer(db, 'db')?.revoked_at).toBe(12345);
    await mgr.cleanup();
  });

  test('a revoked server removed from config keeps its revocation (orphan sweep spares it)', async () => {
    // Session 1: grant + revoke 'db'.
    const f1 = fakeClientFactory({ tools: [toolDef('query')] });
    const m1 = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: f1.makeClient,
    });
    await m1.init();
    await m1.revoke('db');
    await m1.cleanup();

    // Session 2: 'db' is GONE from config. The orphan sweep must NOT delete its
    // revoked row (else a re-add would re-register from the cached grant).
    const m2 = createMcpManager({ db, registry: createToolRegistry(), config: config([]) });
    await m2.init();
    expect(getServer(db, 'db')?.revoked_at).not.toBeNull(); // spared by the sweep
    await m2.cleanup();
  });

  test('revoke of an unknown server fails', async () => {
    const mgr = createMcpManager({ db, registry, config: config([]) });
    expect(await mgr.revoke('nope')).toEqual({ ok: false, reason: 'unknown server', tools: 0 });
    await mgr.cleanup();
  });

  test('reconnect of an unknown/disabled server fails', async () => {
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ enabled: false })]),
    });
    await mgr.init();
    const r = await mgr.reconnect('db');
    expect(r.ok).toBe(false);
    await mgr.cleanup();
  });
});

describe('McpManager: stderr log path (/mcp logs + tee)', () => {
  test('logPath returns <traceDir>/mcp-<name>.log when a traceDir is set', () => {
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      traceDir: '/data/traces',
    });
    expect(mgr.logPath('db')).toBe('/data/traces/mcp-db.log');
  });

  test('logPath is null without a traceDir (headless/test)', () => {
    const mgr = createMcpManager({ db, registry, config: config([serverConfig()]) });
    expect(mgr.logPath('db')).toBeNull();
  });

  test('the manager threads the per-server log path to the client factory', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
      traceDir: '/data/traces',
    });
    await mgr.init(); // fresh-trust path connects → clientFor → makeClient(cfg, _, logPath)
    expect(fake.stats.lastLogPath).toBe('/data/traces/mcp-db.log');
    await mgr.cleanup();
  });

  test('without a traceDir the factory gets an undefined log path (drain-to-discard)', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['db']),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    expect(fake.stats.lastLogPath).toBeUndefined();
    await mgr.cleanup();
  });

  test('logPath defends against a traversal name even with a traceDir', () => {
    const mgr = createMcpManager({
      db,
      registry,
      config: config([]),
      traceDir: '/data/traces',
    });
    expect(mgr.logPath('../../etc/passwd')).toBeNull();
    expect(mgr.logPath('a/b')).toBeNull();
  });
});

describe('McpManager: per-server budget (MCP.md §5)', () => {
  test('a per-call timeout surfaces mcp.timeout, stays ACTIVE, and the connection stays reusable', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')], callHangs: true });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 40, maxCallsPerSession: 200, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/);
    expect(mgr.state('db')).toBe('active'); // §15.3: a timeout is not a transport fault
    // The next call REUSES the live connection (a timeout doesn't tear it down);
    // the SDK discards the aborted call's late reply by request id.
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/);
    expect(fake.stats.connects).toBe(1); // one connect, reused across both timeouts
    await mgr.cleanup();
  });

  test('the absolute CALL cap disconnects the server for the session', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'ok' },
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 30_000, maxCallsPerSession: 2, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // 1
    await mgr.callTool('db', 'query', {}, ctx); // 2 → at the configured cap
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    expect(mgr.state('db')).toBe('disconnected');
    // The cap check runs BEFORE reconnect: a capped server must not re-spawn.
    expect(fake.stats.connects).toBe(1); // only the initial connect, none for the refused call
    await mgr.cleanup();
  });

  test('the configured TOKEN cap disconnects the server', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'x'.repeat(80) }, // ~20 tokens
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 30_000, maxCallsPerSession: 200, maxTokensInPerSession: 10 },
        }),
      ]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // ~20 tokens charged > cap 10
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    expect(mgr.state('db')).toBe('disconnected');
    await mgr.cleanup();
  });

  test('a server that TIMES OUT every call still hits the call cap (attempts counted)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')], callHangs: true });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 30, maxCallsPerSession: 2, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/); // attempt 1
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/); // attempt 2
    // A success would never have incremented past 0 — attempts must count, or a
    // hanging server loops uncapped forever. The 3rd is refused by the cap.
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    await mgr.cleanup();
  });

  test('a successful call charges the lifetime DB counters (calls + estimated tokens)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'rows-and-more-rows' },
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx);
    const row = getServer(db, 'db');
    expect(row?.total_calls).toBe(1);
    expect(row?.total_tokens_in ?? 0).toBeGreaterThan(0); // estimated from the result content
    await mgr.cleanup();
  });

  test('the budget-cap disconnect emits an mcp.budget.exceeded audit row', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'ok' },
    });
    const audit = captureSink();
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 30_000, maxCallsPerSession: 1, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
      failureSink: audit.sink,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // 1 → at the cap
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    const row = audit.emits.find((e) => e.code === 'mcp.budget.exceeded');
    expect(row).toBeDefined();
    expect(row?.classe).toBe('mcp');
    expect(row?.recovery_action).toBe('pending_repair');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.user_visible).toBe(true);
    const payload = row?.payload as Record<string, unknown> | undefined;
    expect(payload?.server).toBe('db');
    expect(payload?.calls).toBe(1);
    expect(payload?.max_calls).toBe(1);
    expect(payload).toHaveProperty('tokens_in');
    expect(payload).toHaveProperty('max_tokens_in');
    await mgr.cleanup();
  });

  test('a per-call timeout emits an mcp.timeout audit row (not user-visible)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')], callHangs: true });
    const audit = captureSink();
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 40, maxCallsPerSession: 200, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
      failureSink: audit.sink,
    });
    await mgr.init();
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/);
    const row = audit.emits.find((e) => e.code === 'mcp.timeout');
    expect(row).toBeDefined();
    expect(row?.recovery_action).toBe('ignored');
    expect(row?.user_visible).toBe(false);
    const payload = row?.payload as Record<string, unknown> | undefined;
    expect(payload?.tool).toBe('query');
    expect(payload?.timeout_ms).toBe(40);
    await mgr.cleanup();
  });

  test('the audit row persists through the REAL sqlite sink with an intact chain', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'ok' },
    });
    const sink = createSqliteFailureSink({ db });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 30_000, maxCallsPerSession: 1, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
      failureSink: sink,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx);
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    const rows = listFailureEventsBySession(db, 'sess-1');
    expect(rows.some((r) => r.code === 'mcp.budget.exceeded' && r.classe === 'mcp')).toBe(true);
    expect(sink.verifyChain('sess-1').ok).toBe(true); // the registered code + chain hold end-to-end
    await mgr.cleanup();
  });

  const capOneConfig = () =>
    config([
      serverConfig({
        budget: { timeoutMs: 30_000, maxCallsPerSession: 1, maxTokensInPerSession: 50_000 },
      }),
    ]);

  test('the per-session budget RESETS when a new session calls the server (§15.6 block lifts)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'ok' },
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: capOneConfig(),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // sess-1: at the cap
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    // A NEW session resets the broker-shared counters — the disconnect lifts and
    // the server reconnects with a fresh budget.
    const ctx2 = {
      signal: new AbortController().signal,
      sessionId: 'sess-2',
    } as unknown as ToolContext;
    expect((await mgr.callTool('db', 'query', {}, ctx2)).content).toBe('ok');
    await mgr.cleanup();
  });

  test('mcp.budget.exceeded emits ONCE per trip, not per refused call', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'ok' },
    });
    const audit = captureSink();
    const mgr = createMcpManager({
      db,
      registry,
      config: capOneConfig(),
      makeClient: fake.makeClient,
      failureSink: audit.sink,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // at the cap
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/budget/); // refused (emit)
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/budget/); // refused again
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/budget/); // and again
    expect(audit.emits.filter((e) => e.code === 'mcp.budget.exceeded')).toHaveLength(1);
    await mgr.cleanup();
  });

  test('an emit that THROWS never breaks the tool call (best-effort audit)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: 'ok' },
    });
    const throwingSink: FailureEventSink = {
      emit: () => {
        throw new Error('sink down');
      },
      verifyChain: () => ({ ok: true, rows: 0 }),
    };
    const mgr = createMcpManager({
      db,
      registry,
      config: capOneConfig(),
      makeClient: fake.makeClient,
      failureSink: throwingSink,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // at the cap
    // The call surfaces ITS OWN budget error, not the sink's 'sink down'.
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.budget\.exceeded/);
    await mgr.cleanup();
  });

  test('mcp.timeout emits per timed-out call (each is a distinct failure)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({ tools: [toolDef('query')], callHangs: true });
    const audit = captureSink();
    const mgr = createMcpManager({
      db,
      registry,
      config: config([
        serverConfig({
          budget: { timeoutMs: 30, maxCallsPerSession: 200, maxTokensInPerSession: 50_000 },
        }),
      ]),
      makeClient: fake.makeClient,
      failureSink: audit.sink,
    });
    await mgr.init();
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/);
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/mcp\.timeout/);
    expect(audit.emits.filter((e) => e.code === 'mcp.timeout')).toHaveLength(2);
    await mgr.cleanup();
  });
});

describe('McpManager: output-validity recovery (§15.5)', () => {
  test('a malformed output degrades the server, emits mcp.output.invalid, returns an error to the model', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResult: { isError: false, content: '', invalid: true, invalidRaw: '"not an array"' },
    });
    const audit = captureSink();
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
      failureSink: audit.sink,
    });
    await mgr.init();
    const r = await mgr.callTool('db', 'query', {}, ctx);
    expect(r.isError).toBe(true); // returned as an error, not thrown
    expect(r.content).toContain('mcp.output.invalid');
    expect(r.content).toContain('not an array'); // the raw, not lost to flattening
    expect(mgr.state('db')).toBe('degraded'); // active → degraded
    const row = audit.emits.find((e) => e.code === 'mcp.output.invalid');
    expect(row).toBeDefined();
    expect(row?.recovery_action).toBe('degraded');
    expect((row?.payload as Record<string, unknown> | undefined)?.raw_truncated).toBe(
      '"not an array"',
    );
    await mgr.cleanup();
  });

  test('3 consecutive well-formed outputs recover a degraded server to active', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResultsQueue: [
        { isError: false, content: 'bad', invalid: true }, // → degraded
        { isError: false, content: 'ok' }, // valid 1
        { isError: false, content: 'ok' }, // valid 2
        { isError: false, content: 'ok' }, // valid 3 → recover
      ],
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    await mgr.callTool('db', 'query', {}, ctx); // invalid → degraded
    expect(mgr.state('db')).toBe('degraded');
    await mgr.callTool('db', 'query', {}, ctx); // valid 1
    await mgr.callTool('db', 'query', {}, ctx); // valid 2
    expect(mgr.state('db')).toBe('degraded'); // streak 2 — not yet
    await mgr.callTool('db', 'query', {}, ctx); // valid 3 → recover
    expect(mgr.state('db')).toBe('active');
    await mgr.cleanup();
  });

  test('an invalid output resets the recovery streak (no premature recover)', async () => {
    seedTrusted(db, 'db', [toolDef('query')]);
    const fake = fakeClientFactory({
      tools: [toolDef('query')],
      callResultsQueue: [
        { isError: false, content: 'bad', invalid: true }, // → degraded
        { isError: false, content: 'ok' }, // valid 1
        { isError: false, content: 'ok' }, // valid 2
        { isError: false, content: 'bad', invalid: true }, // resets streak
        { isError: false, content: 'ok' }, // valid 1 again
        { isError: false, content: 'ok' }, // valid 2
      ],
    });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    for (let i = 0; i < 6; i++) await mgr.callTool('db', 'query', {}, ctx);
    expect(mgr.state('db')).toBe('degraded'); // only 2 valid since the reset → still degraded
    await mgr.cleanup();
  });

  test('a DRIFT-degraded server does NOT auto-recover via the output-validity path', async () => {
    seedTrusted(db, 'db', [toolDef('query')]); // trusted = [query]
    // The live manifest has an extra tool → the hash drifts on the first connect.
    const fake = fakeClientFactory({ tools: [toolDef('query'), toolDef('extra')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      makeClient: fake.makeClient,
    });
    await mgr.init();
    // First call connects, detects drift → degraded + pinned.
    await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/manifest_drift/);
    expect(mgr.state('db')).toBe('degraded');
    // Further calls throw drift BEFORE the call — they never reach the valid-output
    // recovery counter, so the drift never auto-recovers (only /mcp reconnect does).
    for (let i = 0; i < 4; i++) {
      await expect(mgr.callTool('db', 'query', {}, ctx)).rejects.toThrow(/manifest_drift/);
    }
    expect(mgr.state('db')).toBe('degraded');
    await mgr.cleanup();
  });
});

describe('McpManager: remote transport', () => {
  test('a remote server registers its tools as egress + gets no sandbox / stderr log', async () => {
    const fake = fakeClientFactory({ tools: [toolDef('query')] });
    const mgr = createMcpManager({
      db,
      registry,
      config: config([remoteServerConfig()]),
      autoApprove: new Set(['gh']),
      makeClient: fake.makeClient,
      traceDir: '/data/traces', // present, but a remote server still gets no log
    });
    const report = await mgr.init();
    expect(report.registered).toBe(1);
    expect(registry.has('mcp__gh__query')).toBe(true);
    // A remote server reaches the network → its tools are egress (mcp.egress).
    expect(registry.get('mcp__gh__query')?.metadata.category).toBe('mcp.egress');
    expect(fake.stats.lastSandbox).toBeUndefined(); // no subprocess → no sandbox wrap
    expect(fake.stats.lastLogPath).toBeUndefined(); // no subprocess → no stderr log
    await mgr.cleanup();
  });

  test("a remote server's trust identity is its URL (a second session reuses the cached grant)", async () => {
    const f1 = fakeClientFactory({ tools: [toolDef('query')] });
    const m1 = createMcpManager({
      db,
      registry,
      config: config([remoteServerConfig()]),
      autoApprove: new Set(['gh']),
      makeClient: f1.makeClient,
    });
    await m1.init();
    await m1.cleanup();

    // Same URL → cached grant, no fresh connect.
    const reg2 = createToolRegistry();
    const f2 = fakeClientFactory({ tools: [toolDef('query')] });
    const m2 = createMcpManager({
      db,
      registry: reg2,
      config: config([remoteServerConfig()]),
      makeClient: f2.makeClient,
    });
    await m2.init();
    expect(reg2.has('mcp__gh__query')).toBe(true);
    expect(f2.stats.made).toBe(0); // URL unchanged → registered from cache, never connected
    await m2.cleanup();
  });

  test('a server that switches stdio→remote in config is re-trusted (identity flips command→url)', async () => {
    // Session 1: trust the server as a stdio subprocess.
    const f1 = fakeClientFactory({ tools: [toolDef('query')] });
    const m1 = createMcpManager({
      db,
      registry,
      config: config([serverConfig({ name: 'sw' })]),
      autoApprove: new Set(['sw']),
      makeClient: f1.makeClient,
    });
    await m1.init();
    await m1.cleanup();
    expect(f1.stats.made).toBeGreaterThan(0); // connected to fetch + grant the stdio manifest
    const row1 = getServer(db, 'sw');
    expect(row1?.transport).toBe('stdio');
    expect(row1?.url).toBeNull();

    // Session 2: SAME name, now a remote http endpoint. The transport-kind change
    // must force a re-handshake — NOT a register from the stale stdio grant.
    const reg2 = createToolRegistry();
    const f2 = fakeClientFactory({ tools: [toolDef('query')] });
    const m2 = createMcpManager({
      db,
      registry: reg2,
      config: config([remoteServerConfig({ name: 'sw' })]),
      autoApprove: new Set(['sw']),
      makeClient: f2.makeClient,
    });
    await m2.init();
    expect(f2.stats.made).toBeGreaterThan(0); // re-handshook, not served from the stdio cache
    expect(reg2.has('mcp__sw__query')).toBe(true);
    const row2 = getServer(db, 'sw');
    expect(row2?.transport).toBe('http'); // persisted identity flipped to the remote URL
    expect(row2?.command).toBeNull();
    expect(row2?.url).toBe('https://mcp.example.com/v1');
    await m2.cleanup();
  });
});
