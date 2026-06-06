import { beforeEach, describe, expect, test } from 'bun:test';
import { compactCommand } from '../../../../src/cli/slash/commands/compact.ts';
import type { SlashContext } from '../../../../src/cli/slash/types.ts';
import { type AssistantUsage, SessionContext } from '../../../../src/harness/index.ts';
import { DEFAULT_BUDGET, type HarnessConfig } from '../../../../src/harness/types.ts';
import type { Provider, StreamEvent } from '../../../../src/providers/index.ts';
import { createRegistry as createModelRegistry } from '../../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../../src/storage/db.ts';
import { migrate } from '../../../../src/storage/migrate.ts';
import { createContextPinsStore } from '../../../../src/storage/repos/context-pins.ts';
import { createSession, getSession } from '../../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../../src/tui/bus.ts';
import { createFocusStack } from '../../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../../src/tui/modal-manager.ts';

const baseCaps = {
  tools: 'native',
  cache: false,
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 1000,
  output_max_tokens: 4096,
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
  notes: [],
} as Provider['capabilities'];

// Provider whose generate() returns a summary, or throws (to exercise
// compactMessages' deterministic fallback — it catches, never rethrows).
const makeProvider = (reply: string | Error): Provider => ({
  id: 'test/c',
  family: 'anthropic',
  capabilities: baseCaps,
  async *generate(): AsyncGenerator<StreamEvent> {
    if (reply instanceof Error) throw reply;
    yield { kind: 'start', message_id: 'm' };
    yield { kind: 'text_delta', text: reply };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const noUsage: AssistantUsage = {
  usageSeen: false,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheCreation: 0,
  costUsd: 0,
};

let db: DB;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

// A live context with 11 messages (goal + 5 tool turns) — enough for
// compactMessages to fold (not skip).
const buildLiveCtx = (): SessionContext => {
  const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  const ctx = SessionContext.createFresh(db, sessionId);
  ctx.appendUser('Original goal', null);
  for (let i = 0; i < 5; i++) {
    ctx.appendAssistant(
      [
        { type: 'text', text: `step ${i}` },
        { type: 'tool_use', id: `t${i}`, name: 'r', input: {} },
      ],
      noUsage,
      null,
    );
    ctx.appendToolResults(
      [{ type: 'tool_result', tool_use_id: `t${i}`, name: 'r', content: 'x'.repeat(40) }],
      null,
    );
  }
  return ctx;
};

const makeCtx = (opts: {
  provider: Provider;
  live: SessionContext | null;
  running?: boolean;
}): SlashContext => {
  const bus = createBus();
  const modalManager = createModalManager({ bus, focusStack: createFocusStack(), now: () => 1 });
  const baseConfig = {
    cwd: '/p',
    // preserveTail pinned small so an 11-message history folds.
    budget: { ...DEFAULT_BUDGET, compactionPreserveTail: 2 },
    provider: opts.provider,
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now: () => 1,
    requestShutdown: () => {},
    isRunning: () => opts.running ?? false,
    currentSessionId: () => null,
    replSessionIds: () => [],
    modelRegistry: createModelRegistry(),
    liveContext: () => opts.live,
  };
};

describe('/compact', () => {
  test('refuses while a turn is running, without mutating the context', async () => {
    const ctx = buildLiveCtx();
    const before = ctx.length;
    const r = await compactCommand.exec(
      [],
      makeCtx({ provider: makeProvider('GOAL: x'), live: ctx, running: true }),
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('running');
    expect(ctx.length).toBe(before); // gate fired before any mutation
  });

  test('errors when there is no live session yet', async () => {
    const r = await compactCommand.exec(
      [],
      makeCtx({ provider: makeProvider('GOAL: x'), live: null }),
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('no live session');
  });

  test('shrinks the live context and preserves active pins', async () => {
    const ctx = buildLiveCtx();
    createContextPinsStore(db).createPin({
      sessionId: ctx.sessionId,
      text: 'API must stay stable',
      kind: 'constraint',
      createdBy: 'user',
    });
    const before = ctx.length;
    const r = await compactCommand.exec(
      [],
      makeCtx({ provider: makeProvider('GOAL: refactor\nDECISIONS: none'), live: ctx }),
    );
    expect(r.kind).toBe('ok');
    expect(ctx.length).toBeLessThan(before); // compacted
    // The pin is re-injected literally into the compacted goal (messages[0]).
    const goal = ctx.getMessages()[0];
    const goalText =
      typeof goal?.content === 'string' ? goal.content : JSON.stringify(goal?.content);
    expect(goalText).toContain('API must stay stable');
  });

  test('folds the summary call cost into the session row + the cumulative', async () => {
    const ctx = buildLiveCtx();
    // Provider that reports usage, with non-zero pricing so the summary
    // call actually costs something.
    const provider: Provider = {
      id: 'test/c',
      family: 'anthropic',
      capabilities: { ...baseCaps, cost_per_1k_input: 3, cost_per_1k_output: 15 },
      async *generate(): AsyncGenerator<StreamEvent> {
        yield { kind: 'start', message_id: 'm' };
        yield { kind: 'text_delta', text: 'GOAL: x\nDECISIONS: y' };
        yield {
          kind: 'usage',
          usage: { input: 1000, output: 100, cache_read: 0, cache_creation: 0 },
        };
        yield { kind: 'stop', reason: 'end_turn' };
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const slashCtx = makeCtx({ provider, live: ctx });
    const r = await compactCommand.exec([], slashCtx);
    expect(r.kind).toBe('ok');
    expect(slashCtx.cumulative.costUsd).toBeGreaterThan(0); // folded into cumulative
    expect(getSession(db, ctx.sessionId)?.totalCostUsd).toBeGreaterThan(0); // persisted
  });

  test('routes the compaction through runExclusive (the busy lock)', async () => {
    const ctx = buildLiveCtx();
    const before = ctx.length;
    let exclusiveCalled = false;
    const slashCtx = makeCtx({ provider: makeProvider('GOAL: x\nDECISIONS: y'), live: ctx });
    slashCtx.runExclusive = async (fn) => {
      exclusiveCalled = true;
      return fn();
    };
    const r = await compactCommand.exec([], slashCtx);
    expect(r.kind).toBe('ok');
    expect(exclusiveCalled).toBe(true); // compaction held the busy lock
    expect(ctx.length).toBeLessThan(before); // and ran inside it
  });

  test('brackets the compaction with compacting:start / compacting:end events', async () => {
    const live = buildLiveCtx();
    const slashCtx = makeCtx({ provider: makeProvider('GOAL: x\nDECISIONS: y'), live });
    const eventTypes: string[] = [];
    slashCtx.bus.onAny((e) => eventTypes.push(e.type));
    const r = await compactCommand.exec([], slashCtx);
    expect(r.kind).toBe('ok');
    // The live "Compacting context…" chip opens then closes around the summary call.
    expect(eventTypes).toContain('compacting:start');
    expect(eventTypes).toContain('compacting:end');
    expect(eventTypes.indexOf('compacting:start')).toBeLessThan(
      eventTypes.indexOf('compacting:end'),
    );
  });

  test('marks session usage incomplete when the summary call fails before reporting usage', async () => {
    const live = buildLiveCtx();
    // Provider throws mid-stream BEFORE emitting usage → compactMessages
    // falls back (strategy 'fallback', usageSeen false). The auto path flips
    // usageComplete here; /compact must too, or the spend stays a silent
    // lower bound on a session still marked usage-complete.
    const provider: Provider = {
      id: 'test/c',
      family: 'anthropic',
      capabilities: baseCaps,
      async *generate(): AsyncGenerator<StreamEvent> {
        yield { kind: 'start', message_id: 'm' };
        throw new Error('provider failed before usage');
      },
      generateConstrained: () => Promise.reject(new Error('n/a')),
      countTokens: () => Promise.resolve(0),
    };
    const r = await compactCommand.exec([], makeCtx({ provider, live }));
    expect(r.kind).toBe('ok'); // fallback keeps the run alive
    expect(getSession(db, live.sessionId)?.usageComplete).toBe(false);
  });
});
