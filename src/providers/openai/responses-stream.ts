import { randomUUID } from 'node:crypto';
import type { StopReason, StreamEvent, UsageInfo } from '../types.ts';

// Normalizer for the OpenAI **Responses API** SSE stream (the path reasoning
// models — gpt-5.x — require; Chat Completions 400s on tools+reasoning_effort
// for them). The Responses event vocabulary is entirely different from Chat
// Completions, so this is a separate normalizer mapping onto the same
// canonical `StreamEvent` shape (CONTRACTS.md §4).
//
// Event → canonical mapping:
//   - response.created / .in_progress        → `start` (response.id as message id)
//   - response.output_text.delta             → `text_delta`
//   - response.output_item.added (function)  → `tool_use_start` (id = call_id)
//   - response.function_call_arguments.delta → `tool_use_delta`
//   - response.output_item.done (function)   → `tool_use_stop` (parsed args)
//   - response.completed / .incomplete       → `usage` + terminal stop reason
//   - response.failed / error                → `error`
//
// Only the fields this normalizer reads are typed; the SDK's full event union
// is cast down to `RawResponsesEvent` at the call site (same pragmatic seam as
// the Chat Completions `RawOpenAIChunk`).

export interface RawResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

export interface RawResponsesEvent {
  type: string;
  // output_text.delta / function_call_arguments.delta
  delta?: string;
  // function_call_arguments.delta — the output item the delta belongs to
  item_id?: string;
  // output_item.added / .done
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    // gpt-5.3-codex preamble/closeout marker on assistant message items
    // (commentary | final_answer). Captured so it round-trips.
    phase?: string;
  };
  // created / completed / incomplete / failed
  response?: {
    id?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: RawResponsesUsage | null;
  };
  // error event
  code?: string;
  message?: string;
}

const synthesizeMessageId = (): string => `openai_${randomUUID()}`;

// Responses `usage` reports `input_tokens` as the FULL input (cached
// included), same convention as Chat Completions' prompt_tokens — so the
// non-cached remainder is input − cached. Responses reports no cache WRITE,
// so cache_creation stays 0.
export const responsesUsageToCanonical = (u: RawResponsesUsage): UsageInfo => {
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cached),
    output: u.output_tokens ?? 0,
    cache_read: cached,
    cache_creation: 0,
  };
};

