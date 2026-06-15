import { emptyUsage } from '../providers/cost.ts';
import type {
  ProviderReasoningBlock,
  StopReason,
  StreamEvent,
  UsageInfo,
} from '../providers/index.ts';

// Wraps an iteration error so the partial CollectedStep is recoverable
// at the harness layer. Without this, usage/text/tool_uses captured
// before the stream threw are dropped on the floor — including the
// `usage` event some adapters emit from `finally` to record billed
// tokens on failed turns.
export class CollectStepError extends Error {
  override readonly cause: unknown;
  readonly partial: CollectedStep;
  constructor(cause: unknown, partial: CollectedStep) {
    const message =
      cause instanceof Error ? cause.message || cause.name || String(cause) : String(cause);
    super(message);
    this.name = 'CollectStepError';
    this.cause = cause;
    this.partial = partial;
  }
}

export interface CollectedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// One content block in the exact order the model emitted it this turn. Preserves
// interleaving (e.g. thinking1, tool1, thinking2, tool2) that the bucketed
// `reasoning`/`tool_uses` arrays lose — Anthropic 400s if replayed thinking
// blocks are reordered relative to the tool_use blocks around them. Holds the
// same object references as the bucketed arrays (no copy). `buildAssistantContent`
// rebuilds the assistant turn from this; other consumers keep using the buckets.
export type CollectedBlock =
  | { kind: 'reasoning'; reasoning: ProviderReasoningBlock }
  | { kind: 'tool_use'; toolUse: CollectedToolUse }
  | { kind: 'text'; text: string };

export interface CollectedError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CollectedStep {
  message_id: string;
  text: string;
  tool_uses: CollectedToolUse[];
  thinking: string;
  // Opaque, provider-tagged reasoning artifacts captured this turn (Anthropic
  // signed thinking, OpenAI reasoning items). Stored on the assistant message
  // for verbatim replay next request (capture is wired now; replay is flagged,
  // per-provider). Distinct from `thinking`, which is the live-display text.
  reasoning: ProviderReasoningBlock[];
  // The turn's content blocks in original emission order (reasoning / text /
  // tool_use interleaved as produced). Source of truth for rebuilding the
  // assistant message; the bucketed `text`/`tool_uses`/`reasoning` above stay
  // for consumers that don't care about order.
  order: CollectedBlock[];
  stop_reason: StopReason;
  errors: CollectedError[];
  usage: UsageInfo;
  // True iff at least one `usage` event was seen on the stream. Lets the
  // harness persist NULL token columns (instead of zeroes) when an adapter
  // never reports — the difference matters for analytics that want to
  // distinguish "no measurement" from "measured zero".
  usageSeen: boolean;
}

const empty = (): CollectedStep => ({
  message_id: '',
  text: '',
  tool_uses: [],
  thinking: '',
  reasoning: [],
  order: [],
  stop_reason: 'end_turn',
  errors: [],
  usage: emptyUsage(),
  usageSeen: false,
});

// Drain a provider stream into a single CollectedStep. The normalizer guarantees
// well-formed event ordering (CONTRACTS §4), so we just accumulate per-kind.
// Tool use names arrive on `tool_use_start` and don't repeat on `_stop`; we
// track them in a temp map keyed by id. The optional `onEvent` callback
// forwards each raw provider event for live observers (UI renderers).
export const collectStep = async (
  events: AsyncIterable<StreamEvent>,
  onEvent?: (event: StreamEvent) => void,
): Promise<CollectedStep> => {
  const out = empty();
  const toolNamesById = new Map<string, string>();
  // Buffer contiguous text deltas; flush as one ordered `text` block right
  // before the next reasoning/tool_use block (and at stream end) so `order`
  // captures where text sat relative to the other blocks.
  let pendingText = '';
  const flushText = (): void => {
    if (pendingText.length > 0) {
      out.order.push({ kind: 'text', text: pendingText });
      pendingText = '';
    }
  };

  try {
    for await (const ev of events) {
      if (onEvent !== undefined) {
        try {
          onEvent(ev);
        } catch {
          // Renderers throwing must not derail the loop.
        }
      }
      switch (ev.kind) {
        case 'start':
          out.message_id = ev.message_id;
          break;
        case 'text_delta':
          out.text += ev.text;
          pendingText += ev.text;
          break;
        case 'thinking_delta':
          out.thinking += ev.text;
          break;
        case 'reasoning': {
          // Opaque artifact for replay — stored verbatim, never normalized.
          flushText();
          const block: ProviderReasoningBlock = {
            type: 'reasoning',
            provider: ev.provider,
            data: ev.data,
          };
          out.reasoning.push(block);
          out.order.push({ kind: 'reasoning', reasoning: block });
          break;
        }
        case 'tool_use_start':
          toolNamesById.set(ev.id, ev.name);
          break;
        case 'tool_use_delta':
          // Args are accumulated by the normalizer; we don't need partial chunks.
          break;
        case 'tool_use_stop': {
          const name = toolNamesById.get(ev.id);
          if (name === undefined) {
            // Shouldn't happen if the normalizer is well-behaved; record as
            // an error rather than crash the loop.
            out.errors.push({
              code: 'harness.orphan_tool_use_stop',
              message: `tool_use_stop for unknown id ${ev.id}`,
              retryable: false,
            });
            break;
          }
          flushText();
          const toolUse: CollectedToolUse = { id: ev.id, name, input: ev.final_args };
          out.tool_uses.push(toolUse);
          out.order.push({ kind: 'tool_use', toolUse });
          break;
        }
        case 'usage':
          // Last `usage` event wins. Adapters emit exactly one per turn
          // today, but if a provider ever splits the report across multiple
          // events the spec semantic is "final values", not "sum across".
          out.usage = ev.usage;
          out.usageSeen = true;
          break;
        case 'stop':
          out.stop_reason = ev.reason;
          break;
        case 'error':
          out.errors.push({
            code: ev.code,
            message: ev.message,
            retryable: ev.retryable,
          });
          break;
      }
    }
  } catch (e) {
    // Stream threw mid-iteration. Whatever events we already
    // captured (text deltas, tool_uses, AND usage emitted by the
    // adapter's `finally`) are intact in `out`. Wrap so the harness
    // can recover the partial state from the error and fold partial
    // usage into session totals — otherwise turns that errored mid-
    // stream get billed by the provider but omitted from cost
    // tracking.
    flushText();
    throw new CollectStepError(e, out);
  }

  flushText();
  return out;
};
