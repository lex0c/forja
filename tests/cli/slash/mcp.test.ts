// /mcp slash command (read-only: list + show). MCP.md §7.

import { beforeEach, describe, expect, test } from 'bun:test';
import { mcpCommand } from '../../../src/cli/slash/commands/mcp.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import type { McpManager, McpServerStatus } from '../../../src/mcp/manager.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { insertServer, recordManifestDecision } from '../../../src/storage/repos/mcp-servers.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let db: DB;

interface FakeHooks {
  revoke?: (name: string) => Promise<{ ok: boolean; reason?: string; tools: number }>;
  reconnect?: (
    name: string,
  ) => Promise<{ ok: boolean; reason?: string; registered: number; warnings: string[] }>;
}
const fakeManager = (status: McpServerStatus[], hooks: FakeHooks = {}): McpManager =>
  ({
    init: async () => ({ registered: 0, servers: [], warnings: [] }),
    callTool: async () => ({ isError: false, content: '' }),
    state: (n: string) => status.find((s) => s.name === n)?.state ?? null,
    status: () => status,
    revoke: hooks.revoke ?? (async () => ({ ok: true, tools: 0 })),
    reconnect: hooks.reconnect ?? (async () => ({ ok: true, registered: 0, warnings: [] })),
    cleanup: async () => {},
  }) as unknown as McpManager;

const buildCtx = (mgr?: McpManager, isRunning = false): SlashContext => {
  const bus = createBus();
  const modalManager = createModalManager({ bus, focusStack: createFocusStack(), now: () => 0 });
  const baseConfig = {
    cwd: '/p',
    ...(mgr !== undefined ? { mcpManager: mgr } : {}),
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now: () => 0,
    requestShutdown: () => {},
    isRunning: () => isRunning,
    currentSessionId: () => null,
    replSessionIds: () => [],
    modelRegistry: createModelRegistry(),
  };
};

const seed = (name: string, state: string, source = 'project_shared'): void =>
  insertServer(db, {
    name,
    transport: 'stdio',
    command: JSON.stringify([`${name}-bin`]),
    url: null,
    source,
    state,
  });

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

