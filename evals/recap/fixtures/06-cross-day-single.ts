// Cross-day scope=day fixture: two sessions on the same UTC day,
// same cwd. Exercises the multi-session aggregation pipeline that
// `/recap day` triggers — previous fixtures all returned a
// session-scoped projection. Anchored to 2026-05-01 UTC so the
// goldens are stable regardless of host timezone.

import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { type RecapFixture, padId } from './types.ts';

const MAY_1_UTC = Date.UTC(2026, 4, 1, 0, 0, 0, 0);

export const fixture: RecapFixture = {
  name: '06-cross-day-single',
  description:
    'two same-cwd same-day sessions; /recap day 2026-05-01 aggregates both into one intermediate',
  // `now` past end of day so the projection sees both sessions as
  // terminal; durationMs comes from endedAt - startedAt.
  now: MAY_1_UTC + 24 * 60 * 60 * 1000,
  seed: (db) => {
    // Session A: morning, 1 user prompt + 1 assistant ack.
    const sidA = padId('a6', 1);
    const morning = MAY_1_UTC + 9 * 60 * 60 * 1000;
    createSession(db, {
      id: sidA,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: morning,
    });
    appendMessage(db, {
      id: padId('a6', 100),
      sessionId: sidA,
      role: 'user',
      content: 'morning task: review changes',
      createdAt: morning + 100,
    });
    appendMessage(db, {
      id: padId('a6', 200),
      sessionId: sidA,
      parentId: padId('a6', 100),
      role: 'assistant',
      content: [{ type: 'text', text: 'Review noted.' }],
      tokensIn: 800,
      tokensOut: 50,
      cachedTokens: 600,
      costUsd: 0.0018,
      createdAt: morning + 200,
    });
    completeSession(db, sidA, 'done', 0.0018, true, morning + 5_000);

    // Session B: afternoon, 1 user prompt + 1 assistant ack.
    const sidB = padId('a6', 2);
    const afternoon = MAY_1_UTC + 15 * 60 * 60 * 1000;
    createSession(db, {
      id: sidB,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: afternoon,
    });
    appendMessage(db, {
      id: padId('a6', 300),
      sessionId: sidB,
      role: 'user',
      content: 'afternoon task: bump version',
      createdAt: afternoon + 100,
    });
    appendMessage(db, {
      id: padId('a6', 400),
      sessionId: sidB,
      parentId: padId('a6', 300),
      role: 'assistant',
      content: [{ type: 'text', text: 'Version bumped.' }],
      tokensIn: 700,
      tokensOut: 40,
      cachedTokens: 500,
      costUsd: 0.0014,
      createdAt: afternoon + 200,
    });
    completeSession(db, sidB, 'done', 0.0014, true, afternoon + 4_000);

    return { kind: 'day', cwd: '/home/lex/proj', date: '2026-05-01' };
  },
};
