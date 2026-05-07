import { GoogleGenAI } from '@google/genai';
import { deriveSeedFromRequest } from '../seed.ts';
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
  // The harness populates `name` on tool_result blocks specifically for
  // this case; if it's missing we fail loud instead of guessing.
  if (block.name === undefined || block.name.length === 0) {
    throw new Error(
      `tool_result block for ${block.tool_use_id} is missing the function name; Gemini correlates by name, so the harness must populate it`,
    );
  }
  return [
    {
      functionResponse: {
        name: block.name,
        response: { result: block.content },
      },
    },
  ];
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
    if (req.top_p !== undefined) config.topP = req.top_p;
    // Gemini 2.5+ exposes a thinking budget via
    // `thinkingConfig.thinkingBudget` (token count). Mirror the
    // Anthropic gating: 0 disables, which we encode by omitting
    // the block. Models that don't support thinking (1.x) ignore
    // the field; the SDK no-ops the unrecognized config key.
    if (req.thinking_budget !== undefined && req.thinking_budget > 0) {
      config.thinkingConfig = { thinkingBudget: req.thinking_budget };
    }
    // Determinism intent (`PLAYBOOKS.md` §1.1
    // `sampling.seed_in_eval`). Gemini accepts a seed in
    // `generationConfig.seed` (uint32-ish range) — derive a
    // stable seed from system + messages so replays of the
    // same conversation reproduce, and step N within a run
    // differs from step N+1 (message history grows / changes).
    if (req.seed_in_eval === true) config.seed = deriveSeedFromRequest(req);
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
