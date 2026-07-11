import { insertCheckpoint } from '../../../src/storage/repos/checkpoints.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { padId, type RecapFixture } from './types.ts';

export const fixture: RecapFixture = {
  name: '02-write-refactor',
  description: 'refactor: read + edit + write + bun test passing + checkpoint',
  now: 200_000,
  seed: (db) => {
    const sessionId = padId('a2', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 100_000,
    });

    const userId = padId('a2', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'extract computeBackoff from src/queue.ts into its own pure module with tests',
      createdAt: 100_100,
    });

    const assistantId = padId('a2', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Extracting computeBackoff into src/queue/backoff.ts.' }],
      tokensIn: 4_200,
      tokensOut: 350,
      cachedTokens: 3_400,
      costUsd: 0.022,
      createdAt: 100_200,
    });

    const calls: {
      ordinal: number;
      tool: string;
      input: unknown;
      output: unknown;
      duration: number;
    }[] = [
      {
        ordinal: 1,
        tool: 'read_file',
        input: { path: '/home/lex/proj/src/queue.ts' },
        output: {
          content: '...',
          total_lines: 240,
          offset: 0,
          lines_returned: 240,
          truncated: false,
        },
        duration: 6,
      },
      {
        ordinal: 2,
        tool: 'edit_file',
        input: { path: '/home/lex/proj/src/queue.ts', edits: [] },
        output: {
          path: '/home/lex/proj/src/queue.ts',
          edits: [],
          total_replacements: 1,
          bytes_written: 4_812,
        },
        duration: 12,
      },
      {
        ordinal: 3,
        tool: 'write_file',
        input: { path: '/home/lex/proj/src/queue/backoff.ts', content: '...' },
        output: { path: '/home/lex/proj/src/queue/backoff.ts', bytes_written: 880, created: true },
        duration: 9,
      },
      {
        ordinal: 4,
        tool: 'write_file',
        input: { path: '/home/lex/proj/tests/queue/backoff.test.ts', content: '...' },
        output: {
          path: '/home/lex/proj/tests/queue/backoff.test.ts',
          bytes_written: 1_240,
          created: true,
        },
        duration: 10,
      },
      {
        ordinal: 5,
        tool: 'bash',
        input: { command: 'bun test tests/queue/backoff.test.ts' },
        output: { exit_code: 0, stdout: '5 pass\n0 fail', stderr: '' },
        duration: 1_540,
      },
    ];
    for (const c of calls) {
      const tcId = padId('a2', 300 + c.ordinal);
      createToolCall(db, {
        id: tcId,
        messageId: assistantId,
        toolName: c.tool,
        input: c.input,
        createdAt: 100_300 + c.ordinal,
      });
      finishToolCall(db, {
        id: tcId,
        status: 'done',
        output: c.output,
        durationMs: c.duration,
      });
    }

    insertCheckpoint(db, {
      id: padId('a2', 700),
      sessionId,
      stepId: assistantId,
      gitRef: 'deadbeef0000000000000000000000000000abcd',
      hadBash: true,
      createdAt: 100_400,
    });

    completeSession(db, sessionId, 'done', 0.022, true, 102_000);

    return { kind: 'session_specific', sessionId };
  },
};
