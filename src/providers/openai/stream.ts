import type { StopReason, StreamEvent, UsageInfo } from '../types.ts';

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

// Usage object that OpenAI emits in the **final** chunk when the request was
// made with `stream_options: { include_usage: true }`. The provider opts
// in by default; absent usage means the user's compatibility endpoint
// (Azure, OpenRouter, etc) ignored the flag — we still emit a `usage`
// event with zeros so downstream consumers always see one row per turn.
export interface RawOpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // Recent OpenAI API exposes cached input via `prompt_tokens_details`.
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface RawOpenAIChunk {
  id?: string;
  choices?: RawOpenAIChoice[];
  usage?: RawOpenAIUsage | null;
}

interface ToolCallInProgress {
  // Locked at the first delta for this `index`. We commit to whatever id
  // we have at start time — synthesized or real — and never replace it,
  // because `tool_use_start` was already yielded with that id and the
  // harness's name lookup keys on it. Mutating id mid-stream orphans
  // the downstream tool_use_stop in `harness/collect.ts`.
  id: string;
  name: string;
  partialArgs: string;
  // `tool_use_start` is deferred until we have a non-empty `name`. OpenAI
  // can split the name across deltas; emitting start with name='' would
  // make the harness invoke a tool with empty name (`unknown tool` error)
  // even when a later delta supplies the real name. Once started, `name`
  // is locked and `partialArgs` is flushed as a single delta.
  started: boolean;
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
  // Accumulate raw counters across the stream and split prompt-vs-cache
  // only at emit time. OpenAI normally emits usage in a single final
  // chunk, but compat endpoints / future SDK shifts could split the
  // report; per-chunk `?? 0` defaults would let a later partial usage
  // payload reset earlier values to zero. `Math.max` keeps the largest
  // observation. Cache writes aren't reported separately by OpenAI
  // (prompt_tokens_details only exposes reads), so cache_creation
  // stays at zero. `usageSeen` gates emission of the canonical event:
  // compat endpoints (older Azure, some proxies) silently drop
  // stream_options, so no usage chunk ever arrives — emitting a
  // synthetic zero would confuse "no telemetry" with "measured zero".
  let rawPrompt = 0;
  let rawCompletion = 0;
  let rawCached = 0;
  let usageSeen = false;

  for await (const chunk of raw) {
    if (!messageStarted) {
      yield { kind: 'start', message_id: chunk.id ?? synthesizeMessageId() };
      messageStarted = true;
    }

    if (chunk.usage !== undefined && chunk.usage !== null) {
      const u = chunk.usage;
      // Field-level detection: a usage object that's present but missing
      // every token field (compat endpoint that returns `usage: {}`, or
      // a malformed proxy response) is NOT measurement.
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
            // Register the entry but DON'T emit start yet — name may
            // arrive in a later delta. id is locked here regardless.
            const id = tc.id ?? `call_${tc.index}_${crypto.randomUUID()}`;
            const name = tc.function?.name ?? '';
            inProgress = { id, name, partialArgs: '', started: false };
            toolCalls.set(tc.index, inProgress);
          } else if (
            typeof tc.function?.name === 'string' &&
            tc.function.name.length > 0 &&
            inProgress.name.length === 0
          ) {
            // Name straggled in. id stays locked from the first delta.
            inProgress.name = tc.function.name;
          }

          // Always buffer args; we may not be started yet.
          const argsChunk = tc.function?.arguments;
          const hasArgs = typeof argsChunk === 'string' && argsChunk.length > 0;
          if (hasArgs) {
            inProgress.partialArgs += argsChunk;
          }

          // Emit start the moment we have a name. Flush whatever args
          // we've buffered as a single delta so consumers that mirror
          // partial_args chunks see the same byte stream they would
          // have seen if the name had arrived first.
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

  // Close out tool_use blocks. OpenAI doesn't emit a per-tool stop, so we
  // parse and emit at end-of-stream, ordered by the original tool_call index.
  const sortedTools = Array.from(toolCalls.entries()).sort(([a], [b]) => a - b);
  for (const [, tool] of sortedTools) {
    if (!tool.started) {
      // Name never arrived. Emitting tool_use_stop without a matching
      // start would orphan in `harness/collect.ts`. Surface as an error
      // so the harness fails the step instead of silently dropping.
      yield {
        kind: 'error',
        code: 'openai.tool_use_no_name',
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
  if (usageSeen) {
    // OpenAI's `prompt_tokens` is the full prompt count *including*
    // the cached portion. Split here so `input` matches Anthropic's
    // semantics (non-cached input tokens) and cost math composes the
    // same way across providers.
    const usage: UsageInfo = {
      input: Math.max(0, rawPrompt - rawCached),
      output: rawCompletion,
      cache_read: rawCached,
      cache_creation: 0,
    };
    yield { kind: 'usage', usage };
  }
  yield { kind: 'stop', reason: stopReason };
}
