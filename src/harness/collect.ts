import type { StopReason, StreamEvent } from '../providers/index.ts';

export interface CollectedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

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
  stop_reason: StopReason;
  errors: CollectedError[];
}

const empty = (): CollectedStep => ({
  message_id: '',
  text: '',
  tool_uses: [],
  thinking: '',
  stop_reason: 'end_turn',
  errors: [],
});

// Drain a provider stream into a single CollectedStep. The normalizer guarantees
// well-formed event ordering (CONTRACTS §4), so we just accumulate per-kind.
// Tool use names arrive on `tool_use_start` and don't repeat on `_stop`; we
// track them in a temp map keyed by id.
export const collectStep = async (events: AsyncIterable<StreamEvent>): Promise<CollectedStep> => {
  const out = empty();
  const toolNamesById = new Map<string, string>();

  for await (const ev of events) {
    switch (ev.kind) {
      case 'start':
        out.message_id = ev.message_id;
        break;
      case 'text_delta':
        out.text += ev.text;
        break;
      case 'thinking_delta':
        out.thinking += ev.text;
        break;
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
        out.tool_uses.push({ id: ev.id, name, input: ev.final_args });
        break;
      }
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

  return out;
};
