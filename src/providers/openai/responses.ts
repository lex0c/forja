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

// ProviderMessage[] → Responses input items. Assistant tool calls become
// `function_call` items; tool results become `function_call_output` items;
// text becomes role-tagged message items. Tool outputs are emitted before new
// text so they read as answers to the prior calls (mirrors the Chat
// Completions converter ordering).
const toResponsesInput = (messages: ProviderMessage[]): unknown[] => {
  const items: unknown[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      items.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      continue;
    }
    const textParts: string[] = [];
    const toolCalls: unknown[] = [];
    const toolOutputs: unknown[] = [];
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
      } else {
        // tool_result
        toolOutputs.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: block.content,
        });
      }
    }
    items.push(...toolOutputs);
    if (m.role === 'assistant') {
      if (textParts.length > 0) items.push({ role: 'assistant', content: textParts.join('') });
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
): AsyncIterable<StreamEvent> =>
  (async function* () {
    const params: Record<string, unknown> = {
      model: modelName,
      input: toResponsesInput(req.messages),
      max_output_tokens: req.max_tokens,
      store: false,
      stream: true,
    };
    if (req.system !== undefined) params.instructions = req.system;
    if (req.tools !== undefined) params.tools = toResponsesTools(req.tools);
    if (promptCacheKey !== undefined) params.prompt_cache_key = promptCacheKey;
    if (promptCacheRetention !== undefined) params.prompt_cache_retention = promptCacheRetention;
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
  if (req.system !== undefined) params.instructions = req.system;
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