export async function* normalizeResponsesStream(
  raw: AsyncIterable<RawResponsesEvent>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  let usageEmitted = false;
  // Whether a terminal event (completed / incomplete) set `stopReason`. If the
  // stream ends without one (e.g. a clean cut-off), the trailing stop falls
  // back to a tool-call-aware reason rather than a flat end_turn.
  let terminalSeen = false;
  // A turn that emitted any function_call ends in `tool_use` so the harness
  // executes the tools and continues the loop (mirrors Chat Completions'
  // finish_reason `tool_calls` → `tool_use`).
  let sawToolCall = false;
  // function-call output-item id → its call_id, so the arguments-delta events
  // (keyed by item_id) can be attributed to the call_id the harness tracks.
  const callIdByItem = new Map<string, string>();
  // function-call output-item id → its accumulated arguments. The harness
  // takes the final args from `tool_use_stop` (collect.ts: "args accumulated
  // by the normalizer"), so we accumulate the delta chunks as a FALLBACK for
  // the `output_item.done` arguments — robust even if a variant ships the done
  // item without the full `arguments` string.
  const argsByItem = new Map<string, string>();
  // Whether any reasoning-summary text has been emitted yet. A reasoning turn
  // can produce MULTIPLE summary parts (and multiple reasoning items across
  // tool round-trips), each streamed as its own run of
  // `reasoning_summary_text.delta` events with no inter-part text. Without a
  // separator the parts concatenate into one run-on blob, so we inject a blank
  // line at each new part boundary AFTER the first.
  let summaryTextSeen = false;

  for await (const ev of raw) {
    switch (ev.type) {
      case 'response.created':
      case 'response.in_progress':
        if (!messageStarted) {
          yield { kind: 'start', message_id: ev.response?.id ?? synthesizeMessageId() };
          messageStarted = true;
        }
        break;

      case 'response.output_text.delta':
        if (ev.delta !== undefined && ev.delta.length > 0) {
          yield { kind: 'text_delta', text: ev.delta };
        }
        break;

      case 'response.reasoning_summary_part.added':
        // A new summary part begins. Separate it from the previous one with a
        // blank line so multi-part / multi-step summaries don't run together.
        // Gated on `summaryTextSeen` so the FIRST part gets no leading blank.
        if (summaryTextSeen) {
          yield { kind: 'thinking_delta', text: '\n\n' };
        }
        break;

      case 'response.reasoning_summary_text.delta':
        // Reasoning SUMMARY stream (requested via `reasoning.summary: 'auto'`).
        // OpenAI never streams the raw CoT — this is a summary — but emitting it
        // as `thinking_delta` lets the live "Thinking…" chip AND the scrollback
        // `reasoning:` block show gpt reasoning, same as Anthropic's extended
        // thinking. Same `delta` field shape as output_text.delta.
        if (ev.delta !== undefined && ev.delta.length > 0) {
          yield { kind: 'thinking_delta', text: ev.delta };
          summaryTextSeen = true;
        }
        break;

      case 'response.output_item.added':
        if (ev.item?.type === 'function_call' && ev.item.call_id && ev.item.name) {
          sawToolCall = true;
          if (ev.item.id) callIdByItem.set(ev.item.id, ev.item.call_id);
          yield { kind: 'tool_use_start', id: ev.item.call_id, name: ev.item.name };
        }
        break;

      case 'response.function_call_arguments.delta': {
        if (ev.item_id !== undefined && ev.delta !== undefined && ev.delta.length > 0) {
          argsByItem.set(ev.item_id, (argsByItem.get(ev.item_id) ?? '') + ev.delta);
          const callId = callIdByItem.get(ev.item_id);
          if (callId !== undefined) {
            yield { kind: 'tool_use_delta', id: callId, partial_args: ev.delta };
          }
        }
        break;
      }

      case 'response.output_item.done':
        if (ev.item?.type === 'function_call' && ev.item.call_id) {
          // Prefer the done item's full arguments; fall back to the chunks we
          // accumulated from the delta events if it's absent.
          const fromItem = ev.item.arguments ?? '';
          const argStr =
            fromItem.length > 0 ? fromItem : ev.item.id ? (argsByItem.get(ev.item.id) ?? '') : '';
          let parsed: Record<string, unknown> = {};
          if (argStr.length > 0) {
            try {
              const obj = JSON.parse(argStr) as unknown;
              if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
                throw new Error('tool args must decode to a JSON object');
              }
              parsed = obj as Record<string, unknown>;
            } catch (e) {
              // Malformed / non-object args = a FAILED call, not an empty one
              // (matches the Anthropic + Chat Completions normalizers). Emit an
              // error so the harness fails the turn, and DROP the stop so the
              // bad call is never executed/recorded with bogus args — empty
              // args on read_file/bash would otherwise run the wrong thing.
              yield {
                kind: 'error',
                code: 'tool_args_parse_error',
                message: `failed to parse tool_use args for ${ev.item.call_id}: ${(e as Error).message}`,
                retryable: false,
              };
              break;
            }
          }
          yield { kind: 'tool_use_stop', id: ev.item.call_id, final_args: parsed };
        } else if (ev.item?.type === 'reasoning') {
          // Capture the reasoning output item VERBATIM (opaque — carries id,
          // summary, the encrypted_content requested via `include`, and any
          // `phase`). Stored on the assistant turn; replayed as an input item next
          // request unless FORJA_OPENAI_REASONING_REPLAY=0 (replay defaults ON).
          // The harness never inspects `data`; the adapter round-trips it unchanged.
          yield { kind: 'reasoning', provider: 'openai', data: ev.item };
        } else if (ev.item?.type === 'message' && typeof ev.item.phase === 'string') {
          // gpt-5.3-codex `phase` rides on the assistant MESSAGE item, which the
          // harness rebuilds from text (losing the field). Carry it on the
          // reasoning channel via a sentinel so the OpenAI adapter can re-stamp
          // it onto the replayed assistant message (dropping the phase causes
          // "significant performance degradation" per the codex guide).
          yield {
            kind: 'reasoning',
            provider: 'openai',
            data: { __forja_message_phase: ev.item.phase },
          };
        }
        break;

      case 'response.completed':
        if (ev.response?.usage != null && !usageEmitted) {
          yield { kind: 'usage', usage: responsesUsageToCanonical(ev.response.usage) };
          usageEmitted = true;
        }
        stopReason = sawToolCall ? 'tool_use' : 'end_turn';
        terminalSeen = true;
        break;

      case 'response.incomplete':
        if (ev.response?.usage != null && !usageEmitted) {
          yield { kind: 'usage', usage: responsesUsageToCanonical(ev.response.usage) };
          usageEmitted = true;
        }
        // `max_output_tokens` is the budget-exhausted case → max_tokens.
        stopReason =
          ev.response?.incomplete_details?.reason === 'max_output_tokens'
            ? 'max_tokens'
            : 'end_turn';
        terminalSeen = true;
        break;

      case 'response.failed':
      case 'error':
        yield {
          kind: 'error',
          code: ev.code ?? 'responses_failed',
          message: ev.message ?? 'OpenAI Responses stream failed',
          retryable: false,
        };
        break;
    }
  }

  // No terminal event (clean cut-off) → fall back to a tool-call-aware reason
  // so a pending tool call still continues the loop.
  yield {
    kind: 'stop',
    reason: terminalSeen ? stopReason : sawToolCall ? 'tool_use' : 'end_turn',
  };
}
