import { GoogleGenAI } from '@google/genai';
import { effortThinkingBudget } from '../effort.ts';
import { deriveSeedFromRequest } from '../seed.ts';
import type {
  ConstrainedRequest,
  ConstrainedResult,
  GenerateRequest,
  Provider,
  ProviderCapabilities,
  ProviderContentBlock,
  ProviderMessage,
  ProviderToolDef,
  StreamEvent,
} from '../types.ts';
import { GOOGLE_CAPS } from './capabilities.ts';

// Gemini thinking budget, gated by capability. Gemini 2.5's only
// reasoning knob is the numeric `thinkingConfig.thinkingBudget`, so
// the agnostic `effort` maps onto the canonical ladder
// (`src/providers/effort.ts`), clamped below max_tokens. Precedence:
// an EXPLICIT `thinking_budget: 0` (disable-via-zero, PLAYBOOKS.md
// §1.1) wins and disables thinking — `effort` must not resurrect it.
// Otherwise effort (when the model supports the surface) wins over a
// legacy numeric `thinking_budget`. The resolved value is then clamped
// to the model's `max_thinking_budget` ceiling (Gemini 2.5 400s above
// it): the loader allows large legacy `thinking_budget` values for
// provider-specific handling, so an over-cap 50000 is fitted, not
// rejected. Returns undefined ⇒ omit the block. (A future Gemini 3+
// uses named `thinkingLevel` instead and would need its own branch.)
export const googleThinkingBudget = (
  req: GenerateRequest,
  caps: ProviderCapabilities,
): number | undefined => {
  if (req.thinking_budget === 0) return undefined;
  let budget: number | undefined;
  if (req.effort !== undefined && caps.supports_reasoning_effort === true) {
    budget = effortThinkingBudget(req.effort, req.max_tokens);
  } else if (req.thinking_budget !== undefined && req.thinking_budget > 0) {
    budget = req.thinking_budget;
  }
  if (budget === undefined) return undefined;
  // Clamp to the model's thinking-budget ceiling. Applies to both
  // paths so it stays correct if the effort ladder ever rises above a
  // model cap; the legacy raw value is the one that actually exceeds.
  return caps.max_thinking_budget !== undefined
    ? Math.min(budget, caps.max_thinking_budget)
    : budget;
};

import { normalizeGoogleStream, type RawGoogleChunk } from './stream.ts';

