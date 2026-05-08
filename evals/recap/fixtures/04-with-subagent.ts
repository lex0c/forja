import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import {
  insertSubagentOutput,
  setSubagentPayload,
} from '../../../src/storage/repos/subagent-outputs.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { type RecapFixture, padId } from './types.ts';

export const fixture: RecapFixture = {
  name: '04-with-subagent',
  description: 'parent + 1 subagent child with terminal payload summary',
  now: 350_000,
  seed: (db) => {
    const parentId = padId('a4', 1);
    createSession(db, {
      id: parentId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 300_000,
    });

    const userId = padId('a4', 100);
    appendMessage(db, {
      id: userId,
      sessionId: parentId,
      role: 'user',
      content: 'analyze the queue retry tests for flakiness using a subagent',
      createdAt: 300_100,
    });

    const assistantId = padId('a4', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId: parentId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Spawning explore subagent.' }],
      tokensIn: 2_000,
      tokensOut: 90,
      cachedTokens: 1_600,
      costUsd: 0.008,
      createdAt: 300_200,
    });

    const taskTcId = padId('a4', 300);
    createToolCall(db, {
      id: taskTcId,
      messageId: assistantId,
      toolName: 'task',
      input: { subagent: 'explore', prompt: 'analyze tests/queue for flakiness' },
      createdAt: 300_300,
    });
    finishToolCall(db, {
      id: taskTcId,
      status: 'done',
      output: { session_id: padId('a4', 2), status: 'done' },
      durationMs: 4_200,
    });

    const childId = padId('a4', 2);
    createSession(db, {
      id: childId,
      model: 'haiku-4-5',
      cwd: '/home/lex/proj',
      startedAt: 300_400,
      parentSessionId: parentId,
    });
    insertSubagentOutput(db, {
      sessionId: childId,
      createdAt: 300_400,
    });
    setSubagentPayload(
      db,
      childId,
      {
        status: 'done',
        summary: 'no flake patterns in tests/queue/backoff.test.ts; 5/5 pass',
      },
      304_500,
    );
    completeSession(db, childId, 'done', 0.001, true, 304_500);

    completeSession(db, parentId, 'done', 0.009, true, 305_000);

    return { kind: 'session_specific', sessionId: parentId };
  },
};
