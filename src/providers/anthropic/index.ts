import Anthropic from '@anthropic-ai/sdk';
import type {
  ConstrainedRequest,
  GenerateRequest,
  Provider,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../types.ts';
import { ANTHROPIC_CAPS } from './capabilities.ts';
import { type RawAnthropicEvent, normalizeAnthropicStream } from './stream.ts';

export interface CreateAnthropicProviderOptions {
  apiKey?: string;
  // Inject a pre-built SDK client (test seam).
  client?: Anthropic;
}

// Strip `name` from tool_result blocks. Our canonical
// ProviderToolResultBlock keeps `name` as optional metadata for
// Gemini (which correlates results to calls by name). Anthropic
// only accepts `tool_use_id`/`content`/`is_error` and 400s with
// `Extra inputs are not permitted` if `name` leaks through.
const stripToolResultName = (block: ProviderContentBlock): ProviderContentBlock => {
  if (block.type !== 'tool_result') return block;
  const cleaned: ProviderContentBlock = {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
    content: block.content,
  };
  if (block.is_error !== undefined) cleaned.is_error = block.is_error;
  return cleaned;
};

const toAnthropicMessage = (
  m: ProviderMessage,
): { role: ProviderMessage['role']; content: ProviderMessage['content'] } => ({
  role: m.role,
  content: typeof m.content === 'string' ? m.content : m.content.map(stripToolResultName),
});

const toAnthropicTool = (t: ProviderToolDef): Anthropic.Tool => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
});

export const createAnthropicProvider = (
  modelName: string,
  options: CreateAnthropicProviderOptions = {},
): Provider => {
  const caps = ANTHROPIC_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(`unknown Anthropic model: ${modelName}`);
  }

  let client: Anthropic;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('Anthropic API key required (pass options.apiKey or set ANTHROPIC_API_KEY)');
    }
    client = new Anthropic({ apiKey });
  }

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    // The SDK's typed `messages.stream({...})` accepts our shape directly;
    // we cast the returned async iterable to the local minimal event type
    // (structural compatibility — the SDK's events are a superset).
    const stream = client.messages.stream({
      model: modelName,
      max_tokens: req.max_tokens,
      messages: req.messages.map(toAnthropicMessage),
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.tools !== undefined ? { tools: req.tools.map(toAnthropicTool) } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stop_sequences !== undefined ? { stop_sequences: req.stop_sequences } : {}),
      // metadata is intentionally not forwarded in M1: the SDK's MetadataParam
      // shape (`{ user_id?: string | null }`) is narrower than our generic
      // Record<string,string>; the harness will pass user identity through a
      // dedicated channel when telemetry needs it.
    });
    yield* normalizeAnthropicStream(stream as AsyncIterable<RawAnthropicEvent>);
  };

  return {
    id: `anthropic/${modelName}`,
    family: 'anthropic',
    capabilities: caps,
    generate,
    generateConstrained: (_req: ConstrainedRequest): Promise<string> =>
      // For Anthropic this would map to forced tool_choice, but the M1
      // autonomous loop does not call constrained generation. Implemented
      // when the DAG executor (M6) needs it.
      Promise.reject(new Error('generateConstrained not implemented in M1')),
    countTokens: async (messages: ProviderMessage[]): Promise<number> => {
      const response = await client.messages.countTokens({
        model: modelName,
        messages: messages.map(toAnthropicMessage),
      });
      return response.input_tokens;
    },
  };
};
