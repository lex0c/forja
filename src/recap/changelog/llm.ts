// LLM render path for `/recap changelog`. Thin façade over the
// shared helper. The fidelity rule for changelog is loose
// compared to `pr` (no path-existence to assert against), so the
// check resolves to "ok" by default — schema enforcement plus
// the prompt's rules carry the burden. Keep the hook so a future
// fixture-based fidelity heuristic (e.g., bullet keyword overlap
// with the intermediate) can be wired in without touching the
// orchestration.

import type { Provider } from '../../providers/types.ts';
import type { RenderOptions } from '../format.ts';
import {
  type RenderViaLlmFailureReason,
  type RenderViaLlmResult,
  renderViaLlm,
} from '../llm-shared.ts';
import { buildChangelogPromptV1 } from '../prompts/changelog-v1.ts';
import type { RecapIntermediate } from '../types.ts';
import {
  CHANGELOG_RENDER_V1_JSON_SCHEMA,
  type ChangelogRenderV1,
  validateChangelogRenderV1,
} from './schema.ts';
import { renderChangelogFromStructured } from './template.ts';

const FORCED_TOOL_NAME = 'render_recap_changelog';
const MAX_OUTPUT_LINES = 40;

export interface RenderChangelogViaLlmInput {
  intermediate: RecapIntermediate;
  provider: Provider;
  promptVersion: string;
  maxTokens?: number;
  templateOptions?: RenderOptions;
}

export type RenderChangelogViaLlmFailureReason = RenderViaLlmFailureReason;
export type RenderChangelogViaLlmResult = RenderViaLlmResult<ChangelogRenderV1>;

export const renderChangelogViaLlm = async (
  input: RenderChangelogViaLlmInput,
): Promise<RenderChangelogViaLlmResult> => {
  const { intermediate, provider } = input;
  const prompt = buildChangelogPromptV1(intermediate);
  return renderViaLlm<ChangelogRenderV1>({
    provider,
    prompt,
    schemaName: FORCED_TOOL_NAME,
    schemaDescription:
      'Render the recap intermediate as a Keep a Changelog entry shaped by the ChangelogRenderV1 schema.',
    jsonSchema: CHANGELOG_RENDER_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
    validate: validateChangelogRenderV1,
    fidelityCheck: () => ({ ok: true, errors: [] }),
    template: (structured) =>
      renderChangelogFromStructured(structured, input.templateOptions ?? {}),
    maxOutputLines: MAX_OUTPUT_LINES,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
};
