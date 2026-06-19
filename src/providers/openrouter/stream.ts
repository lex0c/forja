import type { StopReason, StreamEvent } from '../types.ts';

// OpenRouter speaks the OpenAI Chat Completions streaming shape, plus a few
// superset fields: `delta.reasoning` (plaintext) / `delta.reasoning_details[]`
// (structured, for replay), `usage.prompt_tokens_details.cache_write_tokens`,
// `usage.cost`, and an IN-BAND error (HTTP 200 + `finish_reason:"error"` and an
// `error` object on the chunk/choice). This normalizer mirrors the OpenAI tool-
// call accumulation (by `index`) and adds those fields.

export interface RawORToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface RawORChoiceDelta {
  role?: string;
  content?: string | null;
  refusal?: string | null;
  reasoning?: string | null;
  // Structured reasoning, accumulated verbatim for replay.
  reasoning_details?: unknown[];
  tool_calls?: RawORToolCallDelta[];
}

export interface RawORChoice {
  index?: number;
  delta?: RawORChoiceDelta;
  finish_reason?: string | null;
  // OpenRouter surfaces a mid-stream upstream failure here.
  error?: { code?: number | string; message?: string } | null;
}

export interface RawORUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    // OpenRouter reports explicit-cache writes here (OpenAI does not).
    cache_write_tokens?: number;
  };
}

export interface RawORChunk {
  id?: string;
  choices?: RawORChoice[];
  usage?: RawORUsage | null;
  // A top-level error can also arrive in-band on a 200 stream.
  error?: { code?: number | string; message?: string } | null;
}

interface ToolCallInProgress {
  id: string;
  name: string;
  partialArgs: string;
  started: boolean;
}

const FINISH_REASON_MAP: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

const synthesizeMessageId = (): string => `openrouter_${crypto.randomUUID()}`;

// A numeric (or numeric-string) OpenRouter error code mirrors the HTTP status:
// 5xx / 429 are transient and worth a retry; everything else is terminal.
const isRetryableErrorCode = (code: number | string | undefined): boolean => {
  const n = typeof code === 'string' ? Number(code) : code;
  return typeof n === 'number' && Number.isFinite(n) && (n === 429 || (n >= 500 && n < 600));
};

export async function* normalizeOpenRouterStream(
  raw: AsyncIterable<RawORChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  const toolCalls = new Map<number, ToolCallInProgress>();
  const reasoningDetails: unknown[] = [];
  let rawPrompt = 0;
  let rawCompletion = 0;
  let rawCached = 0;
  let rawCacheWrite = 0;
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
          cache_creation: rawCacheWrite,
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

      // In-band error (top-level or on the choice). Surface it and stop — the
      // stream may end without a clean finish_reason after this.
      const choice0 = chunk.choices?.[0];
      const err = chunk.error ?? choice0?.error;
      if (err !== undefined && err !== null) {
        yield {
          kind: 'error',
          code: 'openrouter.stream_error',
          message: err.message ?? `OpenRouter stream error (code=${err.code ?? 'unknown'})`,
          retryable: isRetryableErrorCode(err.code),
        };
        yield* emitUsage();
        return;
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
        if (typeof u.prompt_tokens_details?.cache_write_tokens === 'number') {
          rawCacheWrite = Math.max(rawCacheWrite, u.prompt_tokens_details.cache_write_tokens);
          touched = true;
        }
        if (touched) usageSeen = true;
      }

      const choice = choice0;
      if (choice === undefined) continue;

      const delta = choice.delta;
      if (delta !== undefined) {
        // Live reasoning for the UI.
        const hadPlaintextReasoning =
          typeof delta.reasoning === 'string' && delta.reasoning.length > 0;
        if (hadPlaintextReasoning) {
          yield { kind: 'thinking_delta', text: delta.reasoning as string };
        }
        // Structured reasoning accumulated verbatim for the replay block. When a
        // provider streams ONLY reasoning_details (no plaintext delta.reasoning),
        // surface their text so the live UI still shows the thinking.
        if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
          reasoningDetails.push(...delta.reasoning_details);
          if (!hadPlaintextReasoning) {
            for (const d of delta.reasoning_details) {
              const t = (d as { text?: unknown }).text;
              if (typeof t === 'string' && t.length > 0) {
                yield { kind: 'thinking_delta', text: t };
              }
            }
          }
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
            if (hasArgs) inProgress.partialArgs += argsChunk;

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
              yield { kind: 'tool_use_delta', id: inProgress.id, partial_args: argsChunk };
            }
          }
        }
      }

      if (typeof choice.finish_reason === 'string') {
        if (choice.finish_reason === 'error') {
          yield {
            kind: 'error',
            code: 'openrouter.stream_error',
            message: 'OpenRouter stream ended with finish_reason=error',
            retryable: false,
          };
          yield* emitUsage();
          return;
        }
        stopReason = FINISH_REASON_MAP[choice.finish_reason] ?? 'end_turn';
      }
    }

    // Emit the captured reasoning block (verbatim) before tool stops so it leads
    // the assistant turn, matching the ordering the ollama/anthropic adapters use.
    if (reasoningDetails.length > 0) {
      yield { kind: 'reasoning', provider: 'openrouter', data: reasoningDetails };
    }

    const sortedTools = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b);
    for (const [, tool] of sortedTools) {
      if (!tool.started) {
        yield {
          kind: 'error',
          code: 'openrouter.tool_use_no_name',
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
    yield* emitUsage();
  }
}
