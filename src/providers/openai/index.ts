import OpenAI from 'openai';
import type {
  ConstrainedRequest,
  GenerateRequest,
  Provider,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../types.ts';
import { OPENAI_CAPS } from './capabilities.ts';
import { type RawOpenAIChunk, normalizeOpenAIStream } from './stream.ts';

export interface CreateOpenAIProviderOptions {
  apiKey?: string;
  // Useful for OpenAI-compatible endpoints (Azure OpenAI, OpenRouter, etc.).
  baseURL?: string;
  // Inject a pre-built SDK client (test seam).
  client?: OpenAI;
  // Send `stream_options: { include_usage: true }` so the final chunk
  // carries token counts. OpenAI itself supports this since 2024; some
  // OpenAI-compatible endpoints (older Azure deployments, certain proxies)
  // reject unknown params with HTTP 400. Set this to `false` if you hit
  // that — cost tracking will report zeros, but the run will succeed.
  // When omitted, falls back to the FORJA_OPENAI_INCLUDE_USAGE env var
  // so users on the CLI path (where the registry factory is invoked
  // with no options) can still opt out without code changes.
  includeUsage?: boolean;
}

// Resolve the `includeUsage` default from the environment for callers
// who don't pass an explicit option (notably the registry factory used
// by the CLI bootstrap, which forwards no options today). Truthy by
// default; recognized falsy strings disable the param.
const includeUsageFromEnv = (): boolean => {
  const v = process.env.FORJA_OPENAI_INCLUDE_USAGE;
  if (v === undefined || v === '') return true;
  const norm = v.toLowerCase();
  return !(norm === '0' || norm === 'false' || norm === 'no' || norm === 'off');
};

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

// One ProviderMessage may map to several OpenAI messages: assistant turns
// with tool_use blocks become an assistant message + tool_use, and user
// turns containing tool_result blocks split into one `role: 'tool'`
// message per result. OpenAI requires tool results to be their own
// messages, not nested in user content.
//
// Ordering matters: when a user message mixes tool_results and text, the
// tool_results come first (they answer the prior assistant call) and the
// new user text follows. Emitting text first would make the model see a
// new user prompt before the tool results it requested.
const toOpenAIMessages = (m: ProviderMessage): OpenAIMessage[] => {
  if (typeof m.content === 'string') {
    return [{ role: m.role, content: m.content }];
  }

  const out: OpenAIMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  const toolResults: OpenAIMessage[] = [];

  for (const block of m.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (m.role !== 'assistant') {
        throw new Error('tool_use blocks must appear on assistant messages');
      }
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    } else {
      // tool_result
      if (m.role !== 'user') {
        throw new Error('tool_result blocks must appear on user messages');
      }
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: block.content,
      });
    }
  }

  // Tool results come first so they read as the answer to the prior
  // assistant turn, not as something the user volunteered after speaking.
  out.push(...toolResults);

  if (m.role === 'assistant') {
    const content = textParts.length > 0 ? textParts.join('') : null;
    if (content !== null || toolCalls.length > 0) {
      const msg: OpenAIMessage = { role: 'assistant', content };
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  } else if (textParts.length > 0) {
    out.push({ role: 'user', content: textParts.join('') });
  }

  return out;
};

const toOpenAITools = (
  tools: ProviderToolDef[],
): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}> =>
  tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

// chars/4 heuristic for token counting. OpenAI has no server-side
// countTokens endpoint (unlike Anthropic and Google); a proper local impl
// uses tiktoken. M5 will wire that. The heuristic is within ~10% for
// English text, which is good enough for budget early-warning thresholds.
const heuristicTokenCount = (messages: ProviderMessage[]): number => {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text') chars += block.text.length;
      else if (block.type === 'tool_use') {
        chars += block.name.length + JSON.stringify(block.input).length;
      } else {
        chars += block.content.length + block.tool_use_id.length;
      }
    }
  }
  return Math.ceil(chars / 4);
};

export const createOpenAIProvider = (
  modelName: string,
  options: CreateOpenAIProviderOptions = {},
): Provider => {
  const caps = OPENAI_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(`unknown OpenAI model: ${modelName}`);
  }

  let client: OpenAI;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('OpenAI API key required (pass options.apiKey or set OPENAI_API_KEY)');
    }
    const sdkOpts: { apiKey: string; baseURL?: string } = { apiKey };
    if (options.baseURL !== undefined) sdkOpts.baseURL = options.baseURL;
    client = new OpenAI(sdkOpts);
  }

  const includeUsage = options.includeUsage ?? includeUsageFromEnv();

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    const messages: OpenAIMessage[] = [];
    if (req.system !== undefined) {
      messages.push({ role: 'system', content: req.system });
    }
    for (const m of req.messages) {
      messages.push(...toOpenAIMessages(m));
    }

    const params: Record<string, unknown> = {
      model: modelName,
      messages,
      stream: true,
      max_tokens: req.max_tokens,
    };
    if (includeUsage) {
      // Opt into the final-chunk usage payload so we can compute cost.
      // Documented as configurable in CreateOpenAIProviderOptions because
      // some compat endpoints reject the param outright.
      params.stream_options = { include_usage: true };
    }
    if (req.tools !== undefined) params.tools = toOpenAITools(req.tools);
    if (req.temperature !== undefined) params.temperature = req.temperature;
    if (req.stop_sequences !== undefined) params.stop = req.stop_sequences;

    const stream = (await client.chat.completions.create(
      params as unknown as Parameters<typeof client.chat.completions.create>[0],
    )) as AsyncIterable<RawOpenAIChunk>;
    yield* normalizeOpenAIStream(stream);
  };

  return {
    id: `openai/${modelName}`,
    family: 'openai',
    capabilities: caps,
    generate,
    generateConstrained: (_req: ConstrainedRequest): Promise<string> =>
      Promise.reject(new Error('generateConstrained not implemented in M1')),
    countTokens: (messages: ProviderMessage[]): Promise<number> =>
      Promise.resolve(heuristicTokenCount(messages)),
  };
};
