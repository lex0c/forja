// /mcp slash command (list / show / revoke / reconnect / logs). MCP.md §7.

import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpCommand } from '../../../src/cli/slash/commands/mcp.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import type { McpManager, McpServerStatus } from '../../../src/mcp/manager.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import {
  insertServer,
  patchServer,
  recordManifestDecision,
} from '../../../src/storage/repos/mcp-servers.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let db: DB;

// No real manager computes a scope in these tests (a bare `buildCtx()` uses the
// any-scope reads; the mock reports scope ''), so a fixed '' matches every seed.
const SCOPE = '';

interface FakeHooks {
  revoke?: (name: string) => Promise<{ ok: boolean; reason?: string; tools: number }>;
  reconnect?: (
    name: string,
  ) => Promise<{ ok: boolean; reason?: string; registered: number; warnings: string[] }>;
  logPath?: (name: string) => string | null;
}
const fakeManager = (status: McpServerStatus[], hooks: FakeHooks = {}): McpManager =>
  ({
    init: async () => ({ registered: 0, servers: [], warnings: [] }),
    callTool: async () => ({ isError: false, content: '' }),
    state: (n: string) => status.find((s) => s.name === n)?.state ?? null,
    scopes: () => [SCOPE],
    // All seeded rows use scope '' here; the caller's getServer null-check handles
    // an unknown server, so return the scope unconditionally.
    scopeFor: () => SCOPE,
    status: () => status,
    logPath: hooks.logPath ?? (() => null),
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
    scope: SCOPE,
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

describe('/mcp slash command', () => {
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
      scope: SCOPE,
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

  test('show <remote> renders the trusted URL (not command: —)', async () => {
    insertServer(db, {
      scope: SCOPE,
      name: 'gh',
      transport: 'http',
      command: null, // remote servers carry no command
      url: 'https://mcp.example.com/v1',
      source: 'project_shared',
      state: 'trusted',
    });
    const r = await mcpCommand.exec(['show', 'gh'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('url:');
    expect(text).toContain('https://mcp.example.com/v1'); // the approved endpoint is visible
    expect(text).not.toContain('command:'); // no misleading empty command line
  });

  test('show <remote> unwraps the {url, auth} identity blob', async () => {
    insertServer(db, {
      scope: SCOPE,
      name: 'gh',
      transport: 'sse',
      command: null,
      url: JSON.stringify({ url: 'https://mcp.example.com/v1', auth: 'GH_TOKEN' }),
      source: 'project_shared',
      state: 'trusted',
    });
    const r = await mcpCommand.exec(['show', 'gh'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('https://mcp.example.com/v1');
    expect(text).toContain('auth env: $GH_TOKEN'); // the bound env var name, not the token
    expect(text).not.toContain('{'); // the raw JSON blob is not shown
  });

  test('show strips ANSI + control bytes from the persisted identity + server fields', async () => {
    // A hostile repo plants ANSI + a CR overwrite in the persisted stdio command;
    // a hostile server reports control bytes in its version + last error. /mcp show
    // must strip them — the info renderer prints these notes verbatim.
    insertServer(db, {
      scope: SCOPE,
      name: 'evil',
      transport: 'stdio',
      command: '["\x1b[2J\x1b[Hevil-bin","real\rFORGED"]',
      url: null,
      source: 'project_shared',
      state: 'trusted',
    });
    patchServer(db, SCOPE, 'evil', {
      server_version: '9\x1b[31m9',
      last_error: 'boom\x07\x08fail',
    });
    const r = await mcpCommand.exec(['show', 'evil'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text.includes('\x1b')).toBe(false);
    expect(text.includes('\r')).toBe(false);
    expect(text.includes('\x07')).toBe(false);
    expect(text.includes('\x08')).toBe(false);
    // Printable content survives (stripped, not dropped wholesale).
    expect(text).toContain('evil-bin');
    expect(text).toContain('FORGED');
  });

  test('show strips control bytes from a hostile remote URL', async () => {
    insertServer(db, {
      scope: SCOPE,
      name: 'evilremote',
      transport: 'http',
      command: null,
      url: 'https://x/\x1b[2J\x1b[Hmcp\rFORGED',
      source: 'project_shared',
      state: 'trusted',
    });
    const r = await mcpCommand.exec(['show', 'evilremote'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text.includes('\x1b')).toBe(false);
    expect(text.includes('\r')).toBe(false);
    expect(text).toContain('https://x/'); // the printable endpoint survives
  });

  test('show renders the stdio command readably, not the raw identity blob', async () => {
    // The persisted stdio identity is now a JSON blob {argv,cwd,env,…}; /mcp show
    // must unwrap it to a readable argv, not dump the raw JSON at the operator.
    insertServer(db, {
      scope: SCOPE,
      name: 'db',
      transport: 'stdio',
      command: JSON.stringify({ argv: ['node', './s.js'], cwd: '/w', env: { SECRET: '$SECRET' } }),
      url: null,
      source: 'project_shared',
      state: 'trusted',
    });
    const r = await mcpCommand.exec(['show', 'db'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('node ./s.js'); // readable argv
    expect(text).toContain('cwd: /w');
    expect(text).toContain('env: SECRET'); // the binding NAME, not the raw table
    expect(text).not.toContain('"argv"'); // the raw JSON blob is NOT shown
  });

  test('list shows the ACTIVE scope source for a name present in two scopes', async () => {
    // A user '' row shadowed by a same-named project row (the sweep keeps both).
    // Insert the project row FIRST so a naive last-wins map would pick the user row;
    // the active-scope preference must show the project source instead.
    insertServer(db, {
      scope: '/proj',
      name: 'db',
      transport: 'stdio',
      command: '["p"]',
      url: null,
      source: 'project_shared',
      state: 'trusted',
    });
    insertServer(db, {
      scope: '',
      name: 'db',
      transport: 'stdio',
      command: '["u"]',
      url: null,
      source: 'user',
      state: 'trusted',
    });
    const base = fakeManager([{ name: 'db', state: 'trusted', tools: 1 }]);
    const mgr = {
      ...base,
      scopes: () => ['/proj', ''],
      scopeFor: () => '/proj',
    } as unknown as McpManager;
    const r = await mcpCommand.exec([], buildCtx(mgr));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('project_shared'); // the ACTIVE (project) source
    expect(text).not.toContain('user'); // NOT the shadowed user row
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
      scope: SCOPE,
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

  test('logs without a manager errors', async () => {
    seed('db', 'trusted');
    const r = await mcpCommand.exec(['logs', 'db'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('not active');
  });

  test('logs of an unknown server errors', async () => {
    const r = await mcpCommand.exec(['logs', 'nope'], buildCtx(fakeManager([])));
    expect(r.kind).toBe('error');
  });

  test('logs with no configured log path → friendly note (headless trace dir absent)', async () => {
    seed('db', 'trusted');
    const r = await mcpCommand.exec(
      ['logs', 'db'],
      buildCtx(fakeManager([], { logPath: () => null })),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.join('\n')).toContain('No stderr log');
  });

  test('logs of a server that has not written stderr yet → "no stderr captured"', async () => {
    seed('db', 'trusted');
    const r = await mcpCommand.exec(
      ['logs', 'db'],
      buildCtx(fakeManager([], { logPath: () => '/no/such/dir/mcp-db.log' })),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.join('\n')).toContain('No stderr captured');
  });

  test('logs tails the captured stderr file (last N lines)', async () => {
    seed('db', 'trusted');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-'));
    const path = join(dir, 'mcp-db.log');
    writeFileSync(path, 'line one\nline two\nline three\n');
    try {
      const r = await mcpCommand.exec(
        ['logs', 'db'],
        buildCtx(fakeManager([], { logPath: () => path })),
      );
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('last 3 lines');
      expect(text).toContain('line one');
      expect(text).toContain('line three');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('logs strips ANSI + control bytes from server stderr (anti-repaint)', async () => {
    seed('db', 'trusted');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-'));
    const path = join(dir, 'mcp-db.log');
    // A hostile server writes a terminal-clear + a colored forgery + a CR overwrite
    // + a bell/backspace to its stderr; none must reach the operator's scrollback.
    writeFileSync(
      path,
      '\x1b[2J\x1b[Hcleared\n\x1b[31mFAKE\x1b[0m error\nreal\rFORGED\n\x07bell\x08\n',
    );
    try {
      const r = await mcpCommand.exec(
        ['logs', 'db'],
        buildCtx(fakeManager([], { logPath: () => path })),
      );
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      const text = r.notes?.join('\n') ?? '';
      // No raw control bytes reach the rendered notes.
      expect(text.includes('\x1b')).toBe(false);
      expect(text.includes('\r')).toBe(false);
      expect(text.includes('\x07')).toBe(false);
      expect(text.includes('\x08')).toBe(false);
      // The printable content survives (stripped, not dropped wholesale).
      expect(text).toContain('cleared');
      expect(text).toContain('FAKE error');
      expect(text).toContain('FORGED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('show hoists + glosses a bare last_error code directly under state', async () => {
    seed('db', 'degraded');
    patchServer(db, SCOPE, 'db', { last_error: 'mcp.budget.exceeded' });
    const r = await mcpCommand.exec(['show', 'db'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const lines = r.notes ?? [];
    const stateIdx = lines.findIndex((l) => l.includes('state:'));
    const errIdx = lines.findIndex((l) => l.includes('last error:'));
    expect(errIdx).toBe(stateIdx + 1); // the "why" leads, not eight lines down
    expect(lines[errIdx]).toContain('per-session call/token cap'); // glossed, not a bare code
  });

  test('a healthy server shows no last-error line', async () => {
    seed('db', 'trusted'); // last_error null
    const r = await mcpCommand.exec(['show', 'db'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.join('\n')).not.toContain('last error');
  });

  test('list prints a labeled column header', async () => {
    seed('db', 'trusted');
    const r = await mcpCommand.exec(
      [],
      buildCtx(fakeManager([{ name: 'db', state: 'trusted', tools: 1 }])),
    );
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = r.notes?.join('\n') ?? '';
    expect(text).toContain('SERVER');
    expect(text).toContain('STATE');
    expect(text).toContain('SOURCE');
  });

  test('list surfaces the /mcp reconnect cue for a denied/degraded server, and omits it when healthy', async () => {
    seed('db', 'trusted');
    const degraded = await mcpCommand.exec(
      [],
      buildCtx(fakeManager([{ name: 'db', state: 'degraded', tools: 0 }])),
    );
    if (degraded.kind !== 'ok') throw new Error('expected ok');
    expect(degraded.notes?.join('\n')).toContain('/mcp reconnect');

    const healthy = await mcpCommand.exec(
      [],
      buildCtx(fakeManager([{ name: 'db', state: 'trusted', tools: 1 }])),
    );
    if (healthy.kind !== 'ok') throw new Error('expected ok');
    expect(healthy.notes?.join('\n')).not.toContain('Re-run trust');
  });

  test('a failed reconnect surfaces the captured warnings + a logs pointer for an unreachable server', async () => {
    const mgr = fakeManager([], {
      reconnect: async () => ({
        ok: false,
        reason: 'error',
        registered: 0,
        warnings: ["mcp: server 'db' handshake failed: ECONNREFUSED"],
      }),
    });
    const r = await mcpCommand.exec(['reconnect', 'db'], buildCtx(mgr));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('ECONNREFUSED'); // the real cause, not just the bare state
    expect(r.message).toContain('/mcp logs db'); // reason 'error' → an unreachable server's next step
  });

  test('a failed reconnect STRIPS ANSI/control bytes from the surfaced warning (anti-spoof)', async () => {
    // A handshake-failed warning embeds the server's error text (a remote HTTP
    // body). A hostile server that plants a terminal-repaint payload must not reach
    // the operator's scrollback through the reconnect failure message.
    const mgr = fakeManager([], {
      reconnect: async () => ({
        ok: false,
        reason: 'error',
        registered: 0,
        warnings: ["mcp: server 'db' handshake failed: \x1b[2J\x1b[Hreal\rFORGED"],
      }),
    });
    const r = await mcpCommand.exec(['reconnect', 'db'], buildCtx(mgr));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message.includes('\x1b')).toBe(false);
    expect(r.message.includes('\r')).toBe(false);
    expect(r.message).toContain('FORGED'); // printable content survives, stripped
  });

  test('a failed revoke points the operator at the list', async () => {
    const mgr = fakeManager([], {
      revoke: async () => ({ ok: false, reason: 'unknown server', tools: 0 }),
    });
    const r = await mcpCommand.exec(['revoke', 'nope'], buildCtx(mgr));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('try /mcp to list');
  });

  test('logs of a server whose last record exceeds 64 KiB shows the truncated tail, not "empty"', async () => {
    seed('db', 'trusted');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-'));
    const path = join(dir, 'mcp-db.log');
    writeFileSync(path, 'x'.repeat(70 * 1024)); // one 70 KiB line, no newline
    try {
      const r = await mcpCommand.exec(
        ['logs', 'db'],
        buildCtx(fakeManager([], { logPath: () => path })),
      );
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      const text = r.notes?.join('\n') ?? '';
      expect(text).not.toContain('is empty'); // the >64 KiB single-line fix
      expect(text).toContain('xxx'); // shows the (truncated) trailing content
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