describe('/mcp slash command (read-only)', () => {
  test('no servers + no manager → friendly empty note', async () => {
    const r = await mcpCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.join('\n')).toContain('No MCP servers configured');
  });

  test('list shows each server with the LIVE state + tool count', async () => {
    seed('db', 'disconnected'); // persisted row lags
    const mgr = fakeManager([{ name: 'db', state: 'trusted', tools: 3 }]);
    const r = await mcpCommand.exec([], buildCtx(mgr));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('MCP servers (1)');
    expect(text).toContain('db');
    expect(text).toContain('trusted'); // manager's live state, not the persisted 'disconnected'
    expect(text).toContain('3 tools');
  });

  test('show <server> renders details + trust history', async () => {
    seed('db', 'trusted');
    recordManifestDecision(db, {
      server_name: 'db',
      hash: 'abc123def456789',
      previous_hash: null,
      manifest_json: '{"tools":[]}',
      protocol_version: '2024-11-05',
      server_version: '1.0.0',
      decision: 'granted',
      decided_by: 'auto_approve',
      decided_at: 0,
      approval_id: null,
    });
    const r = await mcpCommand.exec(['show', 'db'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain("mcp server 'db'");
    expect(text).toContain('trust history');
    expect(text).toContain('granted');
    expect(text).toContain('abc123def456'); // hash prefix
  });

  test('show <unknown> errors', async () => {
    const r = await mcpCommand.exec(['show', 'nope'], buildCtx());
    expect(r.kind).toBe('error');
  });

  test('show without a name errors', async () => {
    const r = await mcpCommand.exec(['show'], buildCtx());
    expect(r.kind).toBe('error');
  });

  test('unknown subcommand errors with a hint', async () => {
    const r = await mcpCommand.exec(['bogus'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('unknown subcommand');
  });

  test('headless (no manager): list falls back to the persisted row state', async () => {
    seed('db', 'trusted');
    const r = await mcpCommand.exec([], buildCtx()); // no manager
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('db');
    expect(text).toContain('trusted'); // from the row (no live status)
    expect(text).toContain('—'); // tools dash (no live count)
  });

  test('a configured-but-disabled server (in rows, absent from live) shows "disabled"', async () => {
    seed('off', 'trusted'); // persisted state lingers from when it was enabled
    const mgr = fakeManager([]); // manager present, but 'off' was skipped by init
    const r = await mcpCommand.exec([], buildCtx(mgr));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('off');
    expect(text).toContain('disabled'); // not the stale 'trusted'
    expect(text).not.toMatch(/off\s+trusted/);
  });

  test('the explicit /mcp list alias works', async () => {
    seed('db', 'trusted');
    const r = await mcpCommand.exec(
      ['list'],
      buildCtx(fakeManager([{ name: 'db', state: 'trusted', tools: 1 }])),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.join('\n')).toContain('MCP servers (1)');
  });

  test('show prefers the LIVE manager state over the persisted row', async () => {
    seed('db', 'disconnected'); // row lags
    const mgr = fakeManager([{ name: 'db', state: 'active', tools: 2 }]);
    const r = await mcpCommand.exec(['show', 'db'], buildCtx(mgr));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('state:    active'); // live, not 'disconnected'
  });

  test('a zero / unknown trust timestamp renders as "—", not a false 1970 date', async () => {
    seed('db', 'trusted');
    recordManifestDecision(db, {
      server_name: 'db',
      hash: 'h0',
      previous_hash: null,
      manifest_json: '{"tools":[]}',
      protocol_version: '1',
      server_version: null,
      decision: 'granted',
      decided_by: 'user',
      decided_at: 0, // unknown / backfilled
      approval_id: null,
    });
    const r = await mcpCommand.exec(['show', 'db'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('granted');
    expect(text).not.toContain('1970'); // localTimestamp(0) → '—'
  });

  test('revoke calls the manager and reports the removal', async () => {
    let called = '';
    const mgr = fakeManager([], {
      revoke: async (n) => {
        called = n;
        return { ok: true, tools: 2 };
      },
    });
    const r = await mcpCommand.exec(['revoke', 'db'], buildCtx(mgr));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(called).toBe('db');
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('Revoked');
    expect(text).toContain('2 tools');
  });

  test('revoke is refused mid-turn (must not touch the live registry)', async () => {
    let called = false;
    const mgr = fakeManager([], {
      revoke: async () => {
        called = true;
        return { ok: true, tools: 0 };
      },
    });
    const r = await mcpCommand.exec(['revoke', 'db'], buildCtx(mgr, true)); // a turn is running
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('a turn is in flight');
    expect(called).toBe(false); // gated BEFORE the manager call
  });

  test('reconnect calls the manager + surfaces its warnings', async () => {
    const mgr = fakeManager([], {
      reconnect: async () => ({ ok: true, registered: 3, warnings: ['mcp: heads up'] }),
    });
    const r = await mcpCommand.exec(['reconnect', 'db'], buildCtx(mgr));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('Reconnected');
    expect(text).toContain('3 tools');
    expect(text).toContain('mcp: heads up');
  });

  test('revoke without a server name errors', async () => {
    const r = await mcpCommand.exec(['revoke'], buildCtx(fakeManager([])));
    expect(r.kind).toBe('error');
  });

  test('revoke without a manager (headless) errors', async () => {
    const r = await mcpCommand.exec(['revoke', 'db'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('not active');
  });

  test('a failed revoke surfaces the manager reason', async () => {
    const mgr = fakeManager([], {
      revoke: async () => ({ ok: false, reason: 'unknown server', tools: 0 }),
    });
    const r = await mcpCommand.exec(['revoke', 'nope'], buildCtx(mgr));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('unknown server');
  });

  test('reconnect is refused mid-turn (must not touch the live registry)', async () => {
    let called = false;
    const mgr = fakeManager([], {
      reconnect: async () => {
        called = true;
        return { ok: true, registered: 0, warnings: [] };
      },
    });
    const r = await mcpCommand.exec(['reconnect', 'db'], buildCtx(mgr, true));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('a turn is in flight');
    expect(called).toBe(false);
  });

  test('a failed/denied reconnect is an ERROR (still revoked), not a green 0-tools note', async () => {
    const mgr = fakeManager([], {
      reconnect: async () => ({ ok: false, reason: 'denied', registered: 0, warnings: [] }),
    });
    const r = await mcpCommand.exec(['reconnect', 'db'], buildCtx(mgr));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('still revoked');
    expect(r.message).toContain('denied');
  });

  test('reconnect without a manager (headless) errors', async () => {
    const r = await mcpCommand.exec(['reconnect', 'db'], buildCtx());
    expect(r.kind).toBe('error');
  });
});
