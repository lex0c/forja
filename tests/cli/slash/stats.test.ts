// /stats slash command tests.
//
// Real migrated DB wired through SlashContext: build sessions +
// messages, then assert the rendered notes. Aggregation correctness is
// covered in tests/storage/repos/stats.test.ts; here we pin the command
// surface — arg validation, empty-scope, formatting, lower-bound mark.

import { beforeEach, describe, expect, test } from 'bun:test';
import { statsCommand } from '../../../src/cli/slash/commands/stats.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import {
  createSession,
  markSessionUsageIncomplete,
  updateSessionCost,
} from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let db: DB;
let replIds: string[];

const buildCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const focusStack = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack, now: () => 1 });
  const baseConfig = {
    cwd: '/p',
    enableCheckpoints: false,
    budget: { ...DEFAULT_BUDGET },
    provider: { id: 'test/m', capabilities: { context_window: 1000, output_max_tokens: 100 } },
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now: () => 1,
    requestShutdown: () => {},
    isRunning: () => false,
    currentSessionId: () => replIds[replIds.length - 1] ?? null,
    replSessionIds: () => replIds,
    modelRegistry: createModelRegistry(),
    ...overrides,
  };
};

const usage = (
  sessionId: string,
  u: { in: number; out: number; cacheRead: number; cacheCreation: number },
): void => {
  appendMessage(db, {
    sessionId,
    role: 'assistant',
    content: 'x',
    tokensIn: u.in,
    tokensOut: u.out,
    cachedTokens: u.cacheRead,
    cacheCreationTokens: u.cacheCreation,
    costUsd: 0.001,
  });
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  replIds = [];
});

describe('/stats', () => {
  test('rejects arguments', async () => {
    const r = await statsCommand.exec(['foo'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('takes no arguments');
  });

  test('no sessions yet → friendly notice, not a crash', async () => {
    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.[0]).toContain('no sessions yet');
  });

  test('renders cost + token/cache totals (incl. subagents)', async () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.04);
    usage(root.id, { in: 6000, out: 2400, cacheRead: 3500, cacheCreation: 500 });
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    updateSessionCost(db, child.id, 0.02);
    usage(child.id, { in: 0, out: 100, cacheRead: 0, cacheCreation: 0 });
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    // cost = 0.04 + 0.02 = 0.06 → "$0.0600" (4 decimals under $1).
    expect(text).toContain('$0.0600');
    // compute = (6000+100) + 2400 = 8,500; cache = 3500 + 500 = 4,000;
    // total = 12,500.
    expect(text).toContain('12,500');
    expect(text).toContain('compute 8,500');
    expect(text).toContain('cache 4,000');
    // breakdown line
    expect(text).toContain('in 6,000');
    expect(text).toContain('out 2,500');
    expect(text).toContain('cache read 3,500');
    expect(text).toContain('write 500');
    // scope counts root + subagent
    expect(text).toContain('2 sessions');
    // no lower-bound marker when usage is complete
    expect(text).not.toContain('~');
  });

  test('marks totals as a lower bound when a session reported no usage', async () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.01);
    usage(root.id, { in: 10, out: 10, cacheRead: 0, cacheCreation: 0 });
    markSessionUsageIncomplete(db, root.id);
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('~$0.0100');
    expect(text).toContain('lower bound');
  });
});
