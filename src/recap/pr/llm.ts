// LLM render path for `/recap pr`. Thin façade over
// `renderViaLlm<PrRenderV1>` from `../llm-shared.ts`; this module
// only expresses what is renderer-specific (schema, prompt,
// fidelity rule, template, line cap).
//
// Fidelity (RECAP.md §7.4): every `changes[].path` MUST appear
// in `intermediate.actions.filesWritten[].path`. The schema
// alone constrains shape; this check constrains content. The
// concision floor (≤80 lines) belongs to the shared helper but
// the value is renderer-specific, so it is passed in here.

import type { Provider } from '../../providers/types.ts';
import {
  type RenderViaLlmFailureReason,
  type RenderViaLlmResult,
  renderViaLlm,
} from '../llm-shared.ts';
import { buildPrPromptV1 } from '../prompts/pr-v1.ts';
import type { RecapIntermediate } from '../types.ts';
import { PR_RENDER_V1_JSON_SCHEMA, type PrRenderV1, validatePrRenderV1 } from './schema.ts';
import { renderPrFromStructured } from './template.ts';

const FORCED_TOOL_NAME = 'render_recap_pr';
const MAX_OUTPUT_LINES = 80;

export interface RenderPrViaLlmInput {
  intermediate: RecapIntermediate;
  provider: Provider;
  promptVersion: string;
  maxTokens?: number;
}

// Re-export the shared reason enum and result shape under the
// renderer-specific names so existing callers (slash command,
// tests) keep their imports valid without learning about the
// shared layer.
export type RenderPrViaLlmFailureReason = RenderViaLlmFailureReason;
export type RenderPrViaLlmResult = RenderViaLlmResult<PrRenderV1>;

export const renderPrViaLlm = async (input: RenderPrViaLlmInput): Promise<RenderPrViaLlmResult> => {
  const { intermediate, provider } = input;
  const prompt = buildPrPromptV1(intermediate);
  const knownPaths = new Set(intermediate.actions.filesWritten.map((f) => f.path));
  return renderViaLlm<PrRenderV1>({
    provider,
    prompt,
    schemaName: FORCED_TOOL_NAME,
    schemaDescription:
      'Render the recap intermediate as a PR description shaped by the PrRenderV1 schema.',
    jsonSchema: PR_RENDER_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
    validate: validatePrRenderV1,
    fidelityCheck: (structured) => {
      const errors: string[] = [];
      structured.changes.forEach((c, i) => {
        if (!knownPaths.has(c.path)) {
          errors.push(`changes[${i}].path '${c.path}' not in actions.filesWritten`);
        }
      });
      return { ok: errors.length === 0, errors };
    },
    template: renderPrFromStructured,
    maxOutputLines: MAX_OUTPUT_LINES,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
};
