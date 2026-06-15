import type OpenAI from 'openai';
import { OPENAI_REASONING_EFFORT } from '../effort.ts';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  GenerateRequest,
  ProviderCapabilities,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../types.ts';
import {
  type RawResponsesEvent,
  type RawResponsesUsage,
  normalizeResponsesStream,
  responsesUsageToCanonical,
} from './responses-stream.ts';

// The OpenAI **Responses API** path (`/v1/responses`), used for reasoning
// models (gpt-5.x). Chat Completions 400s on the tools+reasoning_effort
// combination for them ("use /v1/responses instead", live-verified), and the
// Responses API is OpenAI's recommended surface for agentic/tool-heavy flows —
// better reasoning quality and cache utilization. Forja drives it STATELESS
// (`store: false`, full input each turn) to keep its own session/resume model
// as the single source of truth.
//
// The request and stream shapes differ from Chat Completions: `input` items
// (not `messages`), `instructions` (not a system message), flat function
// tools, `reasoning.effort` (not `reasoning_effort`), `max_output_tokens`.
// Params are built as a plain object and cast at the SDK boundary, the same
// pragmatic seam the Chat Completions path uses.

// Reasoning models (the only consumers of this path) suppress markdown in
// their responses by default; the documented opt-in is the literal string
// `Formatting re-enabled` on the FIRST line of the developer message
// (`instructions` here). Forja's TUI renders assistant prose as GitHub-flavored
// markdown (render/markdown.ts), so without this the OpenAI output degrades to
// flat text — no code fences, backticked paths, or lists — unlike the Anthropic
// path. The marker is a constant prefix, so it doesn't disturb the cache prefix
// (stable across turns) or the prompt_cache_key (hash of req.system, unchanged).
const REASONING_MARKDOWN_MARKER = 'Formatting re-enabled';
const withMarkdownMarker = (system: string | undefined): string =>
  system !== undefined && system.length > 0
    ? `${REASONING_MARKDOWN_MARKER}\n${system}`
    : REASONING_MARKDOWN_MARKER;

// ProviderMessage[] → Responses input items. Assistant tool calls become
// `function_call` items; tool results become `function_call_output` items;
// text becomes role-tagged message items. Tool outputs are emitted before new
// text so they read as answers to the prior calls (mirrors the Chat
// Completions converter ordering).
const toResponsesInput = (messages: ProviderMessage[], reasoningReplay = false): unknown[] => {
  const items: unknown[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      items.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: unknown[] = [];
    const toolOutputs: unknown[] = [];
    const reasoningItems: unknown[] = [];
    let messagePhase: string | undefined;
    for (const block of m.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        toolOutputs.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      } else if (block.type === 'reasoning') {
        // Replay same-provider reasoning state when enabled; foreign-tagged +
        // flag-off → dropped (Phase 1 behavior).
        if (!reasoningReplay || block.provider !== 'openai') continue;
        const sentinel = block.data as { __forja_message_phase?: unknown } | null;
        if (
          sentinel !== null &&
          typeof sentinel === 'object' &&
          '__forja_message_phase' in sentinel
        ) {
          // Not a real reasoning item — the codex message `phase` carrier.
          // Re-stamp it onto the assistant message below instead of pushing it.
          if (typeof sentinel.__forja_message_phase === 'string') {
            messagePhase = sentinel.__forja_message_phase;
          }
        } else {
          // The captured reasoning output item, replayed VERBATIM (encrypted_
          // content / id / its own phase round-trip inside `data`). In stateless
          // mode (`store: false`) ONLY an item carrying `encrypted_content` can
          // be replayed; an item captured under a flag-OFF request never asked
          // for `include: ['reasoning.encrypted_content']`, so it lacks the
          // field and would 400 ("reasoning item ... without encrypted_content")
          // after a later flag flip — drop it rather than break the request.
          const item = block.data as { encrypted_content?: unknown } | null;
          if (
            item !== null &&
            typeof item === 'object' &&
            typeof item.encrypted_content === 'string' &&
            item.encrypted_content.length > 0
          ) {
            reasoningItems.push(block.data);
          }
        }
      }
    }
    items.push(...toolOutputs);
    if (m.role === 'assistant') {
      // Reasoning items come FIRST — before the assistant message and the tool
      // calls — mirroring the model's own output order (it reasons, THEN emits
      // the message / function_call) and the order the loop stores the blocks.
      // OpenAI's stateless replay rejects a reasoning item that is not directly
      // followed by the item it generated ("Item 'rs_…' of type 'reasoning' was
      // provided without its required following item"); hoisting the assistant
      // message ahead of the reasoning triggered that 400 — intermittently,
      // only on the turns that also emitted assistant text (the A/B's ~70%
      // providerError rate on the long-horizon chain).
      items.push(...reasoningItems);
      if (textParts.length > 0) {
        items.push({
          role: 'assistant',
          content: textParts.join(''),
          // Re-stamp the codex message phase so the assistant item round-trips
          // it (the harness rebuilds the message from text and would lose it).
          ...(messagePhase !== undefined ? { phase: messagePhase } : {}),
        });
      }
      items.push(...toolCalls);
    } else if (textParts.length > 0) {
      items.push({ role: 'user', content: textParts.join('') });
    }
  }
  return items;
};

