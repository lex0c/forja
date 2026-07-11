import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { padId, type RecapFixture } from './types.ts';

export const fixture: RecapFixture = {
  name: '05-incomplete-session',
  description:
    'session left in running state — exercises the incomplete callout + open question extraction',
  now: 400_000,
  seed: (db) => {
    const sessionId = padId('a5', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 380_000,
    });

    const userId = padId('a5', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'apply the database migration but check with me before touching prod',
      createdAt: 380_100,
    });

    const assistantId = padId('a5', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I ran the migration locally and it succeeded. Should we proceed with the production rollout now, or wait for the change-window?',
        },
      ],
      tokensIn: 3_400,
      tokensOut: 180,
      cachedTokens: 2_700,
      costUsd: 0.012,
      createdAt: 380_200,
    });

    const tcId = padId('a5', 300);
    createToolCall(db, {
      id: tcId,
      messageId: assistantId,
      toolName: 'bash',
      input: { command: 'bun run migrate:dry-run' },
      createdAt: 380_300,
    });
    finishToolCall(db, {
      id: tcId,
      status: 'done',
      output: { exit_code: 0, stdout: 'OK' },
      durationMs: 220,
    });

    // Deliberately omit completeSession — the session stays
    // 'running', which is the state RECAP.md §3 calls
    // `incomplete: true`.
    return { kind: 'session_specific', sessionId };
  },
};
