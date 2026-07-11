import { recordApproval } from '../../../src/storage/repos/approvals.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { padId, type RecapFixture } from './types.ts';

export const fixture: RecapFixture = {
  name: '03-with-decisions',
  description:
    'mixed approvals: user-confirmed bash, hook-blocked bash, policy auto-allow (filtered)',
  now: 250_000,
  seed: (db) => {
    const sessionId = padId('a3', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 200_000,
    });

    const userId = padId('a3', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'cleanup tmp dir and confirm with me before any bash',
      createdAt: 200_100,
    });

    const assistantId = padId('a3', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Will request confirmation per command.' }],
      tokensIn: 1_800,
      tokensOut: 110,
      cachedTokens: 1_400,
      costUsd: 0.005,
      createdAt: 200_200,
    });

    // Three bash calls with three different approval shapes.
    const calls: {
      ordinal: number;
      command: string;
      decision: 'allow' | 'deny' | 'allow';
      decidedBy: 'user' | 'hook' | 'policy';
      reason: string | null;
      callDuration: number;
    }[] = [
      {
        ordinal: 1,
        command: 'rm -rf /tmp/forja-staging',
        decision: 'allow',
        decidedBy: 'user',
        reason: 'cleanup is intentional',
        callDuration: 18,
      },
      {
        ordinal: 2,
        command: 'curl -X POST https://example.com/webhook',
        decision: 'deny',
        decidedBy: 'hook',
        reason: 'network egress blocked by policy',
        callDuration: 0,
      },
      {
        ordinal: 3,
        command: 'echo done',
        decision: 'allow',
        decidedBy: 'policy',
        reason: null,
        callDuration: 4,
      },
    ];

    for (const c of calls) {
      const tcId = padId('a3', 300 + c.ordinal);
      createToolCall(db, {
        id: tcId,
        messageId: assistantId,
        toolName: 'bash',
        input: { command: c.command },
        createdAt: 200_300 + c.ordinal,
      });
      const status = c.decision === 'deny' ? 'denied' : 'done';
      finishToolCall(db, {
        id: tcId,
        status,
        output: status === 'done' ? { exit_code: 0 } : undefined,
        durationMs: c.callDuration,
        error: status === 'denied' ? 'denied by hook' : null,
      });
      recordApproval(db, {
        id: padId('a3', 400 + c.ordinal),
        toolCallId: tcId,
        decision: c.decision,
        decidedBy: c.decidedBy,
        reason: c.reason,
        decidedAt: 200_310 + c.ordinal,
      });
    }

    completeSession(db, sessionId, 'done', 0.005, true, 201_000);

    return { kind: 'session_specific', sessionId };
  },
};
