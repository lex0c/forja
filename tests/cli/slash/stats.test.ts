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
import { appendCompactionEvent } from '../../../src/storage/repos/compaction-events.ts';
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
    provider: {
      id: 'test/m',
      capabilities: {
        context_window: 1000,
        output_max_tokens: 100,
        // Opus-like rates ($/MTok) so the cost breakdown has real numbers.
        cost_per_1k_input: 5,
        cost_per_1k_output: 25,
        cost_per_1k_cached_input: 0.5,
        cost_per_1k_cache_write: 6.25,
      },
    },
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
    // cache hit = read 3,500 / (in 6,000 + read 3,500 + write 500) = 35%.
    expect(text).toContain('35% hit');
    // scope counts root + subagent
    expect(text).toContain('2 sessions');
    // no lower-bound marker when usage is complete
    expect(text).not.toContain('~');
  });

  test('cost line reads "unmetered" for an unmetered provider, not $0', async () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0); // an unmetered tier records $0
    usage(root.id, { in: 6000, out: 2400, cacheRead: 0, cacheCreation: 0 });
    replIds = [root.id];
    const ctx = buildCtx();
    (ctx.baseConfig.provider.capabilities as { unmetered?: boolean }).unmetered = true;
    const r = await statsCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('cost:   unmetered');
  });

  test('cost line preserves real metered spend in a mixed scope (unmetered current model)', async () => {
    // A metered turn billed earlier (model switch / resumed session / metered subagent)
    // persists real cost in the aggregate. Switching to an unmetered model must NOT hide
    // those dollars behind the bare "unmetered" label.
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.05); // real metered spend in scope
    usage(root.id, { in: 6000, out: 2400, cacheRead: 0, cacheCreation: 0 });
    replIds = [root.id];
    const ctx = buildCtx();
    (ctx.baseConfig.provider.capabilities as { unmetered?: boolean }).unmetered = true;
    const r = await statsCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toMatch(/cost:\s+\$0\.05/); // the metered dollars are shown, not hidden
    expect(text).toContain('unmetered'); // and the untracked current-model component is flagged
    expect(text).not.toContain('cost:   unmetered'); // NOT the bare label that would hide spend
  });

  test('attributes cache write by source + write amplification', async () => {
    // parent writes 1000, a subagent writes 400, compaction writes 100.
    // total cache write 1500; reads 13,500 → amplification 1500/15000 = 10%.
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 0, out: 0, cacheRead: 13500, cacheCreation: 1000 });
    const child = createSession(db, { model: 'm', cwd: '/p', parentSessionId: root.id });
    usage(child.id, { in: 0, out: 0, cacheRead: 0, cacheCreation: 400 });
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'llm',
      foldedCount: 1,
      beforeHash: 'a',
      afterHash: 'b',
      callUsage: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 100 },
      recordedAt: 1,
    });
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('writes: 1,500 (parent 1,000 · subagents 400 · compaction 100)');
    expect(text).toContain('10% write amplification');
  });

  test('breaks cost down by axis — surfaces cache-write dominance', async () => {
    // A healthy token hit-ratio can still be cache-write-cost-dominated:
    // write bills 12.5x read per token. in 100 / out 100 / read 10k / write 5k
    // at rates 5/25/0.5/6.25 → in $0.0005 (1%), out $0.0025 (6%),
    // read $0.005 (13%), write $0.03125 (80%).
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.039);
    usage(root.id, { in: 100, out: 100, cacheRead: 10000, cacheCreation: 5000 });
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('spend:');
    // cache write is the dominant axis
    expect(text).toContain('cache write $0.0313 (80%)');
    expect(text).toContain('cache read $0.0050 (13%)');
    expect(text).toContain('out $0.0025 (6%)');
    expect(text).toContain('in $0.0005 (1%)');
    // the breakdown is flagged as an estimate
    expect(text).toContain('est. from current model rates');
  });

  test('renders per-turn economics, avg window/turn, and reuse factor', async () => {
    // 4 assistant turns. in 0 / out 800 / read 9000 / write 1000.
    // avg window = (0 + 9000 + 1000) / 4 = 2,500 tok/turn; ctx 1000 → 250%.
    // out/turn = 800 / 4 = 200. cost 0.08 / 4 = $0.0200/turn.
    // reuse = read 9000 / write 1000 = 9.0x.
    const root = createSession(db, { model: 'm', cwd: '/p' });
    updateSessionCost(db, root.id, 0.08);
    for (let i = 0; i < 4; i++) {
      usage(root.id, { in: 0, out: 200, cacheRead: 2250, cacheCreation: 250 });
    }
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('turns:  4 · $0.0200/turn · 200 tok out/turn');
    expect(text).toContain('window: 2,500 tok/turn avg (250% of ctx)');
    expect(text).toContain('9.0x reuse');
  });

  test('window line reports billed avg only (no raw-buffer "now" estimate)', async () => {
    // The window gauge must come from billed tokens, never the in-memory
    // buffer (which on resume holds the full restored history and would read
    // as >100% of ctx — a measurement artifact, not a real overflow).
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 0, out: 10, cacheRead: 690, cacheCreation: 0 });
    replIds = [root.id];
    // A wired live context with a buffer far larger than the window must NOT
    // leak into the output.
    const liveCtx = {
      getMessages: () => [{ role: 'user', content: 'x'.repeat(40000) }],
    } as unknown as ReturnType<NonNullable<SlashContext['liveContext']>>;

    const r = await statsCommand.exec([], buildCtx({ liveContext: () => liveCtx }));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    // avg window = (0 + 690 + 0) / 1 = 690 tok; ctx 1000 → 69%.
    expect(text).toContain('window: 690 tok/turn avg (69% of ctx)');
    expect(text).not.toContain('now ');
  });

  test('surfaces compaction ROI: run count + reclaimed context tokens', async () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 0, out: 10, cacheRead: 100, cacheCreation: 0 });
    appendCompactionEvent(db, {
      sessionId: root.id,
      strategy: 'llm',
      foldedCount: 6,
      beforeHash: 'a',
      afterHash: 'b',
      tokensBefore: 7000,
      tokensAfter: 2500,
      recordedAt: 1,
    });
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('compact: 1 run · reclaimed 4,500 ctx tok (est.)');
  });

  test('reports cache savings vs the no-cache counterfactual', async () => {
    // 1M tokens served from cache: actual read cost 1M × 0.5/MTok = $0.50.
    // No cache, those bill as input: 1M × 5/MTok = $5.00. Saved $4.50 = 90%.
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 0, out: 0, cacheRead: 1_000_000, cacheCreation: 0 });
    replIds = [root.id];

    const r = await statsCommand.exec([], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('saved:  $4.500 (90% vs no-cache est. $5.000)');
  });

  test('omits the savings line for zero-rate providers (nothing to save)', async () => {
    const root = createSession(db, { model: 'm', cwd: '/p' });
    usage(root.id, { in: 0, out: 0, cacheRead: 1_000_000, cacheCreation: 0 });
    replIds = [root.id];
    // A local model: all rates zero → no-cache cost is 0, savings undefined.
    const ctx = buildCtx();
    (ctx.baseConfig.provider.capabilities as unknown as Record<string, number>).cost_per_1k_input =
      0;
    (
      ctx.baseConfig.provider.capabilities as unknown as Record<string, number>
    ).cost_per_1k_cached_input = 0;

    const r = await statsCommand.exec([], ctx);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    const text = (r.notes ?? []).join('\n');
    expect(text).not.toContain('saved:');
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
