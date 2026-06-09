import { beforeEach, describe, expect, test } from 'bun:test';
import { type AssistantUsage, SessionContext } from '../../src/harness/session-context.ts';
import type { Provider, ProviderContentBlock, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getMessage, listMessagesBySession } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const baseCaps: Provider['capabilities'] = {
  tools: 'native',
  cache: false,
  vision: false,
  streaming: true,
  constrained: 'tools',
  context_window: 200_000,
  output_max_tokens: 4096,
  cost_per_1k_input: 0,
  cost_per_1k_output: 0,
  notes: [],
};

// Minimal provider whose generate() returns a fixed summary text — used
// only to drive ctx.compact() down the 'llm' strategy.
const summaryProvider = (text: string): Provider => ({
  id: 'mock/sc',
  family: 'anthropic',
  capabilities: baseCaps,
  async *generate(): AsyncGenerator<StreamEvent> {
    yield { kind: 'start', message_id: 'm' };
    yield { kind: 'text_delta', text };
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

const textBlock = (t: string): ProviderContentBlock[] => [{ type: 'text', text: t }];

let db: DB;
let sessionId: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('SessionContext: append (array + row + anchor in one place)', () => {
  test('createFresh starts empty with no anchor', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    expect(ctx.length).toBe(0);
    expect(ctx.getLastMessageId()).toBe('');
    expect(listMessagesBySession(db, sessionId)).toHaveLength(0);
  });

  test('appendUser writes one row (root parent), pushes one message, advances anchor', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    const id = ctx.appendUser('goal', null);
    expect(ctx.length).toBe(1);
    expect(ctx.getLastMessageId()).toBe(id);
    expect(ctx.getMessages()[0]).toEqual({ role: 'user', content: 'goal' });
    const rows = listMessagesBySession(db, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parentId).toBeNull(); // fresh → root
  });

  test('appendAssistant records the resolved effort (default null)', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    const withEffort = ctx.appendAssistant(textBlock('ok'), noUsage, null, 'high');
    expect(getMessage(db, withEffort)?.effort).toBe('high');
    // Default arg keeps existing call sites (and user/tool rows) at null.
    const noEffort = ctx.appendAssistant(textBlock('ok2'), noUsage, null);
    expect(getMessage(db, noEffort)?.effort).toBeNull();
  });

  test('chain: assistant.parentId points at the prior user row', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    const uId = ctx.appendUser('goal', null);
    const aId = ctx.appendAssistant(textBlock('ok'), noUsage, null);
    expect(getMessage(db, aId)?.parentId).toBe(uId);
    // tool_results then chain off the assistant
    const tId = ctx.appendToolResults(
      [{ type: 'tool_result', tool_use_id: 'x', name: 'read', content: 'r' }],
      null,
    );
    expect(getMessage(db, tId)?.parentId).toBe(aId);
    expect(ctx.length).toBe(3);
  });

  test('empty assistant content persists a row but is NOT mirrored in the array', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    const aId = ctx.appendAssistant([], noUsage, null);
    expect(ctx.length).toBe(1); // user only — empty assistant not pushed
    const row = getMessage(db, aId);
    expect(row).not.toBeNull();
    expect(row?.content).toBe(''); // persisted as empty string
  });

  test('usageSeen=false persists NULL token columns; true persists the values', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    const nullId = ctx.appendAssistant(textBlock('a'), noUsage, null);
    expect(getMessage(db, nullId)?.tokensIn).toBeNull();
    expect(getMessage(db, nullId)?.costUsd).toBeNull();
    const seenId = ctx.appendAssistant(
      textBlock('b'),
      { usageSeen: true, tokensIn: 10, tokensOut: 5, cacheRead: 2, cacheCreation: 1, costUsd: 0.5 },
      null,
    );
    const row = getMessage(db, seenId);
    expect(row?.tokensIn).toBe(10);
    expect(row?.cachedTokens).toBe(2);
    expect(row?.costUsd).toBe(0.5);
  });

  test('promptHash threads through to the row', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    const id = ctx.appendUser('goal', 'deadbeef');
    expect(getMessage(db, id)?.promptHash).toBe('deadbeef');
  });
});

