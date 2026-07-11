// LLM render path for `/recap slack`. Thin façade over the
// shared helper. Fidelity rule: every entry in `files` MUST
// appear in `intermediate.actions.filesWritten[].path` (same
// shape as `pr` — path-existence is the strongest grounding the
// renderer has against hallucination).

import type { Provider } from '../../providers/types.ts';
import type { RenderOptions } from '../format.ts';
import {
  type RenderViaLlmFailureReason,
  type RenderViaLlmResult,
  renderViaLlm,
} from '../llm-shared.ts';
import { buildSlackPromptV1 } from '../prompts/slack-v1.ts';
import type { RecapIntermediate } from '../types.ts';
import {
  SLACK_RENDER_V1_JSON_SCHEMA,
  type SlackRenderV1,
  validateSlackRenderV1,
} from './schema.ts';
import { renderSlackFromStructured } from './template.ts';

const FORCED_TOOL_NAME = 'render_recap_slack';
const MAX_OUTPUT_LINES = 30;

export interface RenderSlackViaLlmInput {
  intermediate: RecapIntermediate;
  provider: Provider;
  promptVersion: string;
  maxTokens?: number;
  templateOptions?: RenderOptions;
}

export type RenderSlackViaLlmFailureReason = RenderViaLlmFailureReason;
export type RenderSlackViaLlmResult = RenderViaLlmResult<SlackRenderV1>;

export const renderSlackViaLlm = async (
  input: RenderSlackViaLlmInput,
): Promise<RenderSlackViaLlmResult> => {
  const { intermediate, provider } = input;
  const prompt = buildSlackPromptV1(intermediate);
  const knownPaths = new Set(intermediate.actions.filesWritten.map((f) => f.path));
  return renderViaLlm<SlackRenderV1>({
    provider,
    prompt,
    schemaName: FORCED_TOOL_NAME,
    schemaDescription:
      'Render the recap intermediate as a Slack-friendly status post shaped by the SlackRenderV1 schema.',
    jsonSchema: SLACK_RENDER_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
    validate: validateSlackRenderV1,
    fidelityCheck: (structured) => {
      const errors: string[] = [];
      structured.files.forEach((p, i) => {
        if (!knownPaths.has(p)) {
          errors.push(`files[${i}] '${p}' not in actions.filesWritten`);
        }
      });
      return { ok: errors.length === 0, errors };
    },
    template: (structured) => renderSlackFromStructured(structured, input.templateOptions ?? {}),
    maxOutputLines: MAX_OUTPUT_LINES,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  });
};
