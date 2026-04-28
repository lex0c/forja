import type { StopReason, StreamEvent, UsageInfo } from '../types.ts';

// Minimal structural subset of a Gemini streaming chunk that we read.
// Defined locally so tests can construct chunks without touching the SDK
// type surface; real SDK chunks are structurally compatible.
export interface RawGooglePart {
  text?: string;
  thought?: boolean;
  // `thoughtSummary` and `thinkingText` shapes vary by SDK version; we read
  // `text` when `thought === true`, matching the current SDK.
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
}

export interface RawGoogleCandidate {
  content?: {
    role?: string;
    parts?: RawGooglePart[];
  };
  finishReason?: string | null;
}

// Gemini reports per-turn token counts via `usageMetadata` on the final
// chunk. `cachedContentTokenCount` is the cache-hit portion of the
// prompt; `promptTokenCount` is the FULL prompt count (cached included),
// matching OpenAI semantics — we split so `input` means non-cached.
export interface RawGoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

export interface RawGoogleChunk {
  responseId?: string;
  candidates?: RawGoogleCandidate[];
  usageMetadata?: RawGoogleUsageMetadata;
}

const FINISH_REASON_MAP: Readonly<Record<string, StopReason>> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  TOOL_CALLS: 'tool_use',
  // legacy spelling some SDK versions emit
  FUNCTION_CALL: 'tool_use',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
  // FINISH_REASON_UNSPECIFIED, OTHER -> default
};

const mapFinishReason = (raw: string): StopReason => FINISH_REASON_MAP[raw] ?? 'end_turn';

const synthesizeMessageId = (): string => `gemini_${crypto.randomUUID()}`;

// Convert a stream of Gemini raw chunks into the canonical StreamEvent shape
// from CONTRACTS.md §4. Differences from Anthropic worth noting:
//   - Gemini has no message_start/stop frames; we synthesize a `start` on the
//     first chunk and emit `stop` after the loop ends.
//   - Function calls arrive as a single complete part per chunk (not chunked
//     deltas), so tool_use_start/_delta/_stop are emitted back-to-back from
//     one Gemini part instead of being reconstructed across many deltas.
//   - Function calls have no provider-side id; we synthesize one. The harness
//     must map this id back when constructing tool_results.
export async function* normalizeGoogleStream(
  raw: AsyncIterable<RawGoogleChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let stopReason: StopReason = 'end_turn';
  let toolCallCounter = 0;
  // Accumulate the final usageMetadata seen during the stream. Gemini
  // reports cumulative counts, so the LAST chunk is authoritative.
  // cache_creation isn't a Gemini concept (its cache is server-persistent
  // and pre-warmed via a separate API), so we leave it at zero.
  // `usageSeen` gates emission of the canonical `usage` event: older
  // SDK responses can omit usageMetadata entirely; in that case we want
  // the harness to record NULL, not 0.
  const usage: UsageInfo = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  let usageSeen = false;

  for await (const chunk of raw) {
    if (chunk.usageMetadata !== undefined) {
      const u = chunk.usageMetadata;
      const cached = u.cachedContentTokenCount ?? 0;
      const prompt = u.promptTokenCount ?? 0;
      usage.input = Math.max(0, prompt - cached);
      usage.cache_read = cached;
      usage.output = u.candidatesTokenCount ?? 0;
      usageSeen = true;
    }
    if (!messageStarted) {
      yield { kind: 'start', message_id: chunk.responseId ?? synthesizeMessageId() };
      messageStarted = true;
    }

    const candidate = chunk.candidates?.[0];
    if (candidate === undefined) continue;

    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      if (part.functionCall !== undefined) {
        const fc = part.functionCall;
        const id = fc.id ?? `call_${++toolCallCounter}_${crypto.randomUUID()}`;
        yield { kind: 'tool_use_start', id, name: fc.name };
        const args = fc.args ?? {};
        // Gemini delivers args complete; emit a single delta carrying the
        // serialized JSON so consumers that subscribe to deltas still see
        // the data, then close with the parsed object.
        yield { kind: 'tool_use_delta', id, partial_args: JSON.stringify(args) };
        yield { kind: 'tool_use_stop', id, final_args: args };
      } else if (part.thought === true && typeof part.text === 'string') {
        yield { kind: 'thinking_delta', text: part.text };
      } else if (typeof part.text === 'string') {
        yield { kind: 'text_delta', text: part.text };
      }
    }

    if (typeof candidate.finishReason === 'string') {
      stopReason = mapFinishReason(candidate.finishReason);
    }
  }

  // Edge case: empty stream. Still emit a start+stop so the consumer sees a
  // well-formed sequence (matches the canonical contract).
  if (!messageStarted) {
    yield { kind: 'start', message_id: synthesizeMessageId() };
  }
  if (usageSeen) yield { kind: 'usage', usage };
  yield { kind: 'stop', reason: stopReason };
}
