// /memory slash command tests (MEMORY.md §6.3).
//
// Mirrors the history.test.ts pattern: real migrated memory db,
// real registry on a tmpdir, exercise the command and assert
// against returned notes / db state.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCommand } from '../../../src/cli/slash/commands/memory.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import type { ScopeRoots } from '../../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../../src/memory/registry.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createMemoryEvent } from '../../../src/storage/repos/memory-events.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-slash-memory-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeBody = (
  dir: string,
  name: string,
  fmExtras: { type?: string; source?: string; trust?: string; expires?: string } = {},
  body = `body of ${name}`,
): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: hook for ${name}`,
    `type: ${fmExtras.type ?? 'feedback'}`,
    `source: ${fmExtras.source ?? 'user_explicit'}`,
  ];
  if (fmExtras.expires !== undefined) lines.push(`expires: ${fmExtras.expires}`);
  if (fmExtras.trust !== undefined) lines.push(`trust: ${fmExtras.trust}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
};

interface CtxBundle {
  ctx: SlashContext;
  db: DB;
  registry: ReturnType<typeof createMemoryRegistry>;
  roots: ScopeRoots;
  sessionId: string;
}

const makeCtx = (repo: string): CtxBundle => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const db = openMemoryDb();
  migrate(db);
  const sessionId = createSession(db, { model: 'test/m', cwd: repo }).id;
  const roots = makeRoots(repo);
  const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
  const baseConfig = {
    cwd: repo,
    enableCheckpoints: false,
    planMode: false,
    budget: { ...DEFAULT_BUDGET },
    provider: {
      id: 'test/m',
      capabilities: { context_window: 1000, output_max_tokens: 100 },
    },
    memoryRegistry: registry,
  } as unknown as HarnessConfig;
  return {
    ctx: {
      baseConfig,
      db,
      bus,
      modalManager,
      cumulative: { costUsd: 0, steps: 0, turns: 0 },
      now: () => 1,
      requestShutdown: () => {},
      isRunning: () => false,
      currentSessionId: () => sessionId,
      modelRegistry: createModelRegistry(),
    },
    db,
    registry,
    roots,
    sessionId,
  };
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('/memory (no subcommand) — summary', () => {
  test('reports zero memories with usage hint', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.[0]).toContain('no memories registered');
  });

  test('reports per-scope counts when memories exist', async () => {
    const repo = makeTmp();
    const { ctx, roots } = makeCtx(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeIndex(roots.projectLocal, '- [C](c.md) — h\n');
    writeBody(roots.user, 'a', { type: 'user' });
    writeBody(roots.user, 'b', { type: 'user' });
    writeBody(roots.projectLocal, 'c');
    ctx.baseConfig.memoryRegistry?.reload();
    const r = await memoryCommand.exec([], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const summary = r.notes?.[0] ?? '';
    expect(summary).toContain('3 active');
    expect(summary).toContain('2 user');
    expect(summary).toContain('1 local');
    expect(summary).toContain('0 shared');
  });

  test('errors cleanly when memory subsystem is not wired', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    (ctx.baseConfig as { memoryRegistry?: unknown }).memoryRegistry = undefined;
    const r = await memoryCommand.exec([], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('not wired');
  });
});

