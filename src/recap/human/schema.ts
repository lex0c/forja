// HumanRenderV1 — structured shape for the `human` renderer
// (RECAP.md §4.1). Carries only the LLM-fillable prose section
// (`## Resumo`); every other section in the human output is
// rendered deterministically from the intermediate by the
// template. Two reasons:
//
//   1. The deterministic surface (cost, files, decisions, etc.)
//      is high-information and high-trust — the projection knows
//      it. Routing it through the LLM would invite hallucination
//      where there should be none.
//   2. Resumo is genuinely prose: a 2–3-bullet "what mattered"
//      narrative that distills the mechanical counts into
//      reviewer-readable signal. That is the only thing the
//      model contributes.

export const HUMAN_SCHEMA_VERSION = 'human-v1' as const;

export type HumanSchemaVersion = typeof HUMAN_SCHEMA_VERSION;

export interface HumanRenderV1 {
  schemaVersion: HumanSchemaVersion;
  // 1–5 bullets summarizing the session for a human reader. The
  // first bullet typically restates the goal; subsequent bullets
  // call out the most material decisions / outcomes. Each ≤ 200
  // chars (more permissive than `pr` because human is the default
  // surface and gets rendered to terminal).
  summary: string[];
}

export const HUMAN_LIMITS = {
  summaryMaxItems: 5,
  summaryMaxChars: 200,
} as const;

export const HUMAN_RENDER_V1_JSON_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'summary'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [HUMAN_SCHEMA_VERSION] },
    summary: {
      type: 'array',
      minItems: 1,
      maxItems: HUMAN_LIMITS.summaryMaxItems,
      items: { type: 'string', minLength: 1, maxLength: HUMAN_LIMITS.summaryMaxChars },
    },
  },
} as const;

export interface HumanValidationResult {
  ok: boolean;
  errors: string[];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

export const validateHumanRenderV1 = (value: unknown): HumanValidationResult => {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'summary']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unexpected property '${k}'`);
  }
  if (obj.schemaVersion !== HUMAN_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${HUMAN_SCHEMA_VERSION}'`);
  }
  if (!isStringArray(obj.summary)) {
    errors.push('summary must be string[]');
  } else {
    if (obj.summary.length === 0 || obj.summary.length > HUMAN_LIMITS.summaryMaxItems) {
      errors.push(`summary must have 1..${HUMAN_LIMITS.summaryMaxItems} items`);
    }
    obj.summary.forEach((s, i) => {
      if (s.length === 0 || s.length > HUMAN_LIMITS.summaryMaxChars) {
        errors.push(`summary[${i}] must be 1..${HUMAN_LIMITS.summaryMaxChars} chars`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
};
