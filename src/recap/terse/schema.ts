// TerseRenderV1 — structured shape for the `terse` renderer
// (RECAP.md §4.6). One sentence ≤ 200 chars. The simplest of the
// renderers: schema is essentially "a string under a cap", but it
// still goes through the full LLM pipeline (forced tool, schema
// validation, fidelity check) so the same machinery applies.

export const TERSE_SCHEMA_VERSION = 'terse-v1' as const;

export type TerseSchemaVersion = typeof TERSE_SCHEMA_VERSION;

export interface TerseRenderV1 {
  schemaVersion: TerseSchemaVersion;
  // ≤ 200 chars per RECAP §4.6. The single sentence the renderer
  // surfaces — used for footers, status lines, and commit
  // message bodies.
  sentence: string;
}

export const TERSE_LIMITS = {
  sentenceMaxChars: 200,
} as const;

export const TERSE_RENDER_V1_JSON_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'sentence'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [TERSE_SCHEMA_VERSION] },
    sentence: { type: 'string', minLength: 1, maxLength: TERSE_LIMITS.sentenceMaxChars },
  },
} as const;

export interface TerseValidationResult {
  ok: boolean;
  errors: string[];
}

export const validateTerseRenderV1 = (value: unknown): TerseValidationResult => {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'sentence']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`unexpected property '${k}'`);
  }
  if (obj.schemaVersion !== TERSE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${TERSE_SCHEMA_VERSION}'`);
  }
  if (typeof obj.sentence !== 'string' || obj.sentence.length === 0) {
    errors.push('sentence must be non-empty string');
  } else if (obj.sentence.length > TERSE_LIMITS.sentenceMaxChars) {
    errors.push(`sentence exceeds ${TERSE_LIMITS.sentenceMaxChars} chars`);
  }
  return { ok: errors.length === 0, errors };
};
