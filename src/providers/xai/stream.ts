import type { StopReason, StreamEvent } from '../types.ts';

// xAI (Grok) speaks the OpenAI Chat Completions streaming shape, plus one
// superset field this normalizer surfaces: `delta.reasoning_content`, the
// live chain-of-thought Grok streams alongside `delta.content`. It is exposed
// as `thinking_delta` for the UI ONLY — Chat Completions has no reasoning-input
// slot, so (unlike Anthropic/OpenRouter) there is nothing to replay and NO
// `reasoning` block is emitted. Tool-call accumulation (by `index`) and usage
// splitting mirror the OpenAI normalizer verbatim.

export interface RawXaiToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface RawXaiChoiceDelta {
  role?: string;
  content?: string | null;
  refusal?: string | null;
  // Grok's streamed chain-of-thought. `reasoning_content` is the documented
  // field; `reasoning` is accepted as an alias (some OpenAI-compatible surfaces
  // stream it under that name).
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: RawXaiToolCallDelta[];
}

export interface RawXaiChoice {
  index?: number;
  delta?: RawXaiChoiceDelta;
  finish_reason?: string | null;
}

// Usage arrives in the final chunk when the request set
// `stream_options: { include_usage: true }` (the adapter opts in). `prompt_tokens`
// includes the cached portion; `cached_tokens` is the discounted automatic-cache
// read. xAI reports no cache-WRITE count, so cache_creation stays zero.
export interface RawXaiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface RawXaiChunk {
  id?: string;
  choices?: RawXaiChoice[];
  usage?: RawXaiUsage | null;
}

interface ToolCallInProgress {
  // Locked at the first delta for this `index` — the harness's name lookup keys
  // on the id already yielded in tool_use_start, so it must never change.
  id: string;
  name: string;
  partialArgs: string;
  // Deferred until a non-empty `name` arrives (Grok can split the name across
  // deltas); starting with name='' would invoke an unknown tool.
  started: boolean;
}

const FINISH_REASON_MAP: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

const synthesizeMessageId = (): string => `xai_${crypto.randomUUID()}`;

// Convert a stream of xAI Chat Completions chunks into the canonical
// StreamEvent shape (CONTRACTS.md §4).
export async function* normalizeXaiStream(
  raw: AsyncIterable<RawXaiChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  const toolCalls = new Map<number, ToolCallInProgress>();
  // Accumulate raw counters and split prompt-vs-cache only at emit time, using
  // Math.max so a split/partial usage report can't reset an earlier value to
  // zero. `usageSeen` gates emission: a compat proxy that drops stream_options
  // sends no usage chunk, and a synthetic zero would confuse "no telemetry"
  // with "measured zero".
  let rawPrompt = 0;
  let rawCompletion = 0;
  let rawCached = 0;
  let usageSeen = false;
  let usageEmitted = false;

  const emitUsage = function* (): Iterable<StreamEvent> {
    if (usageSeen && !usageEmitted) {
      yield {
        kind: 'usage',
        usage: {
          input: Math.max(0, rawPrompt - rawCached),
          output: rawCompletion,
          cache_read: rawCached,
          cache_creation: 0,
        },
      };
      usageEmitted = true;
    }
  };

  try {
    for await (const chunk of raw) {
      if (!messageStarted) {
        yield { kind: 'start', message_id: chunk.id ?? synthesizeMessageId() };
        messageStarted = true;
      }

      if (chunk.usage !== undefined && chunk.usage !== null) {
        const u = chunk.usage;
        let touched = false;
        if (typeof u.prompt_tokens === 'number') {
          rawPrompt = Math.max(rawPrompt, u.prompt_tokens);
          touched = true;
        }
        if (typeof u.completion_tokens === 'number') {
          rawCompletion = Math.max(rawCompletion, u.completion_tokens);
          touched = true;
        }
        if (typeof u.prompt_tokens_details?.cached_tokens === 'number') {
          rawCached = Math.max(rawCached, u.prompt_tokens_details.cached_tokens);
          touched = true;
        }
        if (touched) usageSeen = true;
      }

      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;

      const delta = choice.delta;
      if (delta !== undefined) {
        // Live reasoning for the UI. Grok streams `reasoning_content`; accept
        // the `reasoning` alias too. Display-only — no replay block follows.
        const reasoning =
          typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string' && delta.reasoning.length > 0
              ? delta.reasoning
              : undefined;
        if (reasoning !== undefined) {
          yield { kind: 'thinking_delta', text: reasoning };
        }
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
              inProgress = { id, name, partialArgs: '', started: false };
              toolCalls.set(tc.index, inProgress);
            } else if (
              typeof tc.function?.name === 'string' &&
              tc.function.name.length > 0 &&
              inProgress.name.length === 0
            ) {
              inProgress.name = tc.function.name;
            }

            const argsChunk = tc.function?.arguments;
            const hasArgs = typeof argsChunk === 'string' && argsChunk.length > 0;
            if (hasArgs) {
              inProgress.partialArgs += argsChunk;
            }

            if (!inProgress.started && inProgress.name.length > 0) {
              yield { kind: 'tool_use_start', id: inProgress.id, name: inProgress.name };
              inProgress.started = true;
              if (inProgress.partialArgs.length > 0) {
                yield {
                  kind: 'tool_use_delta',
                  id: inProgress.id,
                  partial_args: inProgress.partialArgs,
                };
              }
            } else if (inProgress.started && hasArgs) {
              yield {
                kind: 'tool_use_delta',
                id: inProgress.id,
                partial_args: argsChunk,
              };
            }
          }
        }
      }

      if (typeof choice.finish_reason === 'string') {
        stopReason = FINISH_REASON_MAP[choice.finish_reason] ?? 'end_turn';
      }
    }

    // No per-tool stop event in Chat Completions: finalize all in-progress tool
    // calls at end-of-stream, ordered by the original tool_call index.
    const sortedTools = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b);
    for (const [, tool] of sortedTools) {
      if (!tool.started) {
        yield {
          kind: 'error',
          code: 'xai.tool_use_no_name',
          message: `tool_call ${tool.id} ended without a function name`,
          retryable: false,
        };
        continue;
      }
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
    yield* emitUsage();
    yield { kind: 'stop', reason: stopReason };
  } finally {
    // Mid-stream error/disconnect: surface whatever usage already arrived so a
    // turn that throws after a usage chunk keeps its billed-token signal.
    yield* emitUsage();
  }
}
