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

describe('SessionContext: popLastUserMessage (un-send after hard abort)', () => {
  test('drops a trailing operator message from the live array but KEEPS the DB row + anchor', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendAssistant(textBlock('hi'), noUsage, null); // prior turn
    const sentId = ctx.appendUser('oops, typo', null);
    expect(ctx.length).toBe(2);

    expect(ctx.popLastUserMessage()).toBe(true);
    // Live array dropped it (provider won't see it next turn)...
    expect(ctx.length).toBe(1);
    expect(ctx.getMessages()[0]).toEqual({ role: 'assistant', content: textBlock('hi') });
    // ...but the append-only log keeps the sent row, and the anchor stays so
    // the next turn's audit chain faithfully records it followed the message.
    expect(getMessage(db, sentId)).not.toBeNull();
    expect(getMessage(db, sentId)?.retractedAt).not.toBeNull(); // marked retracted (durable)
    expect(ctx.getLastMessageId()).toBe(sentId);
  });

  test('a retracted message is dropped from the rehydrated model context (durable un-send)', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendAssistant(textBlock('answer'), noUsage, null);
    const sentId = ctx.appendUser('cancelled prompt', null);
    ctx.popLastUserMessage();
    // Resume in a fresh context from the SAME log: the retracted turn is skipped
    // from the model-facing rebuild, but its row is still logged (retracted).
    const { ctx: resumed } = SessionContext.hydrateFromDb(db, sessionId);
    expect(resumed.getMessages().some((m) => m.content === 'cancelled prompt')).toBe(false);
    expect(getMessage(db, sentId)?.retractedAt).not.toBeNull();
  });

  test('refuses when the tail is an assistant turn', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    ctx.appendAssistant(textBlock('answer'), noUsage, null);
    expect(ctx.popLastUserMessage()).toBe(false);
    expect(ctx.length).toBe(2);
  });

  test('refuses when the tail is a tool_result user turn (array content)', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    ctx.appendAssistant(textBlock('call'), noUsage, null);
    ctx.appendToolResults([{ type: 'tool_result', tool_use_id: 't1', content: 'r' }], null);
    expect(ctx.popLastUserMessage()).toBe(false);
    expect(ctx.length).toBe(3);
  });

  test('refuses on an empty context', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    expect(ctx.popLastUserMessage()).toBe(false);
  });

  test('refuses when an (empty) assistant turn settled after the operator message', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    const userId = ctx.appendUser('did something settle?', null);
    // Empty assistant turn (content.length === 0): advances lastMessageId but is
    // NOT mirrored into the live array, so the in-memory tail is still the user.
    ctx.appendAssistant([], noUsage, null);
    expect(ctx.length).toBe(1); // empty assistant not pushed → tail is still user
    // Something settled after the message → keep it; never retract the wrong row.
    expect(ctx.popLastUserMessage()).toBe(false);
    expect(getMessage(db, userId)?.retractedAt).toBeNull();
  });

  test('refuses a system/wake user turn — only the operator submit is un-sendable', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    const id = ctx.appendUser('bg_done: background task finished', null, 'system');
    // A system/wake row is a string-user tail too, but it is not the operator's
    // submit — the guard reads source so it can't be un-sent.
    expect(ctx.popLastUserMessage()).toBe(false);
    expect(getMessage(db, id)?.retractedAt).toBeNull();
    expect(ctx.length).toBe(1); // still live
  });
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

  test('queryHint (working-state focus) steers relevance over the recency pick', () => {
    // Goal has NO term overlap with any body → relevance is uniform-0 and recency
    // alone keeps the LATEST eligible body. A focus hint matching an EARLIER body
    // should promote it over that recency pick — proving the current focus, not
    // just the original goal, drives the partition (#2).
    const build = (): SessionContext => {
      const c = SessionContext.createFresh(db, sessionId);
      c.appendUser('unrelated original goal phrasing', null);
      c.appendAssistant(toolUse('a'), noUsage, null);
      c.appendToolResults(toolResult('a', big('migration schema database indexes')), null);
      c.appendAssistant(toolUse('b'), noUsage, null);
      c.appendToolResults(toolResult('b', big('totally different latest filler text')), null);
      c.appendAssistant(toolUse('c'), noUsage, null);
      c.appendToolResults(toolResult('c', 'short tail body'), null);
      return c;
    };
    const opts = { verbatimBudgetBytes: 800, preserveTail: 1 };
    const withoutHint = build().relevanceElide(opts);
    const withHint = build().relevanceElide({ ...opts, queryHint: 'migration schema database' });
    // Without the hint, earlier 'a' loses to recency and is elided.
    expect(withoutHint?.elidedIds).toContain('a');
    // With the focus hint matching 'a', it is promoted and kept; 'b' goes instead.
    expect(withHint?.elidedIds).not.toContain('a');
    expect(withHint?.elidedIds).toContain('b');
  });

  test('returns null when history is too short to have a middle', () => {
    const ctx = SessionContext.createFresh(db, sessionId);
    ctx.appendUser('goal', null);
    ctx.appendAssistant(textBlock('ok'), noUsage, null);
    expect(ctx.relevanceElide({ verbatimBudgetBytes: 0, preserveTail: 3 })).toBeNull();
  });
});
