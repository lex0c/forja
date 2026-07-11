import { appendFailureEvent } from '../../../src/storage/repos/failure-events.ts';
import { appendMessage } from '../../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../../src/storage/repos/tool-calls.ts';
import { padId, type RecapFixture } from './types.ts';

// Two recovered failures of different shapes in one session: a
// degraded MCP tool (kept going with reduced function) and a
// provider fallback to a cheaper model. Both surface in errors[]
// with recovered=true; one carries no payload prose so its summary
// is empty (renderer falls back to the code).
export const fixture: RecapFixture = {
  name: '09-error-recovered-fallback',
  description: 'degraded mcp tool + provider fallback, both recovered',
  now: 900_000,
  seed: (db) => {
    const sessionId = padId('a9', 1);
    createSession(db, {
      id: sessionId,
      model: 'sonnet-4-6',
      cwd: '/home/lex/proj',
      startedAt: 800_000,
    });

    const userId = padId('a9', 100);
    appendMessage(db, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'summarize the open issues from the tracker',
      createdAt: 800_100,
    });

    const assistantId = padId('a9', 200);
    appendMessage(db, {
      id: assistantId,
      sessionId,
      parentId: userId,
      role: 'assistant',
      content: [{ type: 'text', text: 'Pulling the issue list and summarizing.' }],
      tokensIn: 5_100,
      tokensOut: 410,
      cachedTokens: 4_000,
      costUsd: 0.026,
      createdAt: 800_200,
    });

    const readId = padId('a9', 301);
    createToolCall(db, {
      id: readId,
      messageId: assistantId,
      toolName: 'read_file',
      input: { path: '/home/lex/proj/ISSUES.md' },
      createdAt: 800_301,
    });
    finishToolCall(db, {
      id: readId,
      status: 'done',
      output: { content: '...', total_lines: 120, lines_returned: 120, truncated: false },
      durationMs: 5,
    });

    // Recovered failure 1: an MCP tool degraded but the run
    // continued. Payload prose populates the summary.
    appendFailureEvent(db, {
      id: padId('a9', 400),
      session_id: sessionId,
      step_id: assistantId,
      code: 'mcp.tool_unavailable',
      classe: 'mcp',
      recovery_action: 'degraded',
      user_visible: 1,
      payload_json: JSON.stringify({ message: 'tracker MCP offline; used cached issue list' }),
      created_at: 800_240,
      prev_chain_hash: 'genesis',
      this_chain_hash: 'a9-fail-1',
    });

    // Recovered failure 2: provider fallback to a cheaper model. No
    // payload prose → summary empty → renderer falls back to code.
    appendFailureEvent(db, {
      id: padId('a9', 401),
      session_id: sessionId,
      step_id: assistantId,
      code: 'provider.overloaded',
      classe: 'provider',
      recovery_action: 'fallback_to_anthropic_haiku',
      user_visible: 1,
      payload_json: null,
      created_at: 800_260,
      prev_chain_hash: 'a9-fail-1',
      this_chain_hash: 'a9-fail-2',
    });

    completeSession(db, sessionId, 'done', 0.026, true, 801_800);

    return { kind: 'session_specific', sessionId };
  },
};
