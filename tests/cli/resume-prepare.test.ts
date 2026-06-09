import { describe, expect, test } from 'bun:test';
import { prepareResumeContext } from '../../src/cli/resume-prepare.ts';
import { effectiveBudget } from '../../src/harness/types.ts';
import type { Provider } from '../../src/providers/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession, updateSessionCost } from '../../src/storage/repos/sessions.ts';

// A provider whose generate() throws if ever reached — proves the boot summary
// compaction did NOT make a billed call.
const throwingProvider = (): Provider => ({
  id: 'mock/m',
  family: 'anthropic',
  capabilities: {
    tools: 'native',
    cache: false,
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 1000,
    output_max_tokens: 100,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  },
  // biome-ignore lint/correctness/useYield: throws before any yield on purpose — the test asserts generate() is never reached.
  async *generate() {
    throw new Error('provider must not be called when at the cost cap');
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const seedSession = (cost: number) => {
  const db = openMemoryDb();
  migrate(db);
  createSession(db, { id: 's', model: 'mock/m', cwd: '/proj' });
  appendMessage(db, { sessionId: 's', role: 'user', content: 'goal', createdAt: 1 });
  appendMessage(db, {
    sessionId: 's',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    createdAt: 2,
  });
  if (cost > 0) updateSessionCost(db, 's', cost);
  return db;
};

describe('prepareResumeContext — cost cap', () => {
  test('summary skips the boot compaction when session cost is already at/over maxCostUsd', async () => {
    const db = seedSession(5); // persisted cost well over the cap
    const res = await prepareResumeContext({
      db,
      sessionId: 's',
      mode: 'summary',
      provider: throwingProvider(), // would throw if compaction billed a call
      budget: effectiveBudget({ maxCostUsd: 1 }),
      memoryRegistryPresent: false,
      now: () => 0,
    });
    expect(res.costCapped).toBe(true);
    // No compaction attempted → no billed call, context left full.
    expect(res.compaction).toBeUndefined();
    expect(res.ctx.getMessages().length).toBeGreaterThan(0);
  });

  test('summary proceeds to compaction when session cost is under the cap', async () => {
    const db = seedSession(0);
    const res = await prepareResumeContext({
      db,
      sessionId: 's',
      mode: 'summary',
      provider: throwingProvider(),
      budget: effectiveBudget({ maxCostUsd: 1 }),
      memoryRegistryPresent: false,
      now: () => 0,
    });
    // Not capped → it attempted compaction. The 2-msg session is too short to
    // fold, so compactMessages returns 'skipped' WITHOUT a provider call (the
    // throwingProvider never fires) — proving the gate let it through.
    expect(res.costCapped).toBeUndefined();
    expect(res.compaction?.kind).toBe('noop');
  });

  test('no cost cap configured → never capped', async () => {
    const db = seedSession(999);
    const res = await prepareResumeContext({
      db,
      sessionId: 's',
      mode: 'summary',
      provider: throwingProvider(),
      // Explicit undefined → no cap (DEFAULT_BUDGET.maxCostUsd is 100, so {}
      // alone would NOT mean "no cap"). The operator opt-out per types.ts.
      budget: effectiveBudget({ maxCostUsd: undefined }),
      memoryRegistryPresent: false,
      now: () => 0,
    });
    expect(res.costCapped).toBeUndefined();
  });
});