// Responses function tools are FLAT (`{type, name, description, parameters}`),
// unlike Chat Completions' `{type:'function', function:{...}}` nesting.
const toResponsesTools = (tools: ProviderToolDef[]): unknown[] =>
  tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));

type CreateParam = Parameters<OpenAI['responses']['create']>[0];

export const generateViaResponses = (
  client: OpenAI,
  modelName: string,
  caps: ProviderCapabilities,
  req: GenerateRequest,
  // Cache-routing hint computed by the factory (gated on a real-OpenAI
  // baseURL); passed in rather than imported to avoid an index.ts cycle.
  promptCacheKey?: string,
  // Extended cache retention ('24h'), likewise resolved by the factory
  // (real OpenAI + capability). Undefined → the param is omitted.
  promptCacheRetention?: string,
  // Replay captured reasoning items as input + request encrypted_content so
  // reasoning persists across tool round-trips (factory-resolved: real OpenAI +
  // FORJA_OPENAI_REASONING_REPLAY). Default OFF.
  reasoningReplay = false,
): AsyncIterable<StreamEvent> =>
  (async function* () {
    const params: Record<string, unknown> = {
      model: modelName,
      input: toResponsesInput(req.messages, reasoningReplay),
      max_output_tokens: req.max_tokens,
      store: false,
      stream: true,
    };
    // Always set instructions (at least the markdown marker) — see
    // withMarkdownMarker. Reasoning models would otherwise emit flat text.
    params.instructions = withMarkdownMarker(req.system);
    if (req.tools !== undefined) params.tools = toResponsesTools(req.tools);
    if (promptCacheKey !== undefined) params.prompt_cache_key = promptCacheKey;
    if (promptCacheRetention !== undefined) params.prompt_cache_retention = promptCacheRetention;
    // Ask the API to attach the encrypted reasoning payload to output items so a
    // captured item carries what a later replay needs (stateless, store:false).
    if (reasoningReplay) params.include = ['reasoning.encrypted_content'];
    // Reasoning effort — the whole reason this path exists. `reasoning.effort`
    // (not the flat `reasoning_effort`), gated on the capability. No
    // temperature/top_p: reasoning models reject them (sampling gate).
    if (req.effort !== undefined && caps.supports_reasoning_effort === true) {
      params.reasoning = { effort: OPENAI_REASONING_EFFORT[req.effort] };
    }
    const stream = (await client.responses.create(
      params as unknown as CreateParam,
    )) as unknown as AsyncIterable<RawResponsesEvent>;
    yield* normalizeResponsesStream(stream);
  })();

export const generateConstrainedViaResponses = async (
  client: OpenAI,
  modelName: string,
  _caps: ProviderCapabilities,
  req: ConstrainedRequest,
  promptCacheKey?: string,
  promptCacheRetention?: string,
): Promise<ConstrainedResult> => {
  if (req.tools !== undefined && req.tools.length > 0) {
    throw new Error(
      "openai (responses) generateConstrained: 'tools' must be empty (forced schema tool only)",
    );
  }
  const params: Record<string, unknown> = {
    model: modelName,
    input: toResponsesInput(req.messages),
    max_output_tokens: req.max_tokens,
    store: false,
    tools: [
      {
        type: 'function',
        name: req.output_schema_name,
        description:
          req.output_schema_description ??
          'Emit the structured output for the constrained request.',
        parameters: req.output_schema,
      },
    ],
    tool_choice: { type: 'function', name: req.output_schema_name },
  };
  params.instructions = withMarkdownMarker(req.system);
  if (promptCacheKey !== undefined) params.prompt_cache_key = promptCacheKey;
  if (promptCacheRetention !== undefined) params.prompt_cache_retention = promptCacheRetention;
  // Reasoning is intentionally omitted (default) — a structured render doesn't
  // need deep reasoning, and omitting it is faster/cheaper (mirrors the
  // Anthropic constrained path, which forwards no thinking).

  const response = (await client.responses.create(params as unknown as CreateParam)) as unknown as {
    output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }>;
    usage?: RawResponsesUsage | null;
    status?: string;
    incomplete_details?: { reason?: string } | null;
  };

  const call = response.output?.find(
    (o) => o.type === 'function_call' && o.name === req.output_schema_name,
  );
  if (call?.arguments === undefined) {
    // Surface the cause (status / incomplete reason) rather than a bare miss —
    // e.g. `incomplete` + `max_output_tokens` = ran out before the call.
    const why = response.incomplete_details?.reason ?? response.status ?? 'unknown';
    throw new Error(
      `openai (responses) constrained: model returned no function_call for forced tool '${req.output_schema_name}' (status=${why})`,
    );
  }
  return { output: call.arguments, usage: responsesUsageToCanonical(response.usage ?? {}) };
};