describe('SessionContext: hydrateFromDb', () => {
  test('reproduces the persisted messages, anchor at the tail, kept count', () => {
    const seed = SessionContext.createFresh(db, sessionId);
    seed.appendUser('goal', null);
    const aId = seed.appendAssistant(textBlock('ok'), noUsage, null);

    const { ctx, info } = SessionContext.hydrateFromDb(db, sessionId);
    expect(ctx.getMessages()).toEqual([
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
    expect(ctx.getLastMessageId()).toBe(aId); // anchor = persisted tail
    expect(info.kept).toBe(2);
    expect(info.totalDropped).toBe(0);
  });

  test('uncapped option loads all rows and reports totalCount', () => {
    const seed = SessionContext.createFresh(db, sessionId);
    seed.appendUser('goal', null);
    seed.appendAssistant(textBlock('a1'), noUsage, null);
    seed.appendUser('q2', null);
    seed.appendAssistant(textBlock('a2'), noUsage, null);

    const { ctx, info } = SessionContext.hydrateFromDb(db, sessionId, { uncapped: true });
    expect(ctx.getMessages()).toHaveLength(4);
    expect(info.kept).toBe(4);
    expect(info.totalCount).toBe(4);
  });

  test('capped (default) populates totalCount for the warn threshold', () => {
    const seed = SessionContext.createFresh(db, sessionId);
    seed.appendUser('goal', null);
    seed.appendAssistant(textBlock('ok'), noUsage, null);
    const { info } = SessionContext.hydrateFromDb(db, sessionId);
    expect(info.totalCount).toBe(2);
  });

  test('a turn appended onto a hydrated context chains off the persisted tail', () => {
    const seed = SessionContext.createFresh(db, sessionId);
    seed.appendUser('goal', null);
    const aId = seed.appendAssistant(textBlock('ok'), noUsage, null);

    const { ctx } = SessionContext.hydrateFromDb(db, sessionId);
    const uId = ctx.appendUser('follow-up', null);
    expect(getMessage(db, uId)?.parentId).toBe(aId); // continues the DB chain
  });
});

describe('SessionContext: ensureAlternation', () => {
  test('inserts a synthetic assistant when tail is user and a user prompt follows', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    ctx.ensureAlternation(true);
    expect(ctx.length).toBe(2);
    expect(ctx.getMessages()[1]?.role).toBe('assistant');
    // the synthetic placeholder is NOT persisted
    expect(listMessagesBySession(db, sessionId)).toHaveLength(1);
  });

  test('no-op when the tail is already an assistant', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    ctx.appendAssistant(textBlock('ok'), noUsage, null);
    ctx.ensureAlternation(true);
    expect(ctx.length).toBe(2);
  });

  test('repairs an orphaned tool_use left by an abort (reuse-after-abort)', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    // Aborted mid-tool: the assistant emitted a tool_use but tool_results
    // never landed, so the live array's tail is an unanswered tool_use.
    ctx.appendAssistant([{ type: 'tool_use', id: 'tu1', name: 'read', input: {} }], noUsage, null);
    ctx.ensureAlternation(true); // next turn would append a user prompt
    // Orphan answered (synthetic tool_result for tu1) so the next provider
    // request won't 400 on an unanswered tool_use — the reuse-path fix.
    const answered = ctx
      .getMessages()
      .some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tu1'),
      );
    expect(answered).toBe(true);
  });

  test('repairs a partially-answered multi-tool_use turn (length unchanged)', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    // Assistant emits TWO tool_use; the next user answers only tu1, leaving
    // tu2 orphaned. repairAlternation rewrites that user message IN PLACE
    // (synthetic tu2 result spliced in), so the array length does NOT change
    // — the exact case the old length-only guard skipped, re-sending tu2
    // unanswered on the next reused turn.
    ctx.appendAssistant(
      [
        { type: 'tool_use', id: 'tu1', name: 'read', input: {} },
        { type: 'tool_use', id: 'tu2', name: 'grep', input: {} },
      ],
      noUsage,
      null,
    );
    ctx.appendToolResults(
      [{ type: 'tool_result', tool_use_id: 'tu1', name: 'read', content: 'ok', is_error: false }],
      null,
    );
    const lenBefore = ctx.length;
    ctx.ensureAlternation(false);
    expect(ctx.length).toBe(lenBefore); // repaired in place, same length
    const answered = (id: string): boolean =>
      ctx
        .getMessages()
        .some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === id),
        );
    expect(answered('tu1')).toBe(true);
    expect(answered('tu2')).toBe(true); // the orphan — answered only with the fix
  });
});

