import type { StopReason, StreamEvent, UsageInfo } from '../types.ts';

// Anthropic usage shape. `input_tokens` is the prompt minus cache hits;
// `cache_creation_input_tokens` is what was written to cache this turn (full
// price tier); `cache_read_input_tokens` is what was read from cache (cheap
// tier). All can be undefined on older API versions or when caching is off.
export interface RawAnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Minimal structural type covering the Anthropic raw stream events we read.
// Defined locally so tests can construct events without depending on the SDK
// type surface; the real SDK events are structurally compatible.
export type RawAnthropicEvent =
  | { type: 'message_start'; message: { id: string; usage?: RawAnthropicUsage } }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text?: string }
        | { type: 'tool_use'; id: string; name: string; input?: unknown }
        | { type: 'thinking'; thinking?: string };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason?: string | null };
      usage?: RawAnthropicUsage;
    }
  | { type: 'message_stop' };

interface ToolUseInProgress {
  id: string;
  name: string;
  partialArgs: string;
}

const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'refusal',
]);

const mapStopReason = (raw: string): StopReason =>
  KNOWN_STOP_REASONS.has(raw) ? (raw as StopReason) : 'end_turn';

// Convert a stream of Anthropic raw events into the canonical StreamEvent
// shape from CONTRACTS.md §4. Tool args are reconstructed across
// `input_json_delta` chunks and parsed at `content_block_stop`; a parse
// failure becomes a single `error` event (the tool_use is dropped, not
// invoked downstream).
export async function* normalizeAnthropicStream(
  raw: AsyncIterable<RawAnthropicEvent>,
): AsyncIterable<StreamEvent> {
  const toolUses = new Map<number, ToolUseInProgress>();
  let stopReason: StopReason = 'end_turn';
  // Anthropic splits usage across two events: input/cache numbers ride
  // `message_start.message.usage`; output_tokens lands on the final
  // `message_delta.usage`. Accumulate then emit a single `usage` event
  // right before `stop` so the harness sees one canonical row per turn.
  const usage: UsageInfo = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };

  // Anthropic reports CUMULATIVE usage in both message_start and message_delta
  // today, so a straight assignment would also be correct. We keep the
  // running max instead so a hypothetical SDK shift to incremental deltas
  // (or an interim event reporting partial counts) can't silently shrink
  // the totals — `Math.max` is monotonic over cumulative streams and
  // recovers the largest-seen value over delta streams as long as one
  // event ever carries the full count.
  const mergeUsage = (u: RawAnthropicUsage | undefined): void => {
    if (u === undefined) return;
    if (typeof u.input_tokens === 'number') {
      usage.input = Math.max(usage.input, u.input_tokens);
    }
    if (typeof u.output_tokens === 'number') {
      usage.output = Math.max(usage.output, u.output_tokens);
    }
    if (typeof u.cache_read_input_tokens === 'number') {
      usage.cache_read = Math.max(usage.cache_read, u.cache_read_input_tokens);
    }
    if (typeof u.cache_creation_input_tokens === 'number') {
      usage.cache_creation = Math.max(usage.cache_creation, u.cache_creation_input_tokens);
    }
  };

  for await (const event of raw) {
    switch (event.type) {
      case 'message_start':
        yield { kind: 'start', message_id: event.message.id };
        mergeUsage(event.message.usage);
        break;

      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          toolUses.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            partialArgs: '',
          });
          yield {
            kind: 'tool_use_start',
            id: event.content_block.id,
            name: event.content_block.name,
          };
        }
        // text and thinking blocks need no start event in the canonical shape;
        // their first delta carries the data.
        break;

      case 'content_block_delta': {
        const { delta } = event;
        if (delta.type === 'text_delta') {
          yield { kind: 'text_delta', text: delta.text };
        } else if (delta.type === 'input_json_delta') {
          const tool = toolUses.get(event.index);
          if (tool !== undefined) {
            tool.partialArgs += delta.partial_json;
            yield {
              kind: 'tool_use_delta',
              id: tool.id,
              partial_args: delta.partial_json,
            };
          }
        } else if (delta.type === 'thinking_delta') {
          yield { kind: 'thinking_delta', text: delta.thinking };
        }
        // signature_delta (extended thinking signing) is intentionally dropped:
        // it has no UI value and isn't part of the canonical taxonomy.
        break;
      }

      case 'content_block_stop': {
        const tool = toolUses.get(event.index);
        if (tool !== undefined) {
          let parsed: Record<string, unknown> = {};
          if (tool.partialArgs.length > 0) {
            try {
              const obj = JSON.parse(tool.partialArgs) as unknown;
              if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
                throw new Error('tool args must decode to a JSON object');
              }
              parsed = obj as Record<string, unknown>;
            } catch (e) {
              yield {
                kind: 'error',
                code: 'tool_args_parse_error',
                message: `failed to parse tool_use args for ${tool.id}: ${(e as Error).message}`,
                retryable: false,
              };
              toolUses.delete(event.index);
              break;
            }
          }
          yield { kind: 'tool_use_stop', id: tool.id, final_args: parsed };
          toolUses.delete(event.index);
        }
        break;
      }

      case 'message_delta':
        // Anthropic may emit interim message_deltas without a stop_reason
        // (null or omitted). We only update on a real string value, so a
        // later null can't clobber an earlier valid stop_reason.
        if (typeof event.delta.stop_reason === 'string') {
          stopReason = mapStopReason(event.delta.stop_reason);
        }
        mergeUsage(event.usage);
        break;

      case 'message_stop':
        yield { kind: 'usage', usage };
        yield { kind: 'stop', reason: stopReason };
        break;
    }
  }
}
