// LLM render path for `/recap terse`. Thin façade. Fidelity rule
// is intentionally permissive — a one-sentence summary cannot be
// ground-truth-checked against specific paths or counts without
// false positives. The schema cap (200 chars) plus the prompt's
// rules carry the burden; the bigger renderers (pr, slack) do the
// heavy fidelity lifting via path-existence.

import type { Provider } from '../../providers/types.ts';
import {
  type RenderViaLlmFailureReason,
  type RenderViaLlmResult,
  renderViaLlm,
} from '../llm-shared.ts';
import { buildTersePromptV1 } from '../prompts/terse-v1.ts';
import type { RecapIntermediate } from '../types.ts';
import {
  TERSE_RENDER_V1_JSON_SCHEMA,
  type TerseRenderV1,
  validateTerseRenderV1,
} from './schema.ts';
import { renderTerseFromStructured } from './template.ts';

const FORCED_TOOL_NAME = 'render_recap_terse';
// Single sentence + trailing newline — the cap is generous to
// absorb edge cases (multi-byte chars in the sentence, embedded
// ASCII art the prompt explicitly forbids, etc.).
const MAX_OUTPUT_LINES = 4;
// Smaller token budget than other renderers — the schema-bound
// output is one short string. 256 is plenty.
const DEFAULT_TERSE_MAX_TOKENS = 256;

export interface RenderTerseViaLlmInput {
  intermediate: RecapIntermediate;
  provider: Provider;
  promptVersion: string;
  maxTokens?: number;
}

export type RenderTerseViaLlmFailureReason = RenderViaLlmFailureReason;
export type RenderTerseViaLlmResult = RenderViaLlmResult<TerseRenderV1>;

export const renderTerseViaLlm = async (
  input: RenderTerseViaLlmInput,
): Promise<RenderTerseViaLlmResult> => {
  const { intermediate, provider } = input;
  const prompt = buildTersePromptV1(intermediate);
  return renderViaLlm<TerseRenderV1>({
    provider,
    prompt,
    schemaName: FORCED_TOOL_NAME,
    schemaDescription:
      'Render the recap intermediate as a single-sentence summary shaped by the TerseRenderV1 schema.',
    jsonSchema: TERSE_RENDER_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
    validate: validateTerseRenderV1,
    fidelityCheck: () => ({ ok: true, errors: [] }),
    template: renderTerseFromStructured,
    maxOutputLines: MAX_OUTPUT_LINES,
    maxTokens: input.maxTokens ?? DEFAULT_TERSE_MAX_TOKENS,
  });
};