describe('SessionContext: compact (in-memory only, never persists)', () => {
  test('shrinks the live array but leaves the DB log untouched', async () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('Original goal', null);
    for (let i = 0; i < 6; i++) {
      ctx.appendAssistant(
        [
          { type: 'text', text: `step ${i}` },
          { type: 'tool_use', id: `tu${i}`, name: 'read', input: {} },
        ],
        noUsage,
        null,
      );
      ctx.appendToolResults(
        [{ type: 'tool_result', tool_use_id: `tu${i}`, name: 'read', content: 'x'.repeat(40) }],
        null,
      );
    }
    const rowsBefore = listMessagesBySession(db, sessionId).length;
    const lenBefore = ctx.length;
    expect(rowsBefore).toBe(13); // 1 + 6*2

    const result = await ctx.compact(summaryProvider('GOAL: x\nDECISIONS: y'), { preserveTail: 2 });
    expect(result.strategy).toBe('llm');
    expect(ctx.length).toBeLessThan(lenBefore); // compacted
    expect(listMessagesBySession(db, sessionId)).toHaveLength(rowsBefore); // log untouched
  });
});

describe('SessionContext: snapshot / restore', () => {
  test('restore rolls the live array + anchor back to the snapshot', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    const anchorAtSnap = ctx.getLastMessageId();
    const snap = ctx.snapshot();

    ctx.appendAssistant(textBlock('mutation'), noUsage, null);
    expect(ctx.length).toBe(2);

    ctx.restore(snap);
    expect(ctx.length).toBe(1);
    expect(ctx.getLastMessageId()).toBe(anchorAtSnap);
    expect(ctx.getMessages()[0]).toEqual({ role: 'user', content: 'goal' });
  });
});

describe('SessionContext: relevanceElide', () => {
  const toolUse = (id: string): ProviderContentBlock[] => [
    { type: 'tool_use', id, name: 'read_file', input: {} },
  ];
  const toolResult = (id: string, content: string): ProviderContentBlock[] => [
    { type: 'tool_result', tool_use_id: id, name: 'read_file', content },
  ];
  const big = (s: string): string => `${s} `.repeat(20); // ~740B → over the min-elide floor

  // [goal, (assistant tool_use, user tool_result) × turns] with big,
  // goal-irrelevant bodies so the budget — not relevance — drives elision.
  const seed = (turns: number): SessionContext => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('refactor the auth token validation', null);
    for (let i = 0; i < turns; i++) {
      ctx.appendAssistant(toolUse(`t${i}`), noUsage, null);
      ctx.appendToolResults(toolResult(`t${i}`, big('lorem ipsum filler content unrelated')), null);
    }
    return ctx;
  };
  const trContent = (m: { content: string | ProviderContentBlock[] } | undefined): string => {
    if (m === undefined || typeof m.content === 'string') throw new Error('expected blocks');
    const b = m.content[0];
    if (b === undefined || b.type !== 'tool_result') throw new Error('expected tool_result block');
    return b.content;
  };

  test('elides middle bodies while preserving goal + tail verbatim and message count', () => {
    const ctx = seed(6); // 13 messages
    const before = ctx.length;
    const res = ctx.relevanceElide({ verbatimBudgetBytes: 800, preserveTail: 3 });
    expect(res).not.toBeNull();
    expect(res?.elidedCount).toBeGreaterThan(0);
    expect(res?.elidedIds.length).toBe(res?.elidedCount);
    const msgs = ctx.getMessages();
    expect(msgs.length).toBe(before); // structure intact — only bodies shrank
    expect(msgs[0]).toEqual({ role: 'user', content: 'refactor the auth token validation' });
    // The most recent tool_result sits in the preserved tail → verbatim.
    expect(trContent(msgs[msgs.length - 1])).toBe(big('lorem ipsum filler content unrelated'));
    const anyPointer = msgs.some(
      (m) =>
        typeof m.content !== 'string' &&
        m.content.some(
          (b) => b.type === 'tool_result' && b.content.startsWith('[tool_result elided:'),
        ),
    );
    expect(anyPointer).toBe(true);
  });

  test('returns null when history is too short to have a middle', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    ctx.appendAssistant(textBlock('ok'), noUsage, null);
    expect(ctx.relevanceElide({ verbatimBudgetBytes: 0, preserveTail: 3 })).toBeNull();
  });
});
