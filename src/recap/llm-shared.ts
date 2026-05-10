// Shared LLM render orchestration. Slice (a) inlined this in
// `pr/llm.ts`; slice (b) introduces three more renderers
// (`changelog`, `slack`, `terse`) that need exactly the same
// pipeline — capability gate → forced-tool constrained call →
// JSON.parse → schema validation → fidelity check → concision
// check → markdown via deterministic template — over a different
// schema and a different fidelity rule. Triplicating the
// orchestration would scatter ~70 lines × 3 across the renderer
// modules; lifting it here keeps each renderer's `llm.ts` as a
// thin façade that only expresses what is renderer-specific
// (schema, prompt, fidelity, template).
//
// Contract: `renderViaLlm<T>` never throws. On any failure
// (provider down, missing capability, parse error, schema
// violation, fidelity mismatch, concision violation) it returns a
// `{ ok: false, reason }` shape so the caller can fall back to
// the deterministic path and surface a single warn line.

import { computeCost } from '../providers/cost.ts';
import type { Provider, UsageInfo } from '../providers/types.ts';

export type RenderViaLlmFailureReason =
  | 'capability-missing'
  | 'provider-error'
  | 'invalid-json'
  | 'schema-violation'
  | 'fidelity-mismatch'
  | 'concision-violation';

export type RenderViaLlmResult<T> =
  | { ok: true; output: string; structured: T; usage: UsageInfo; costUsd: number }
  | { ok: false; reason: RenderViaLlmFailureReason; detail: string };

export interface RenderViaLlmInput<T> {
  // Provider the LLM call goes to. Capability gate trips when
  // `provider.capabilities.constrained === false`.
  provider: Provider;
  // System + user prompt pair. The renderer-specific prompt
  // module builds these from the recap intermediate.
  prompt: { system: string; user: string };
  // Forced-tool name. Anthropic uses this both as the
  // `tool_choice.name` and the `tools[].name`. Must match
  // `^[a-z][a-z0-9_]{0,63}$` per provider naming rules; renderers
  // pin literal labels like `render_recap_pr`.
  schemaName: string;
  // Optional human-readable description handed to the provider as
  // the tool description. Helps the model pick the right shape
  // even with the tool forced.
  schemaDescription?: string;
  // JSON Schema for the structured output. Used by the provider
  // for native enforcement; the validator below is the
  // authoritative gate after parse.
  jsonSchema: Record<string, unknown>;
  // Manual validator that narrows `unknown` to T at runtime.
  // Returns `{ok: true}` only if the value is structurally a T
  // AND every per-field cap is respected.
  validate: (value: unknown) => { ok: boolean; errors: string[] };
  // Renderer-specific fidelity check. Runs after schema validation
  // and gets the parsed structured value plus whatever context
  // the renderer needs (typically the recap intermediate). A
  // fidelity violation falls back to deterministic — schema
  // alone cannot catch hallucinated values that fit the shape.
  // Empty `errors` ⇒ pass.
  fidelityCheck: (structured: T) => { ok: boolean; errors: string[] };
  // Render the validated structured value to markdown. The
  // template owns formatting; the LLM only fills slots.
  template: (structured: T) => string;
  // Concision floor: max line count for the rendered output.
  // RECAP §7.4 declares 100% concision; per-renderer caps live
  // in the renderer-specific module.
  maxOutputLines: number;
  // Cap for the constrained call's `max_tokens`. Optional with a
  // sensible default; renderers can lower it for terse output.
  maxTokens?: number;
}

// TOKEN_TUNING §9 canonical sampling for `recap (LLM render)`:
// `temperature: 0.2, top_p: 0.95, max_tokens: 4096, thinking off,
// seed_in_eval: yes`. Hardcoded across all five renderers (no
// per-renderer override) because the spec table treats recap as
// one workflow — divergence would mean different style across
// renderers, which is a regression. Sub-renderer caps below
// `DEFAULT_MAX_TOKENS` are still allowed (terse pins 256 to
// protect cost) — the spec sets 4096 as the upper bound, not a
// target. Without these, each provider used its default
// (Anthropic = 1.0) and recap output drifted between calls,
// breaking the `5 iterations byte-identical` consistency eval
// the moment LLM render was active.
const RECAP_TEMPERATURE = 0.2;
const RECAP_TOP_P = 0.95;
const DEFAULT_MAX_TOKENS = 4_096;

export const renderViaLlm = async <T>(
  input: RenderViaLlmInput<T>,
): Promise<RenderViaLlmResult<T>> => {
  const { provider, prompt, schemaName, jsonSchema, validate, fidelityCheck, template } = input;

  if (provider.capabilities.constrained === false) {
    return {
      ok: false,
      reason: 'capability-missing',
      detail: `provider ${provider.id} does not support constrained generation`,
    };
  }

  let raw: string;
  let usage: UsageInfo;
  try {
    const result = await provider.generateConstrained({
      // The Anthropic adapter ignores `req.model` (it uses the
      // closure's modelName); for any future provider that
      // respects the field, deriving it from the provider id is
      // the closest approximation we have without leaking
      // implementation detail.
      model: provider.id.replace(/^[^/]+\//, ''),
      messages: [{ role: 'user', content: prompt.user }],
      system: prompt.system,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: RECAP_TEMPERATURE,
      top_p: RECAP_TOP_P,
      output_schema: jsonSchema,
      output_schema_name: schemaName,
      ...(input.schemaDescription !== undefined
        ? { output_schema_description: input.schemaDescription }
        : {}),
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

  const validation = validate(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'schema-violation',
      detail: validation.errors.join('; '),
    };
  }
  const structured = parsed as T;

  const fidelity = fidelityCheck(structured);
  if (!fidelity.ok) {
    return {
      ok: false,
      reason: 'fidelity-mismatch',
      detail: fidelity.errors.join('; '),
    };
  }

  const output = template(structured);
  const lineCount = output.split('\n').length;
  if (lineCount > input.maxOutputLines) {
    return {
      ok: false,
      reason: 'concision-violation',
      detail: `output ${lineCount} lines exceeds limit ${input.maxOutputLines}`,
    };
  }

  const costUsd = computeCost(provider.capabilities, usage);
  return { ok: true, output, structured, usage, costUsd };
};
