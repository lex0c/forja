import type { StopReason, StreamEvent } from '../types.ts';
import type { OllamaChatResponse, OllamaMessage, OllamaToolCall } from './http.ts';

// Stop reason from the final (done) chunk plus whether ANY tool call was emitted
// across the whole stream. Tool calls can arrive on a non-final chunk, so
// `tool_use` is derived from the accumulated set — not `final.message.tool_calls`,
// which may be empty on the terminating chunk.
const stopReason = (final: OllamaChatResponse | undefined, hasToolCalls: boolean): StopReason => {
  // `length` wins: a truncation must surface as max_tokens even when a tool call
  // was also emitted, rather than hiding the cut behind tool_use.
  if (final?.done_reason === 'length') {
    return 'max_tokens';
  }
  if (hasToolCalls) {
    return 'tool_use';
  }
  return 'end_turn';
};

// Normalize the streamed /api/chat NDJSON chunks into the canonical StreamEvent
// sequence: `start` on the first chunk, `text_delta` / `thinking_delta` per chunk,
// tool calls accumulated and emitted as start+stop pairs (args are already
// objects), then `usage` + `stop` from the final (done) chunk. Works for a single
// non-streamed object too (one chunk in → the same events out).
export async function* normalizeOllamaStream(
  chunks: AsyncIterable<OllamaChatResponse>,
): AsyncIterable<StreamEvent> {
  let started = false;
  let thinkingText = '';
  const toolCalls: OllamaToolCall[] = [];
  let final: OllamaChatResponse | undefined;

  for await (const chunk of chunks) {
    if (!started) {
      // Ollama has no message id; created_at identifies the turn (model fallback).
      yield { kind: 'start', message_id: chunk.created_at || chunk.model };
      started = true;
    }
    // A streamed chunk usually carries `message`, but a final stats-only chunk
    // can omit it — guard the deref so a completed turn isn't turned into an
    // error, and record `final` regardless so usage/stop still fire.
    const msg = chunk.message as OllamaMessage | undefined;
    if (msg !== undefined) {
      if (msg.thinking !== undefined && msg.thinking.length > 0) {
        // thinking_delta is UI-only; also accumulate for the reasoning block
        // emitted at the end (collectStep persists `reasoning`, not thinking_delta).
        yield { kind: 'thinking_delta', text: msg.thinking };
        thinkingText += msg.thinking;
      }
      // `content` is typed string, but a tool-call-only chunk may omit it.
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        yield { kind: 'text_delta', text: msg.content };
      }
      if (msg.tool_calls !== undefined) {
        toolCalls.push(...msg.tool_calls);
      }
    }
    if (chunk.done) {
      final = chunk;
    }
  }

  // A stream with no chunks at all, or one that never carried a `done:true`
  // chunk (dropped connection / proxy cut), was truncated — surface it as an
  // error instead of faking a clean end_turn with zero usage.
  if (!started) {
    yield {
      kind: 'error',
      code: 'local.stream_incomplete',
      message: 'Ollama /api/chat returned an empty stream',
      retryable: false,
    };
    return;
  }
  if (final === undefined) {
    yield {
      kind: 'error',
      code: 'local.stream_incomplete',
      message: 'Ollama /api/chat stream ended without a final (done) chunk',
      retryable: false,
    };
    return;
  }

  // Capture the turn's thinking as an opaque reasoning block so it round-trips on
  // the next tool follow-up (Ollama's tool-calling guidance: gather thinking +
  // content + tool_calls for the follow-up). Emitted before tool_use so it leads
  // the assistant turn; the replay gate lives in toOllamaMessages.
  if (thinkingText.length > 0) {
    yield { kind: 'reasoning', provider: 'ollama', data: { thinking: thinkingText } };
  }

  for (const [i, call] of toolCalls.entries()) {
    const id = `ollama-${i}`;
    yield { kind: 'tool_use_start', id, name: call.function.name };
    yield { kind: 'tool_use_stop', id, final_args: call.function.arguments };
  }

  yield {
    kind: 'usage',
    usage: {
      input: final.prompt_eval_count ?? 0,
      output: final.eval_count ?? 0,
      cache_read: 0,
      cache_creation: 0,
    },
  };
  yield { kind: 'stop', reason: stopReason(final, toolCalls.length > 0) };
}
