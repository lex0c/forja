import type { StopReason, StreamEvent } from '../types.ts';

// Minimal structural subset of an OpenAI Chat Completions streaming chunk.
// Defined locally so tests can construct chunks without depending on SDK
// types; real SDK chunks are structurally compatible.
export interface RawOpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface RawOpenAIChoiceDelta {
  role?: string;
  content?: string | null;
  refusal?: string | null;
  tool_calls?: RawOpenAIToolCallDelta[];
}

export interface RawOpenAIChoice {
  index?: number;
  delta?: RawOpenAIChoiceDelta;
  finish_reason?: string | null;
}

export interface RawOpenAIChunk {
  id?: string;
  choices?: RawOpenAIChoice[];
}

interface ToolCallInProgress {
  id: string;
  // Real OpenAI ids start with `call_`, same as our synthesized fallback,
  // so the prefix can't be used to tell them apart. Track an explicit flag
  // and only let it be replaced once.
  idIsSynthesized: boolean;
  name: string;
  partialArgs: string;
}

const FINISH_REASON_MAP: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  // legacy spelling from the deprecated function calling API
  function_call: 'tool_use',
  content_filter: 'refusal',
};

const synthesizeMessageId = (): string => `openai_${crypto.randomUUID()}`;

// Convert a stream of OpenAI Chat Completions chunks into the canonical
// StreamEvent shape from CONTRACTS.md §4. Notable differences from
// Anthropic and Gemini:
//   - OpenAI streams tool_call.function.arguments as raw JSON-string chunks
//     keyed by `index`; each tool call must be tracked across deltas.
//   - There is no per-tool stop event. We finalize all in-progress tool
//     calls at end-of-stream (parsing accumulated args, emitting tool_use_stop).
//   - `delta.refusal` is a stream of safety-refusal text and is exposed as
//     plain text_delta — visible to the user, but coming from a different
//     SDK field.
//   - The first chunk's `id` is used as message_id; if absent, synthesized.
export async function* normalizeOpenAIStream(
  raw: AsyncIterable<RawOpenAIChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  const toolCalls = new Map<number, ToolCallInProgress>();

  for await (const chunk of raw) {
    if (!messageStarted) {
      yield { kind: 'start', message_id: chunk.id ?? synthesizeMessageId() };
      messageStarted = true;
    }

    const choice = chunk.choices?.[0];
    if (choice === undefined) continue;

    const delta = choice.delta;
    if (delta !== undefined) {
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { kind: 'text_delta', text: delta.content };
      }
      if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
        yield { kind: 'text_delta', text: delta.refusal };
      }
      if (delta.tool_calls !== undefined) {
        for (const tc of delta.tool_calls) {
          let inProgress = toolCalls.get(tc.index);
          if (inProgress === undefined) {
            const id = tc.id ?? `call_${tc.index}_${crypto.randomUUID()}`;
            const name = tc.function?.name ?? '';
            inProgress = {
              id,
              idIsSynthesized: tc.id === undefined,
              name,
              partialArgs: '',
            };
            toolCalls.set(tc.index, inProgress);
            yield { kind: 'tool_use_start', id, name };
          } else {
            // id and name may straggle across the first few chunks. We only
            // accept a real id once — subsequent ids are ignored (defensive
            // against SDK quirks, since OpenAI sends id only in chunk 1 in
            // practice).
            if (tc.id !== undefined && inProgress.idIsSynthesized) {
              inProgress.id = tc.id;
              inProgress.idIsSynthesized = false;
            }
            if (
              typeof tc.function?.name === 'string' &&
              tc.function.name.length > 0 &&
              inProgress.name.length === 0
            ) {
              inProgress.name = tc.function.name;
            }
          }
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
            inProgress.partialArgs += tc.function.arguments;
            yield {
              kind: 'tool_use_delta',
              id: inProgress.id,
              partial_args: tc.function.arguments,
            };
          }
        }
      }
    }

    if (typeof choice.finish_reason === 'string') {
      stopReason = FINISH_REASON_MAP[choice.finish_reason] ?? 'end_turn';
    }
  }

  // Close out tool_use blocks. OpenAI doesn't emit a per-tool stop, so we
  // parse and emit at end-of-stream, ordered by the original tool_call index.
  const sortedTools = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b);
  for (const [, tool] of sortedTools) {
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
        continue;
      }
    }
    yield { kind: 'tool_use_stop', id: tool.id, final_args: parsed };
  }

  if (!messageStarted) {
    yield { kind: 'start', message_id: synthesizeMessageId() };
  }
  yield { kind: 'stop', reason: stopReason };
}
