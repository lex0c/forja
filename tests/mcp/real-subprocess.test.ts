// End-to-end integration of the MCP client stack against a REAL stdio
// subprocess (evals/mcp/fixtures/echo-server.ts), exercising the actual
// @modelcontextprotocol/sdk adapter — NOT the injected fake used by
// manager.test.ts. This is the load-bearing proof that the whole stack
// (createStdioMcpClient → handshake → manifest hash → trust → lazy-connect →
// tools/call) round-trips over real pipes. It spawns `bun <fixture>`, so it
// runs from the repo (where the SDK resolves) and needs `bun` on PATH.

import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedMcpConfig } from '../../src/mcp/config.ts';
import { createMcpManager } from '../../src/mcp/manager.ts';
import type { McpServerConfig } from '../../src/mcp/types.ts';
import { maybeWrapSandboxArgv } from '../../src/permissions/sandbox-runner.ts';
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

// Poll for the tee'd file to contain `needle` — the stderr drain flushes
// asynchronously after the child's stream closes.
const waitForLog = async (path: string, needle: string, tries = 100): Promise<string> => {
  for (let i = 0; i < tries; i++) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(needle)) return text;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

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

  test('tees the real child stderr to <traceDir>/mcp-<name>.log (drain over real pipes)', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'mcp-trace-'));
    const mgr = createMcpManager({
      db,
      registry,
      config: config([serverConfig()]),
      autoApprove: new Set(['fixture']),
      traceDir, // the production wiring that real-subprocess otherwise never exercises
    });
    try {
      await mgr.init();
      await mgr.callTool('fixture', 'echo', { text: 'x' }, ctx); // force a real spawn
      await mgr.cleanup(); // close → child stderr ends → tee flushes
      // Proves the cast `(transport as {...}).stderr` actually resolves to the
      // SDK's PassThrough and the pre-connect attach captures the startup banner.
      const text = await waitForLog(join(traceDir, 'mcp-fixture.log'), 'echo-server: ready');
      expect(text).toContain('echo-server: ready');
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
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

const bwrapAvailable = process.platform === 'linux' && Bun.which('bwrap') !== null;

describe('mcp real-subprocess + sandbox (bwrap)', () => {
  // The load-bearing proof that bwrap is transparent to JSON-RPC-over-stdio:
  // wrap the fixture server in a real cwd-rw sandbox and confirm the echo still
  // round-trips. Gated on Linux + bwrap (mirrors the bash sandbox tests).
  test.skipIf(!bwrapAvailable)(
    'a sandboxed (cwd-rw) server still round-trips a tools/call through bwrap',
    async () => {
      const mgr = createMcpManager({
        db,
        registry,
        config: config([serverConfig()]),
        autoApprove: new Set(['fixture']),
        sandbox: {
          available: true,
          wrap: (a) =>
            maybeWrapSandboxArgv({
              profile: a.profile,
              cwd: a.cwd,
              innerArgv: a.innerArgv,
              env: a.env,
              ...(a.passthroughEnv !== undefined ? { passthroughEnv: a.passthroughEnv } : {}),
              failClosed: true,
            }),
        },
      });
      const report = await mgr.init();
      expect(report.registered).toBe(1);

      const res = await mgr.callTool('fixture', 'echo', { text: 'sandboxed' }, ctx);
      expect(res.isError).toBe(false);
      expect(res.content).toBe('echo:sandboxed'); // JSON-RPC survived the bwrap wrap
      await mgr.cleanup();
    },
  );
});
