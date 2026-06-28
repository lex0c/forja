// End-to-end integration of the MCP client stack against a REAL stdio
// subprocess (evals/mcp/fixtures/echo-server.ts), exercising the actual
// @modelcontextprotocol/sdk adapter — NOT the injected fake used by
// manager.test.ts. This is the load-bearing proof that the whole stack
// (createStdioMcpClient → handshake → manifest hash → trust → lazy-connect →
// tools/call) round-trips over real pipes. It spawns `bun <fixture>`, so it
// runs from the repo (where the SDK resolves) and needs `bun` on PATH.

import { beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { LoadedMcpConfig } from '../../src/mcp/config.ts';
import { createMcpManager } from '../../src/mcp/manager.ts';
import type { McpServerConfig } from '../../src/mcp/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { type ToolRegistry, createToolRegistry } from '../../src/tools/registry.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const FIXTURE = join(import.meta.dir, '../../evals/mcp/fixtures/echo-server.ts');
const ctx = { signal: new AbortController().signal } as unknown as ToolContext;

const serverConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: 'fixture',
  enabled: true,
  surface: 'base',
  source: 'project_shared',
  transport: { transport: 'stdio', command: 'bun', args: [FIXTURE], rawArgv: ['bun', FIXTURE] },
  ...over,
});

const config = (servers: McpServerConfig[]): LoadedMcpConfig => ({
  servers,
  warnings: [],
  paths: { user: null, project: '/p/mcp.toml', local: '/p/mcp.local.toml' },
});

let db: DB;
let registry: ToolRegistry;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  registry = createToolRegistry();
});

describe('mcp real-subprocess integration (SDK stdio + fixture echo server)', () => {
  test('auto-approved: spawns the server, registers its tool, round-trips a call', async () => {
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['fixture']),
    });
    const report = await mgr.init();
    expect(report.warnings).toEqual([]);
    expect(report.registered).toBe(1);
    expect(registry.has('mcp__fixture__echo')).toBe(true);

    const res = await mgr.callTool('fixture', 'echo', { text: 'ping-42' }, ctx);
    expect(res.isError).toBe(false);
    expect(res.content).toBe('echo:ping-42'); // the real server's reply

    // The registered Forja tool dispatches through the same path.
    const tool = registry.get('mcp__fixture__echo');
    expect(tool).not.toBeNull();
    const out = await tool?.execute({ text: 'via-tool' }, ctx);
    expect(out).toEqual({ content: 'echo:via-tool' });

    await mgr.cleanup();
  });

  test('headless fail-closed (no auto-approve): denies WITHOUT spawning', async () => {
    const mgr = createMcpManager({ db, registry, config: config([serverConfig()]) });
    const report = await mgr.init();
    expect(report.registered).toBe(0);
    expect(registry.has('mcp__fixture__echo')).toBe(false);
    expect(mgr.state('fixture')).toBe('denied');
    await mgr.cleanup();
  });

  test('a second session reuses the cached grant without a fresh prompt', async () => {
    // First session: auto-approve records the granted manifest.
    const mgr1 = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['fixture']),
    });
    await mgr1.init();
    await mgr1.cleanup();

    // Second session: NO auto-approve, NO confirmTrust — yet the cached grant
    // (same command + same manifest hash) registers the tool from cache.
    const reg2 = createToolRegistry();
    const mgr2 = createMcpManager({ db, registry: reg2, config: config([serverConfig()]) });
    const report = await mgr2.init();
    expect(report.registered).toBe(1);
    expect(reg2.has('mcp__fixture__echo')).toBe(true);
    expect(mgr2.state('fixture')).toBe('trusted');
    await mgr2.cleanup();
  });
});
