// /hooks slash command tests (spec AGENTIC_CLI.md §10.4).

import { describe, expect, test } from 'bun:test';
import { hooksCommand } from '../../../src/cli/slash/commands/hooks.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, type HookSpec } from '../../../src/hooks/index.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createHookRun } from '../../../src/storage/repos/hook-runs.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

const baseSpec = (
  overrides: Partial<HookSpec> & Pick<HookSpec, 'event' | 'command'>,
): HookSpec => ({
  layer: 'project',
  sourcePath: '/repo/.agent/hooks.toml',
  matcher: {},
  timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  failClosed: false,
  locked: false,
  entryIndex: 0,
  ...overrides,
});

interface CtxBundle {
  ctx: SlashContext;
  db: DB;
  sessionId: string;
}

const makeCtx = (hooks: readonly HookSpec[]): CtxBundle => {
  const bus = createBus();
  const fs = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack: fs, now: () => 1 });
  const db = openMemoryDb();
  migrate(db);
  const sessionId = createSession(db, { model: 'test/m', cwd: '/p' }).id;
  const baseConfig = {
    cwd: '/p',
    hooks,
    provider: {
      id: 'test/m',
      capabilities: { context_window: 1000, output_max_tokens: 100 },
    },
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
    sessionId,
  };
};

describe('/hooks — summary (no args)', () => {
  test('zero hooks → "0 loaded" message + spec hint', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.notes?.[0]).toContain('hooks: 0 loaded');
      expect(r.notes?.join('\n')).toContain('hooks.toml');
    }
  });

  test('summary groups counts by layer + event', async () => {
    const { ctx } = makeCtx([
      baseSpec({
        event: 'PreToolUse',
        command: 'echo a',
        layer: 'enterprise',
        sourcePath: '/etc/agent/hooks.toml',
      }),
      baseSpec({
        event: 'PreToolUse',
        command: 'echo b',
        layer: 'project',
      }),
      baseSpec({
        event: 'PostToolUse',
        command: 'echo c',
        layer: 'project',
      }),
    ]);
    const r = await hooksCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('hooks: 3 loaded');
      expect(text).toContain('enterprise: 1');
      expect(text).toContain('project: 2');
      expect(text).toContain('PreToolUse: 2');
      expect(text).toContain('PostToolUse: 1');
    }
  });
});

