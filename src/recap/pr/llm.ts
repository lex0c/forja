// LLM render path for `/recap pr`. The deterministic projection
// (deterministic.ts) is the fallback floor; this module is the
// "make it dense" layer on top.
//
// Contract: never throws. On any failure (provider down, missing
// capability, schema violation, fidelity mismatch) returns a
// `{ ok: false, reason }` shape so the caller can fall back to
// the deterministic path and surface a single warn line. The
// recap is the operator's primary product; an LLM hiccup must
// degrade gracefully, not abort.
//
// Fidelity (RECAP.md §7.4): two checks beyond schema validation
// catch the "hallucination" failure mode.
//   1. Every `changes[].path` MUST appear in
//      `intermediate.actions.filesWritten[].path`. The schema only
//      constrains shape; this check constrains content.
//   2. Total markdown size capped at 80 lines. The renderer can
//      produce arbitrarily long bullets within the per-field
//      char caps; this is the concision floor (also from §7.4).

import { computeCost } from '../../providers/cost.ts';
import type { Provider, UsageInfo } from '../../providers/types.ts';
import { buildPrPromptV1 } from '../prompts/pr-v1.ts';
import type { RecapIntermediate } from '../types.ts';
import {
  PR_RENDER_V1_JSON_SCHEMA,
  PR_SCHEMA_VERSION,
  type PrRenderV1,
  validatePrRenderV1,
} from './schema.ts';
import { renderPrFromStructured } from './template.ts';

const FORCED_TOOL_NAME = 'render_recap_pr';
const DEFAULT_MAX_TOKENS = 2_048;
const MAX_OUTPUT_LINES = 80;

export interface RenderPrViaLlmInput {
  intermediate: RecapIntermediate;
  provider: Provider;
  promptVersion: string;
  maxTokens?: number;
}

export type RenderPrViaLlmFailureReason =
  | 'capability-missing'
  | 'provider-error'
  | 'invalid-json'
  | 'schema-violation'
  | 'fidelity-mismatch'
  | 'concision-violation';

export type RenderPrViaLlmResult =
  | {
      ok: true;
      output: string;
      structured: PrRenderV1;
      usage: UsageInfo;
      costUsd: number;
    }
  | {
      ok: false;
      reason: RenderPrViaLlmFailureReason;
      detail: string;
    };

const fidelityCheck = (
  structured: PrRenderV1,
  intermediate: RecapIntermediate,
): { ok: boolean; errors: string[] } => {
  const knownPaths = new Set(intermediate.actions.filesWritten.map((f) => f.path));
  const errors: string[] = [];
  structured.changes.forEach((c, i) => {
    if (!knownPaths.has(c.path)) {
      errors.push(`changes[${i}].path '${c.path}' not in actions.filesWritten`);
    }
  });
  return { ok: errors.length === 0, errors };
};

export const renderPrViaLlm = async (input: RenderPrViaLlmInput): Promise<RenderPrViaLlmResult> => {
  const { intermediate, provider, promptVersion } = input;
  // Capability gate. Providers that have not implemented
  // generateConstrained (or that return `false` for `constrained`)
  // bypass the call entirely — `Promise.reject` would also do the
  // job but pre-flighting here saves a try/catch round trip.
  if (provider.capabilities.constrained === false) {
    return {
      ok: false,
      reason: 'capability-missing',
      detail: `provider ${provider.id} does not support constrained generation`,
    };
  }

  const { system, user } = buildPrPromptV1(intermediate);
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  let raw: string;
  let usage: UsageInfo;
  try {
    const result = await provider.generateConstrained({
      // model is informational; the provider was constructed for a
      // specific model, but the contract still asks for it. Using
      // the provider's id strips the family prefix below.
      model: provider.id.replace(/^[^/]+\//, ''),
      messages: [{ role: 'user', content: user }],
      system,
      max_tokens: maxTokens,
      output_schema: PR_RENDER_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
      output_schema_name: FORCED_TOOL_NAME,
      output_schema_description:
        'Render the recap intermediate as a PR description shaped by the PrRenderV1 schema.',
    });
    raw = result.output;
    usage = result.usage;
  } catch (e) {
    return {
      ok: false,
      reason: 'provider-error',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid-json',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  const validation = validatePrRenderV1(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'schema-violation',
      detail: validation.errors.join('; '),
    };
  }

  // The schema-bound parse + cast. validatePrRenderV1 narrowed
  // structurally; we still re-state the schemaVersion to match
  // the pinned literal type since the validator uses string
  // comparison to cover both legitimate and tampered inputs.
  const structured: PrRenderV1 = {
    ...(parsed as PrRenderV1),
    schemaVersion: PR_SCHEMA_VERSION,
  };

  const fidelity = fidelityCheck(structured, intermediate);
  if (!fidelity.ok) {
    return {
      ok: false,
      reason: 'fidelity-mismatch',
      detail: fidelity.errors.join('; '),
    };
  }

  const output = renderPrFromStructured(structured);
  const lineCount = output.split('\n').length;
  if (lineCount > MAX_OUTPUT_LINES) {
    return {
      ok: false,
      reason: 'concision-violation',
      detail: `output ${lineCount} lines exceeds limit ${MAX_OUTPUT_LINES}`,
    };
  }

  // promptVersion is recorded by the caller in audit / cache rows;
  // we accept it as input rather than reading from the prompt
  // module to keep this layer prompt-agnostic.
  void promptVersion;

  const costUsd = computeCost(provider.capabilities, usage);
  return { ok: true, output, structured, usage, costUsd };
};
