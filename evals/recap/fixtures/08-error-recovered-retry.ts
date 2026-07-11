import { appendFailureEvent } from '../../../src/storage/repos/failure-events.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { padId, type RecapFixture } from './types.ts';

// A refactor that hit a provider rate limit mid-session, recovered
// by retrying, and finished cleanly. Exercises errors[] with a
// single recovered (retried_Nx) failure carrying a payload message
// → the human "## Issues" section + the changelog/pr recovered-note
// curation.
export const fixture: RecapFixture = {
  name: '08-error-recovered-retry',
  description: 'provider rate limit recovered via retry; session completes',
  now: 800_000,
  seed: (db) => {
    const sessionId = padId('a8', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 700_000,
    });

    const userId = padId('a8', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'tighten the retry backoff in src/queue.ts',
      createdAt: 700_100,
    });

    const assistantId = padId('a8', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Adjusting the backoff curve in src/queue.ts.' }],
      tokensIn: 3_900,
      tokensOut: 280,
      cachedTokens: 3_100,
      costUsd: 0.018,
      createdAt: 700_200,
    });

    const editId = padId('a8', 301);
    createToolCall(db, {
      id: editId,
      messageId: assistantId,
      toolName: 'edit_file',
      input: { path: '/home/lex/proj/src/queue.ts', edits: [] },
      createdAt: 700_301,
    });
    finishToolCall(db, {
      id: editId,
      status: 'done',
      output: { path: '/home/lex/proj/src/queue.ts', total_replacements: 1, bytes_written: 4_120 },
      durationMs: 11,
    });

    const testId = padId('a8', 302);
    createToolCall(db, {
      id: testId,
      messageId: assistantId,
      toolName: 'bash',
      input: { command: 'bun test tests/queue/' },
      createdAt: 700_302,
    });
    finishToolCall(db, {
      id: testId,
      status: 'done',
      output: { exit_code: 0, stdout: '8 pass\n0 fail', stderr: '' },
      durationMs: 1_320,
    });

    // The recovered failure: a provider rate limit the operator saw
    // (a visible pause), retried, and got past.
    appendFailureEvent(db, {
      id: padId('a8', 400),
      session_id: sessionId,
      step_id: assistantId,
      code: 'provider.rate_limit',
      classe: 'provider',
      recovery_action: 'retried_2x',
      user_visible: 1,
      payload_json: JSON.stringify({ message: 'upstream 429; backed off and retried twice' }),
      created_at: 700_250,
      prev_chain_hash: 'genesis',
      this_chain_hash: 'a8-fail-1',
    });

    completeSession(db, sessionId, 'done', 0.018, true, 701_500);

    return { kind: 'session_specific', sessionId };
  },
};