describe('/memory list', () => {
  test('default lists all scopes deduplicated', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.user, '- [A](a.md) — user-A\n- [Both](both.md) — user-version\n');
    writeIndex(
      roots.projectLocal,
      '- [Local](local-only.md) — local-only\n- [Both](both.md) — local-version\n',
    );
    writeBody(roots.user, 'a', { type: 'user' });
    writeBody(roots.user, 'both', { type: 'user' });
    writeBody(roots.projectLocal, 'local-only');
    writeBody(roots.projectLocal, 'both');
    registry.reload();
    const r = await memoryCommand.exec(['list'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('memories (3, deduplicated by name)');
    expect(text).toContain('[user] a');
    expect(text).toContain('[project_local] local-only');
    // Dedup: `both` shows up exactly once, project_local wins.
    expect(text).toContain('[project_local] both');
    expect(text).not.toContain('user-version'); // user shadow hidden
    const matches = text.match(/both/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('scope user filters to user only', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.user, '- [U](u.md) — user-mem\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — local-mem\n');
    writeBody(roots.user, 'u', { type: 'user' });
    writeBody(roots.projectLocal, 'l');
    registry.reload();
    const r = await memoryCommand.exec(['list', 'user'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('[user] u');
    expect(text).not.toContain('[project_local]');
  });

  test('scope project covers shared + local with dedup', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(
      roots.projectShared,
      '- [Shared](shared-only.md) — shared\n- [Both](both.md) — shared-ver\n',
    );
    writeIndex(
      roots.projectLocal,
      '- [Local](local-only.md) — local\n- [Both](both.md) — local-ver\n',
    );
    writeBody(roots.projectShared, 'shared-only');
    writeBody(roots.projectShared, 'both');
    writeBody(roots.projectLocal, 'local-only');
    writeBody(roots.projectLocal, 'both');
    registry.reload();
    const r = await memoryCommand.exec(['list', 'project'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain("memories in scope 'project' (3)");
    expect(text).toContain('[project_local] local-only');
    expect(text).toContain('[project_shared] shared-only');
    expect(text).toContain('[project_local] both'); // local wins
    expect(text).not.toContain('shared-ver');
  });

  test('scope shared filters to project_shared only', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.projectShared, '- [S](s.md) — shared\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — local\n');
    writeBody(roots.projectShared, 's');
    writeBody(roots.projectLocal, 'l');
    registry.reload();
    const r = await memoryCommand.exec(['list', 'shared'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('[project_shared] s');
    expect(text).not.toContain('[project_local]');
  });

  test('scope local filters to project_local only', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.projectShared, '- [S](s.md) — h\n');
    writeIndex(roots.projectLocal, '- [L](l.md) — h\n');
    writeBody(roots.projectShared, 's');
    writeBody(roots.projectLocal, 'l');
    registry.reload();
    const r = await memoryCommand.exec(['list', 'local'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('[project_local] l');
    expect(text).not.toContain('[project_shared]');
  });

  test('invalid scope arg errors with options list', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['list', 'bogus'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain("invalid scope 'bogus'");
      expect(r.message).toContain('user, project, local, shared');
    }
  });

  test('too many args errors', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['list', 'user', 'extra'], ctx);
    expect(r.kind).toBe('error');
  });

  test('empty scope yields friendly empty message', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['list', 'user'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    expect(r.notes?.[0]).toContain("no memories in scope 'user'");
  });
});

describe('/memory show', () => {
  test('renders frontmatter + body for a present memory', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(
      roots.projectLocal,
      'mem',
      { source: 'inferred', expires: '2030-01-01' },
      'multi\nline\nbody',
    );
    registry.reload();
    const r = await memoryCommand.exec(['show', 'mem'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('project_local/mem');
    expect(text).toContain('description: hook for mem');
    expect(text).toContain('source:      inferred');
    expect(text).toContain('expires:     2030-01-01');
    expect(text).toContain('multi');
    expect(text).toContain('line');
    expect(text).toContain('body');
  });

  test('strict scope arg pins lookup, no fallback', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.user, '- [Mem](mem.md) — h\n');
    writeBody(roots.user, 'mem', { type: 'user' });
    registry.reload();
    // user-scope lookup succeeds.
    const ok = await memoryCommand.exec(['show', 'mem', 'user'], ctx);
    expect(ok.kind).toBe('ok');
    // local-scope strict lookup fails (no fallback to user).
    const miss = await memoryCommand.exec(['show', 'mem', 'local'], ctx);
    expect(miss.kind).toBe('error');
    if (miss.kind === 'error') expect(miss.message).toContain('no memory named');
  });

  test('missing name errors', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['show'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('missing name');
  });

  test('unknown name errors', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['show', 'nope'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain("no memory named 'nope'");
  });

  test('invalid scope arg rejects (no project alias for show)', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['show', 'mem', 'project'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain("invalid scope 'project'");
  });

  test('emits read audit row (operator-initiated load)', async () => {
    const repo = makeTmp();
    const { ctx, db, registry, roots } = makeCtx(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    registry.reload();
    const r = await memoryCommand.exec(['show', 'mem'], ctx);
    expect(r.kind).toBe('ok');
    // listMemoryEventsByName comes back DESC; the read row is the
    // top one.
    const { listMemoryEventsByName } = await import('../../../src/storage/repos/memory-events.ts');
    const events = listMemoryEventsByName(db, 'mem');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('read');
  });

  test('read audit row carries currentSessionId attribution', async () => {
    // Regression for the Tier 1 review bug: previously, /memory
    // show landed audit rows with session_id NULL because the
    // SlashContext didn't expose the active session id. The
    // currentSessionId() getter now threads the REPL's
    // lastSessionId through; assert it lands on the row.
    const repo = makeTmp();
    const { ctx, db, registry, roots, sessionId } = makeCtx(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    registry.reload();
    await memoryCommand.exec(['show', 'mem'], ctx);
    const { listMemoryEventsByName } = await import('../../../src/storage/repos/memory-events.ts');
    const events = listMemoryEventsByName(db, 'mem');
    expect(events[0]?.sessionId).toBe(sessionId);
  });

  test('skips session attribution when currentSessionId returns null', async () => {
    // REPL between boot and first turn: lastSessionId is null,
    // currentSessionId() returns null, /memory show should NOT
    // forward null as auditSessionId (would override the
    // registry's captured value with NULL).
    const repo = makeTmp();
    const { ctx, db, registry, roots } = makeCtx(repo);
    // Override currentSessionId to null for this test.
    (ctx as { currentSessionId: () => string | null }).currentSessionId = () => null;
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    registry.reload();
    await memoryCommand.exec(['show', 'mem'], ctx);
    const { listMemoryEventsByName } = await import('../../../src/storage/repos/memory-events.ts');
    const events = listMemoryEventsByName(db, 'mem');
    // Registry's constructor-captured sessionId wins (the
    // makeCtx fixture passes sessionId at construction).
    expect(events[0]?.sessionId).not.toBeNull();
  });

  test('renders project_shared body with strict scope arg', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.projectShared, '- [Conv](conv.md) — team conventions\n');
    writeBody(roots.projectShared, 'conv', { source: 'imported' }, 'shared body content');
    registry.reload();
    const r = await memoryCommand.exec(['show', 'conv', 'shared'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('project_shared/conv');
    expect(text).toContain('source:      imported');
    expect(text).toContain('shared body content');
  });

  test('renders triggers field when present in frontmatter', async () => {
    const repo = makeTmp();
    const { ctx, registry, roots } = makeCtx(repo);
    writeIndex(roots.projectLocal, '- [Tagged](tagged.md) — h\n');
    // writeBody helper doesn't support `triggers:`; write the file
    // directly so the YAML carries the array.
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'tagged.md'),
      [
        '---',
        'name: tagged',
        'description: hook for tagged',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - git',
        '  - bash',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    registry.reload();
    const r = await memoryCommand.exec(['show', 'tagged'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('triggers:    git, bash');
  });
});

describe('/memory audit', () => {
  let ctx: SlashContext;
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    const repo = makeTmp();
    const bundle = makeCtx(repo);
    ctx = bundle.ctx;
    db = bundle.db;
    sessionId = bundle.sessionId;
  });

  test('default: empty current session yields scope-aware message', async () => {
    const r = await memoryCommand.exec(['audit'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    expect(r.notes?.[0]).toContain('no memory events in the current session');
    expect(r.notes?.[0]).toContain('--all');
  });

  test('default: scopes to current session, drops cross-session rows', async () => {
    // Event in current session.
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'mine',
      source: 'inferred',
      sessionId,
      cwd: '/p',
      createdAt: 1000,
    });
    // Event with no session (lifecycle GC pattern) — must NOT appear
    // in the default view.
    createMemoryEvent(db, {
      scope: 'user',
      action: 'expired',
      memoryName: 'orphan',
      source: 'user_explicit',
      cwd: '/p',
      createdAt: 2000,
    });
    const r = await memoryCommand.exec(['audit'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    expect(r.notes?.[0]).toContain('current session');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('mine');
    expect(text).not.toContain('orphan');
  });

  test('--all returns cross-session rows including session_id NULL', async () => {
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'in-session',
      source: 'inferred',
      sessionId,
      cwd: '/p',
      createdAt: 1000,
    });
    createMemoryEvent(db, {
      scope: 'user',
      action: 'expired',
      memoryName: 'orphan',
      source: 'user_explicit',
      cwd: '/p',
      createdAt: 2000,
    });
    const r = await memoryCommand.exec(['audit', '--all'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    expect(r.notes?.[0]).toContain('all sessions');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('in-session');
    expect(text).toContain('orphan');
  });

  test('renders events most-recent-first within current session', async () => {
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'first',
      source: 'inferred',
      sessionId,
      cwd: '/p',
      createdAt: 1000,
    });
    createMemoryEvent(db, {
      scope: 'user',
      action: 'expired',
      memoryName: 'second',
      source: 'user_explicit',
      sessionId,
      cwd: '/p',
      createdAt: 2000,
      details: { expires: '2024-01-01' },
    });
    const r = await memoryCommand.exec(['audit'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const lines = r.notes ?? [];
    expect(lines[0]).toContain('(2');
    // Most recent (second/expired) first.
    expect(lines[1]).toContain('expired');
    expect(lines[1]).toContain('user/second');
    expect(lines[2]).toContain('created');
    expect(lines[2]).toContain('project_local/first');
  });

  test('--limit caps output (within session scope)', async () => {
    for (let i = 0; i < 5; i++) {
      createMemoryEvent(db, {
        scope: 'project_local',
        action: 'created',
        memoryName: `m${i}`,
        source: 'inferred',
        sessionId,
        cwd: '/p',
        createdAt: i * 100,
      });
    }
    const r = await memoryCommand.exec(['audit', '--limit', '3'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    // Header + 3 rows = 4 lines.
    expect(r.notes).toHaveLength(4);
  });

  test('--name filters to one memory (cross-session, since name is unique)', async () => {
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'wanted',
      source: 'inferred',
      cwd: '/p',
      createdAt: 1000,
    });
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'unwanted',
      source: 'inferred',
      cwd: '/p',
      createdAt: 2000,
    });
    const r = await memoryCommand.exec(['audit', '--name', 'wanted'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('wanted');
    expect(text).not.toContain('unwanted');
  });

  test('--name + --limit combined caps the per-name history', async () => {
    // Five events for the same name; --limit 2 caps at the 2 most
    // recent (per listMemoryEventsByName ORDER BY DESC + LIMIT).
    for (let i = 0; i < 5; i++) {
      createMemoryEvent(db, {
        scope: 'project_local',
        action: 'created',
        memoryName: 'busy',
        source: 'inferred',
        cwd: '/p',
        createdAt: i * 100,
      });
    }
    const r = await memoryCommand.exec(['audit', '--name', 'busy', '--limit', '2'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    // Header + 2 rows.
    expect(r.notes).toHaveLength(3);
    expect(r.notes?.[0]).toContain("for 'busy'");
  });

  test('--name with no match returns scoped empty message', async () => {
    const r = await memoryCommand.exec(['audit', '--name', 'ghost'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    expect(r.notes?.[0]).toContain("no audit rows for 'ghost'");
  });

  test('refused row surfaces stage in the detail column (current-session scope)', async () => {
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'refused',
      memoryName: 'rejected',
      source: 'inferred',
      sessionId,
      cwd: '/p',
      createdAt: 1000,
      details: { stage: 'scanner', reason: 'injection phrase' },
    });
    const r = await memoryCommand.exec(['audit'], ctx);
    if (r.kind !== 'ok') throw new Error(`unexpected: ${JSON.stringify(r)}`);
    const row = (r.notes ?? [])[1] ?? '';
    expect(row).toContain('refused');
    expect(row).toContain('[scanner: injection phrase]');
  });

  test('invalid --limit value errors', async () => {
    const r = await memoryCommand.exec(['audit', '--limit', 'abc'], ctx);
    expect(r.kind).toBe('error');
  });

  test('unknown flag errors', async () => {
    const r = await memoryCommand.exec(['audit', '--bogus'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain("unknown flag '--bogus'");
  });
});

describe('/memory unknown subcommand', () => {
  test('errors with usage hint', async () => {
    const repo = makeTmp();
    const { ctx } = makeCtx(repo);
    const r = await memoryCommand.exec(['nonsense'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain("unknown subcommand 'nonsense'");
  });
});
