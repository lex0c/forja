import { appendFailureEvent } from '../../../src/storage/repos/failure-events.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { type RecapFixture, padId } from './types.ts';

// A session that recovered one failure but then hit a fatal one and
// ended in `error`. Exercises both `recovered` states in errors[]
// (the human "## Issues" section shows a recovered AND an
// unrecovered tag) and confirms the changelog/pr curation drops the
// fatal one (recovered-only). Terminal `error` status is distinct
// from the failure signal — both are present here on purpose.
export const fixture: RecapFixture = {
  name: '10-error-fatal-mixed',
  description: 'one recovered failure, then a fatal one; session ends in error',
  now: 1_000_000,
  seed: (db) => {
    const sessionId = padId('b1', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 900_000,
    });

    const userId = padId('b1', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'run the migration against staging',
      createdAt: 900_100,
    });

    const assistantId = padId('b1', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Applying the migration to staging.' }],
      tokensIn: 2_800,
      tokensOut: 150,
      cachedTokens: 2_200,
      costUsd: 0.011,
      createdAt: 900_200,
    });

    const bashId = padId('b1', 301);
    createToolCall(db, {
      id: bashId,
      messageId: assistantId,
      toolName: 'bash',
      input: { command: 'bun run migrate:staging' },
      createdAt: 900_301,
    });
    finishToolCall(db, {
      id: bashId,
      status: 'error',
      output: { exit_code: 1, stdout: '', stderr: 'connection reset' },
      durationMs: 4_200,
      error: 'migration failed',
    });

    // Recovered failure: a transient connection reset, retried once.
    appendFailureEvent(db, {
      id: padId('b1', 400),
      session_id: sessionId,
      step_id: assistantId,
      code: 'storage.connection_reset',
      classe: 'storage',
      recovery_action: 'retried_1x',
      user_visible: 1,
      payload_json: JSON.stringify({ message: 'staging db dropped the connection; retried once' }),
      created_at: 900_240,
      prev_chain_hash: 'genesis',
      this_chain_hash: 'b1-fail-1',
    });

    // Fatal failure: the retry also failed, the agent gave up.
    appendFailureEvent(db, {
      id: padId('b1', 401),
      session_id: sessionId,
      step_id: assistantId,
      code: 'storage.migration_failed',
      classe: 'storage',
      recovery_action: 'fatal',
      user_visible: 1,
      payload_json: JSON.stringify({ message: 'migration aborted; staging left unchanged' }),
      created_at: 900_260,
      prev_chain_hash: 'b1-fail-1',
      this_chain_hash: 'b1-fail-2',
    });

    completeSession(db, sessionId, 'error', 0.011, true, 901_400);

    return { kind: 'session_specific', sessionId };
  },
};
