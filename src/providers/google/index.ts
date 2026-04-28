import { GoogleGenAI } from '@google/genai';
import type {
  ConstrainedRequest,
  GenerateRequest,
  Provider,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../types.ts';
import { GOOGLE_CAPS } from './capabilities.ts';
import { type RawGoogleChunk, normalizeGoogleStream } from './stream.ts';

export interface CreateGoogleProviderOptions {
  apiKey?: string;
  // Inject a pre-built SDK client (test seam).
  client?: GoogleGenAI;
}

interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

type GooglePart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: string } } };

const blockToParts = (block: ProviderContentBlock): GooglePart[] => {
  if (block.type === 'text') {
    return [{ text: block.text }];
  }
  if (block.type === 'tool_use') {
    return [{ functionCall: { name: block.name, args: block.input } }];
  }
  // tool_result: Gemini correlates by function name, not by tool_use_id.
  // The harness layer (Step 5) is the right place to resolve id->name; for
  // now we throw to surface this gap rather than silently corrupt history.
  throw new Error(
    'tool_result message blocks are not yet supported by the Gemini adapter ' +
      '(needs id->name resolution that lives in the harness; will land in M1 Step 5)',
  );
};

const toGoogleContent = (m: ProviderMessage): GoogleContent => {
  const role: GoogleContent['role'] = m.role === 'assistant' ? 'model' : 'user';
  if (typeof m.content === 'string') {
    return { role, parts: [{ text: m.content }] };
  }
  const parts = m.content.flatMap(blockToParts);
  return { role, parts };
};

const toGoogleTools = (
  tools: ProviderToolDef[],
): Array<{
  functionDeclarations: Array<{ name: string; description: string; parameters: unknown }>;
}> => [
  {
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
  },
];

export const createGoogleProvider = (
  modelName: string,
  options: CreateGoogleProviderOptions = {},
): Provider => {
  const caps = GOOGLE_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(`unknown Google model: ${modelName}`);
  }

  let client: GoogleGenAI;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'Google API key required (pass options.apiKey or set GOOGLE_API_KEY / GEMINI_API_KEY)',
      );
    }
    client = new GoogleGenAI({ apiKey });
  }

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    const contents = req.messages.map(toGoogleContent);
    const config: Record<string, unknown> = {
      maxOutputTokens: req.max_tokens,
    };
    if (req.system !== undefined) config.systemInstruction = req.system;
    if (req.temperature !== undefined) config.temperature = req.temperature;
    if (req.stop_sequences !== undefined) config.stopSequences = req.stop_sequences;
    if (req.tools !== undefined) config.tools = toGoogleTools(req.tools);

    const stream = await client.models.generateContentStream({
      model: modelName,
      contents,
      config,
    });
    yield* normalizeGoogleStream(stream as AsyncIterable<RawGoogleChunk>);
  };

  return {
    id: `google/${modelName}`,
    family: 'google',
    capabilities: caps,
    generate,
    generateConstrained: (_req: ConstrainedRequest): Promise<string> =>
      Promise.reject(new Error('generateConstrained not implemented in M1')),
    countTokens: async (messages: ProviderMessage[]): Promise<number> => {
      const response = await client.models.countTokens({
        model: modelName,
        contents: messages.map(toGoogleContent),
      });
      return response.totalTokens ?? 0;
    },
  };
};
