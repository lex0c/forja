import type { StopReason, StreamEvent } from '../types.ts';
import type { OllamaChatResponse } from './http.ts';

const mapStopReason = (res: OllamaChatResponse): StopReason => {
  // `length` takes precedence over `tool_use`: a turn truncated at num_predict
  // must surface as max_tokens (the truncation signal) even when it also carried
  // a tool call, rather than hiding the cut behind tool_use.
  if (res.done_reason === 'length') {
    return 'max_tokens';
  }
  if (res.message.tool_calls !== undefined && res.message.tool_calls.length > 0) {
    return 'tool_use';
  }
  return 'end_turn';
};

// Normalize a non-streaming /api/chat response into the canonical StreamEvent
// sequence. F1 is stream:false, so each piece arrives complete: tool calls emit
// `tool_use_start` + `tool_use_stop` with no incremental deltas (the args are
// already a parsed object), and `usage` + `stop` close the turn. Incremental
// NDJSON streaming (F2) will reuse this taxonomy with real deltas.
export const normalizeOllamaResponse = (res: OllamaChatResponse): StreamEvent[] => {
  const events: StreamEvent[] = [];
  // Ollama has no message id; created_at identifies the turn (model as fallback).
  events.push({ kind: 'start', message_id: res.created_at || res.model });

  const { message } = res;
  if (message.thinking !== undefined && message.thinking.length > 0) {
    events.push({ kind: 'thinking_delta', text: message.thinking });
  }
  if (message.content.length > 0) {
    events.push({ kind: 'text_delta', text: message.content });
  }
  for (const [i, call] of (message.tool_calls ?? []).entries()) {
    const id = `ollama-${i}`;
    events.push({ kind: 'tool_use_start', id, name: call.function.name });
    events.push({ kind: 'tool_use_stop', id, final_args: call.function.arguments });
  }

  events.push({
    kind: 'usage',
    usage: {
      input: res.prompt_eval_count ?? 0,
      output: res.eval_count ?? 0,
      cache_read: 0,
      cache_creation: 0,
    },
  });
  events.push({ kind: 'stop', reason: mapStopReason(res) });

  return events;
};
