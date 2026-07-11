// Range-scope fixture: 3 sessions across 3 consecutive UTC days,
// same cwd. Exercises the `/recap range <from> <to>` path with a
// half-open `[start, end)` window. The third session (May 4)
// stays outside the queried window so the projection should
// surface only sessions A/B/C, never D.

import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { padId, type RecapFixture } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAY_1_UTC = Date.UTC(2026, 4, 1, 0, 0, 0, 0);

export const fixture: RecapFixture = {
  name: '07-cross-day-range',
  description:
    '3 sessions across 3 days same cwd; /recap range 2026-05-01 2026-05-03 aggregates them; May 4 session excluded',
  now: MAY_1_UTC + 5 * DAY_MS,
  seed: (db) => {
    const days = [
      { ord: 1, startMs: MAY_1_UTC + 10 * 60 * 60 * 1000, prompt: 'day-1 task' },
      {
        ord: 2,
        startMs: MAY_1_UTC + DAY_MS + 11 * 60 * 60 * 1000,
        prompt: 'day-2 task',
      },
      {
        ord: 3,
        startMs: MAY_1_UTC + 2 * DAY_MS + 12 * 60 * 60 * 1000,
        prompt: 'day-3 task',
      },
      // Out-of-window: must NOT show up in the range projection.
      {
        ord: 4,
        startMs: MAY_1_UTC + 3 * DAY_MS + 13 * 60 * 60 * 1000,
        prompt: 'day-4 task (excluded)',
      },
    ];
    for (const d of days) {
      const sid = padId('a7', d.ord);
      createSession(db, {
        id: sid,
        model: 'sonnet-4-6',
        cwd: '/home/lex/proj',
        startedAt: d.startMs,
      });
      appendMessage(db, {
        id: padId('a7', 100 + d.ord),
        sessionId: sid,
        role: 'user',
        content: d.prompt,
        createdAt: d.startMs + 100,
      });
      appendMessage(db, {
        id: padId('a7', 200 + d.ord),
        sessionId: sid,
        parentId: padId('a7', 100 + d.ord),
        role: 'assistant',
        content: [{ type: 'text', text: `Done on day ${d.ord}.` }],
        tokensIn: 600,
        tokensOut: 30,
        cachedTokens: 400,
        costUsd: 0.0009,
        createdAt: d.startMs + 200,
      });
      completeSession(db, sid, 'done', 0.0009, true, d.startMs + 3_000);
    }

    // Range query: May 1 (inclusive) through May 3 (inclusive).
    // Slash builds end as toMs + 24h to make the operator's
    // "inclusive last day" intent map to a half-open SQL window.
    return {
      kind: 'range',
      cwd: '/home/lex/proj',
      start: MAY_1_UTC,
      end: MAY_1_UTC + 3 * DAY_MS, // exclusive: through May 3 23:59:59.999
    };
  },
};