describe('/hooks list', () => {
  test('lists all hooks grouped by layer with event/cmd/source', async () => {
    const { ctx } = makeCtx([
      baseSpec({
        event: 'PreToolUse',
        command: 'prettier --write {{tool.input.path}}',
        layer: 'project',
        matcher: { tool: 'write_file' },
      }),
      baseSpec({
        event: 'Stop',
        command: 'notify-send done',
        layer: 'user',
        sourcePath: '/home/op/.config/agent/hooks.toml',
      }),
    ]);
    const r = await hooksCommand.exec(['list'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('user:');
      expect(text).toContain('project:');
      expect(text).toContain('PreToolUse');
      expect(text).toContain('matcher=tool:write_file');
      expect(text).toContain('Stop');
      // Source-path frag should appear for both layers
      expect(text).toContain('/repo/.agent/hooks.toml');
      expect(text).toContain('/home/op/.config/agent/hooks.toml');
    }
  });

  test('--layer filters', async () => {
    const { ctx } = makeCtx([
      baseSpec({ event: 'PreToolUse', command: 'a', layer: 'enterprise', sourcePath: '/etc' }),
      baseSpec({ event: 'PreToolUse', command: 'b', layer: 'project' }),
    ]);
    const r = await hooksCommand.exec(['list', '--layer', 'project'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('hooks list: 1/2');
      expect(text).toContain('project:');
      expect(text).not.toContain('enterprise:');
    }
  });

  test('--event filters', async () => {
    const { ctx } = makeCtx([
      baseSpec({ event: 'PreToolUse', command: 'a' }),
      baseSpec({ event: 'Stop', command: 'b' }),
    ]);
    const r = await hooksCommand.exec(['list', '--event', 'Stop'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('hooks list: 1/2');
      expect(text).toContain('Stop');
      expect(text).not.toContain('PreToolUse');
    }
  });

  test('[index] label uses spec.entryIndex (matches audit hook_index)', async () => {
    // Sanity-revert: an earlier cut labeled rows with the
    // post-filter loop counter, so an operator filtering by
    // --event would see [0] for a hook whose audit row carried
    // hook_index=1 (the source-file position). Operators
    // correlating a `hook_runs` row to its config entry would
    // hit the wrong rule. Fix uses spec.entryIndex (the same
    // value dispatchOne writes to hook_runs), so `<source>#<n>`
    // references stay consistent across filters.
    const { ctx } = makeCtx([
      // Source layout: PreToolUse at index 0, Stop at index 1
      // — same hooks.toml file, two events.
      baseSpec({ event: 'PreToolUse', command: 'a', entryIndex: 0 }),
      baseSpec({ event: 'Stop', command: 'b', entryIndex: 1 }),
    ]);
    const r = await hooksCommand.exec(['list', '--event', 'Stop'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      // Filtered output must still show [1] (source position),
      // not [0] (post-filter loop index).
      expect(text).toContain('[1] Stop');
      expect(text).not.toContain('[0] Stop');
    }
  });

  test('locked + fail_closed flags surface', async () => {
    const { ctx } = makeCtx([
      baseSpec({
        event: 'PreToolUse',
        command: 'guard',
        locked: true,
        failClosed: true,
        layer: 'enterprise',
        sourcePath: '/etc/agent/hooks.toml',
      }),
    ]);
    const r = await hooksCommand.exec(['list'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('locked');
      expect(text).toContain('fail_closed');
    }
  });

  test('long command preview is truncated', async () => {
    const longCmd = 'a'.repeat(200);
    const { ctx } = makeCtx([baseSpec({ event: 'Stop', command: longCmd })]);
    const r = await hooksCommand.exec(['list'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      // Truncated to <= 60 chars (with ellipsis), not the full 200
      expect(text).toContain('…');
      expect(text).not.toContain(longCmd);
    }
  });

  test('no match → friendly note', async () => {
    const { ctx } = makeCtx([baseSpec({ event: 'Stop', command: 'a' })]);
    const r = await hooksCommand.exec(['list', '--event', 'PreToolUse'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.notes?.[0]).toContain('no hooks matched');
    }
  });

  test('unknown layer → error', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec(['list', '--layer', 'bogus'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('unknown layer');
  });

  test('unknown event → error', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec(['list', '--event', 'BogusEvent'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('unknown event');
  });
});

describe('/hooks audit', () => {
  test('zero rows → friendly note', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec(['audit'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.notes?.[0]).toContain('no runs');
  });

  test('shows recent rows newest first', async () => {
    const { ctx, db, sessionId } = makeCtx([]);
    // Land 3 rows at increasing timestamps
    for (let i = 0; i < 3; i += 1) {
      createHookRun(db, {
        sessionId,
        event: 'PreToolUse',
        layer: 'project',
        sourcePath: '/repo/.agent/hooks.toml',
        hookIndex: 0,
        command: 'true',
        expanded: 'true',
        exitCode: 0,
        outcome: 'allow',
        durationMs: 5,
        stdout: null,
        stderr: null,
        matchedTool: 'echo',
        createdAt: 1000 + i,
      });
    }
    const r = await hooksCommand.exec(['audit'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('hooks audit: 3 run(s)');
      expect(text).toContain('PreToolUse');
      expect(text).toContain('outcome=allow');
      expect(text).toContain('tool=echo');
    }
  });

  test('--event filters by event name', async () => {
    const { ctx, db, sessionId } = makeCtx([]);
    createHookRun(db, {
      sessionId,
      event: 'PreToolUse',
      layer: 'project',
      sourcePath: '/p',
      hookIndex: 0,
      command: 't',
      expanded: 't',
      exitCode: 0,
      outcome: 'allow',
      durationMs: 1,
      stdout: null,
      stderr: null,
      matchedTool: null,
      createdAt: 100,
    });
    createHookRun(db, {
      sessionId,
      event: 'Stop',
      layer: 'project',
      sourcePath: '/p',
      hookIndex: 0,
      command: 't',
      expanded: 't',
      exitCode: 0,
      outcome: 'allow',
      durationMs: 1,
      stdout: null,
      stderr: null,
      matchedTool: null,
      createdAt: 200,
    });
    const r = await hooksCommand.exec(['audit', '--event', 'Stop'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('Stop');
      expect(text).not.toContain('PreToolUse');
    }
  });

  test('--event + --limit: filter pushes down BEFORE limit', async () => {
    // Sanity-revert: an earlier cut fetched `--limit` rows first
    // and applied the event filter in memory afterward. With
    // mixed events crowding the recent tail, `audit --event Stop
    // --limit 5` would return zero rows even though older Stop
    // rows existed. The fix pushes the filter into SQL so LIMIT
    // applies to MATCHING rows only.
    const { ctx, db, sessionId } = makeCtx([]);
    // 10 PreToolUse rows (the recent crowd)
    for (let i = 0; i < 10; i += 1) {
      createHookRun(db, {
        sessionId,
        event: 'PreToolUse',
        layer: 'project',
        sourcePath: '/p',
        hookIndex: 0,
        command: 't',
        expanded: 't',
        exitCode: 0,
        outcome: 'allow',
        durationMs: 1,
        stdout: null,
        stderr: null,
        matchedTool: null,
        createdAt: 1_000 + i,
      });
    }
    // 3 older Stop rows
    for (let i = 0; i < 3; i += 1) {
      createHookRun(db, {
        sessionId,
        event: 'Stop',
        layer: 'project',
        sourcePath: '/p',
        hookIndex: 0,
        command: 't',
        expanded: 't',
        exitCode: 0,
        outcome: 'allow',
        durationMs: 1,
        stdout: null,
        stderr: null,
        matchedTool: null,
        // Older than the PreToolUse crowd (createdAt 100..102)
        createdAt: 100 + i,
      });
    }
    // With limit=5 + event=Stop, all 3 Stop rows should land
    // (limit > matching count). Pre-fix: 0 rows because the
    // first 5 fetched were all PreToolUse and got filtered out.
    const r = await hooksCommand.exec(['audit', '--event', 'Stop', '--limit', '5'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      const text = r.notes?.join('\n') ?? '';
      expect(text).toContain('hooks audit: 3 run(s)');
      expect(text).not.toContain('PreToolUse');
    }
  });

  test('--limit caps output', async () => {
    const { ctx, db, sessionId } = makeCtx([]);
    for (let i = 0; i < 5; i += 1) {
      createHookRun(db, {
        sessionId,
        event: 'Stop',
        layer: 'project',
        sourcePath: '/p',
        hookIndex: 0,
        command: 't',
        expanded: 't',
        exitCode: 0,
        outcome: 'allow',
        durationMs: 1,
        stdout: null,
        stderr: null,
        matchedTool: null,
        createdAt: 100 + i,
      });
    }
    const r = await hooksCommand.exec(['audit', '--limit', '2'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // 1 header line + 2 rows
      expect(r.notes).toHaveLength(3);
    }
  });

  test('--session scopes to current session', async () => {
    const { ctx, db, sessionId } = makeCtx([]);
    // Row in current session
    createHookRun(db, {
      sessionId,
      event: 'Stop',
      layer: 'project',
      sourcePath: '/p',
      hookIndex: 0,
      command: 't',
      expanded: 't',
      exitCode: 0,
      outcome: 'allow',
      durationMs: 1,
      stdout: null,
      stderr: null,
      matchedTool: null,
      createdAt: 100,
    });
    // Row in a different session
    const otherSession = createSession(db, { model: 'test/m', cwd: '/p' }).id;
    createHookRun(db, {
      sessionId: otherSession,
      event: 'Stop',
      layer: 'project',
      sourcePath: '/p',
      hookIndex: 0,
      command: 't',
      expanded: 't',
      exitCode: 0,
      outcome: 'allow',
      durationMs: 1,
      stdout: null,
      stderr: null,
      matchedTool: null,
      createdAt: 200,
    });
    const r = await hooksCommand.exec(['audit', '--session'], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      // Only the current-session row, not the other.
      expect(r.notes?.join('\n')).toContain('1 run(s)');
      expect(r.notes?.[0]).toContain('this session');
    }
  });

  test('--session before any session yet → graceful note', async () => {
    const { ctx } = makeCtx([]);
    // Override currentSessionId to null (between boot and first turn)
    const ctxWithoutSession: SlashContext = { ...ctx, currentSessionId: () => null };
    const r = await hooksCommand.exec(['audit', '--session'], ctxWithoutSession);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.notes?.[0]).toContain('no session yet');
  });

  test('invalid --limit → error', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec(['audit', '--limit', 'abc'], ctx);
    expect(r.kind).toBe('error');
  });

  test('--limit rejects partial-numeric coercion (sanity-revert)', async () => {
    // Sanity-revert: pre-fix used Number.parseInt which
    // silently coerced `20foo` → 20 and `1e3` → 1 (parseInt
    // stops at the first non-digit). Operator typos produced
    // surprising audit output instead of an error matching
    // the documented "positive integer" message. Strict regex
    // gates the parse now.
    const { ctx } = makeCtx([]);
    for (const bad of ['20foo', '1e3', '20.5', ' 20', '20 ', '+20', '0x10', '', '-5']) {
      const r = await hooksCommand.exec(['audit', '--limit', bad], ctx);
      expect(r.kind).toBe('error');
      if (r.kind === 'error') {
        expect(r.message).toContain('positive integer');
      }
    }
  });

  test('--limit accepts canonical integer strings', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec(['audit', '--limit', '20'], ctx);
    // No rows in DB → "no runs" note; importantly NOT an
    // error (the value parsed cleanly).
    expect(r.kind).toBe('ok');
  });

  test('unknown subcommand → error', async () => {
    const { ctx } = makeCtx([]);
    const r = await hooksCommand.exec(['nope'], ctx);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('unknown subcommand');
  });
});
