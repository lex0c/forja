import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { padId, type RecapFixture } from './types.ts';

export const fixture: RecapFixture = {
  name: '01-read-only',
  description: 'read-only exploration: 1 user prompt, 4 read_file calls, no writes',
  now: 50_000,
  seed: (db) => {
    const sessionId = padId('a1', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 10_000,
    });

    const userId = padId('a1', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'explore src/queue and tell me what files are involved',
      createdAt: 10_100,
    });

    const assistantId = padId('a1', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'I will read the queue files now.' }],
      tokensIn: 1_500,
      tokensOut: 80,
      cachedTokens: 1_200,
      costUsd: 0.0035,
      createdAt: 10_200,
    });

    const reads: { ordinal: number; path: string }[] = [
      { ordinal: 1, path: '/home/lex/proj/src/queue.ts' },
      { ordinal: 2, path: '/home/lex/proj/src/queue.ts' },
      { ordinal: 3, path: '/home/lex/proj/src/queue/backoff.ts' },
      { ordinal: 4, path: '/home/lex/proj/src/queue/types.ts' },
    ];
    for (const r of reads) {
      const tcId = padId('a1', 300 + r.ordinal);
      createToolCall(db, {
        id: tcId,
        messageId: assistantId,
        toolName: 'read_file',
        input: { path: r.path },
        createdAt: 10_300 + r.ordinal,
      });
      finishToolCall(db, {
        id: tcId,
        status: 'done',
        output: {
          content: '...',
          total_lines: 10,
          offset: 0,
          lines_returned: 10,
          truncated: false,
        },
        durationMs: 4,
      });
    }

    completeSession(db, sessionId, 'done', 0.0035, true, 11_000);

    return { kind: 'session_specific', sessionId };
  },
};
