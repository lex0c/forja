// LLM render path for `/recap` (default human surface). Thin
// façade over the shared helper. Fidelity check is permissive —
// the bullets are prose distillation, not reference to specific
// fields, so path-existence-style fidelity does not apply. The
// schema cap (1–5 bullets, ≤200 chars each) plus the prompt's
// hard rules carry the burden.

import type { Provider } from '../../providers/types.ts';
import type { RenderOptions } from '../format.ts';
import {
  type RenderViaLlmFailureReason,
  type RenderViaLlmResult,
  renderViaLlm,
} from '../llm-shared.ts';
import { buildHumanPromptV1 } from '../prompts/human-v1.ts';
import type { RecapIntermediate } from '../types.ts';
import {
  HUMAN_RENDER_V1_JSON_SCHEMA,
  type HumanRenderV1,
  validateHumanRenderV1,
} from './schema.ts';
import { renderHumanFromStructured } from './template.ts';

const FORCED_TOOL_NAME = 'render_recap_human';
const MAX_OUTPUT_LINES = 200;

export interface RenderHumanViaLlmInput {
  intermediate: RecapIntermediate;
  provider: Provider;
  promptVersion: string;
  maxTokens?: number;
  templateOptions?: RenderOptions;
}

export type RenderHumanViaLlmFailureReason = RenderViaLlmFailureReason;
export type RenderHumanViaLlmResult = RenderViaLlmResult<HumanRenderV1>;

export const renderHumanViaLlm = async (
  input: RenderHumanViaLlmInput,
): Promise<RenderHumanViaLlmResult> => {
  const { intermediate, provider } = input;
  const prompt = buildHumanPromptV1(intermediate);
  return renderViaLlm<HumanRenderV1>({
    provider,
    prompt,
    schemaName: FORCED_TOOL_NAME,
    schemaDescription:
      'Render the `## Resumo` bullets for the human recap. Schema-bound; only the summary array is filled.',
    jsonSchema: HUMAN_RENDER_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
    validate: validateHumanRenderV1,
    fidelityCheck: () => ({ ok: true, errors: [] }),
    template: (structured) =>
      renderHumanFromStructured(structured, intermediate, input.templateOptions ?? {}),
    maxOutputLines: MAX_OUTPUT_LINES,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
};