export interface CreateGoogleProviderOptions {
  apiKey?: string;
  // Inject a pre-built SDK client (test seam).
  client?: GoogleGenAI;
  // Override capabilities — supplied by the catalog-file loader for an
  // operator-registered model. When omitted, capabilities resolve from
  // the static GOOGLE_CAPS catalog.
  capabilities?: ProviderCapabilities;
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
  // `reasoning` blocks are provider-tagged opaque state; Google has no native
  // surface for them and they're never tagged 'google', so drop (no parts).
  if (block.type === 'reasoning') {
    return [];
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
  const caps = options.capabilities ?? GOOGLE_CAPS[modelName];
  if (caps === undefined) {
    throw new Error(
      `unknown Google model: ${modelName} (pass options.capabilities or add it to GOOGLE_CAPS)`,
    );
  }

  let client: GoogleGenAI;
  if (options.client !== undefined) {
    client = options.client;
  } else {
    const apiKey = options.apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'Google API key required (pass options.apiKey; the catalog provides it from the model api_key_env in model_providers.json — no env fallback, GEMINI_API_KEY included)',
      );
    }
    client = new GoogleGenAI({ apiKey });
  }

  // Sampling gate (mirrors the Anthropic adapter). A model that deprecates
  // `temperature`/`top_p` at the API opts out via `supports_sampling: false`;
  // the adapter then omits both rather than risk an HTTP 400. Current Gemini
  // models accept sampling, so this is a no-op for them — but it keeps the
  // three adapters uniform and ready for a future thinking-only Gemini.
  const acceptsSampling = caps.supports_sampling !== false;

  const generate = async function* (req: GenerateRequest): AsyncIterable<StreamEvent> {
    const contents = req.messages.map(toGoogleContent);
    const config: Record<string, unknown> = {
      maxOutputTokens: req.max_tokens,
    };
    if (req.system !== undefined) config.systemInstruction = req.system;
    if (acceptsSampling && req.temperature !== undefined) config.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) config.topP = req.top_p;
    // Reasoning effort / thinking budget via the numeric
    // `thinkingConfig.thinkingBudget` knob — see `googleThinkingBudget`
    // for the precedence (explicit disable-via-zero > effort > legacy
    // budget). Models without thinking (1.x) ignore the key.
    const thinkingBudget = googleThinkingBudget(req, caps);
    if (thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget };
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

  // Structured output via FORCED function calling, mirroring the Anthropic /
  // OpenAI paths: declare ONE function whose parameters are the desired JSON
  // schema and pin `functionCallingConfig.mode = 'ANY'` with an allowlist of
  // the one name, so the model MUST emit exactly that functionCall. Forced
  // function calling, NOT `responseSchema` + `responseMimeType`, for leniency:
  // responseSchema accepts only an OpenAPI subset and rejects some JSON Schema
  // keywords the recap schemas use. Single round-trip (non-streaming).
  const generateConstrained = async (req: ConstrainedRequest): Promise<ConstrainedResult> => {
    if (req.tools !== undefined && req.tools.length > 0) {
      throw new Error(
        "google generateConstrained: 'tools' must be empty (forced schema tool only)",
      );
    }
    const contents = req.messages.map(toGoogleContent);
    const config: Record<string, unknown> = {
      maxOutputTokens: req.max_tokens,
      tools: [
        {
          functionDeclarations: [
            {
              name: req.output_schema_name,
              description:
                req.output_schema_description ??
                'Emit the structured output for the constrained request.',
              parameters: req.output_schema,
            },
          ],
        },
      ],
      // Force exactly the schema function (no free-text, no other tool).
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [req.output_schema_name] },
      },
    };
    if (req.system !== undefined) config.systemInstruction = req.system;
    if (acceptsSampling && req.temperature !== undefined) config.temperature = req.temperature;
    if (acceptsSampling && req.top_p !== undefined) config.topP = req.top_p;

    const response = (await client.models.generateContent({
      model: modelName,
      contents,
      config,
    })) as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> };
      }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };

    // Forced mode returns exactly one matching functionCall. Walk defensively;
    // a miss is a hard error — the caller (recap render) has no fallback here.
    // Surface finishReason / blockReason so the likely causes are diagnosable
    // rather than hidden behind a generic message: MAX_TOKENS = the budget was
    // spent (thinking is ON by default on current Gemini models and counts
    // toward maxOutputTokens), SAFETY / a blockReason = the response was
    // filtered.
    const call = response.candidates?.[0]?.content?.parts
      ?.map((p) => p.functionCall)
      .find((fc) => fc?.name === req.output_schema_name);
    if (call?.args === undefined) {
      const finish = response.candidates?.[0]?.finishReason ?? 'unknown';
      const blocked = response.promptFeedback?.blockReason;
      throw new Error(
        `google constrained: model returned no functionCall for forced tool '${req.output_schema_name}' (finishReason=${finish}${blocked !== undefined ? `, blockReason=${blocked}` : ''})`,
      );
    }
    // Usage convention MATCHES the streaming path (google/stream.ts):
    // promptTokenCount INCLUDES cached, so input = prompt − cached; cache_read
    // = cached; Gemini reports no cache-write, so cache_creation = 0.
    const u = response.usageMetadata;
    const prompt = u?.promptTokenCount ?? 0;
    const cached = u?.cachedContentTokenCount ?? 0;
    return {
      output: JSON.stringify(call.args),
      usage: {
        input: Math.max(0, prompt - cached),
        output: u?.candidatesTokenCount ?? 0,
        cache_read: cached,
        cache_creation: 0,
      },
    };
  };

  return {
    id: `google/${modelName}`,
    family: 'google',
    capabilities: caps,
    generate,
    generateConstrained,
    countTokens: async (messages: ProviderMessage[]): Promise<number> => {
      const response = await client.models.countTokens({
        model: modelName,
        contents: messages.map(toGoogleContent),
      });
      return response.totalTokens ?? 0;
    },
  };
};
