// PrRenderV1 — the structured shape every renderer-`pr` invocation
// produces, whether deterministically or via LLM. Markdown is built
// from this shape by `template.ts`; the LLM render path emits this
// shape directly under forced tool_choice (see `llm.ts`).
//
// Why structured-not-markdown:
//   - Schema enforcement (RECAP.md §7.2) is by construction. The
//     model cannot invent a section, format, or "extras" field.
//   - Fidelity check is mechanical: every `changes[].path` MUST be
//     present in `RecapIntermediate.actions.filesWritten`; bullets
//     reference data that is verifiable against the projection.
//   - The deterministic and LLM paths share the same template,
//     so the only thing the LLM contributes is prose density.
//
// Caps come from RECAP.md §7.4 concision targets (PR description
// shouldn't bloat). They are enforced at validation time — model
// output that exceeds a cap fails fidelity and falls back to the
// deterministic path.

export const PR_SCHEMA_VERSION = 'pr-v1' as const;

export type PrSchemaVersion = typeof PR_SCHEMA_VERSION;

export type PrTestPlanStatus = 'done' | 'todo' | 'manual';

export interface PrChange {
  // MUST match a path in RecapIntermediate.actions.filesWritten.
  // Validation is exact-match; relative vs absolute, case, etc.
  // are operator-controlled at projection time and we do not try
  // to normalize them here.
  path: string;
  // 1–4 short bullet lines describing what changed in this file.
  // Exact deterministic text is "linesAdded/linesRemoved" plus
  // "semanticSummary" if non-empty; LLM path may reword but must
  // stay grounded in the same fields.
  bullets: string[];
}

export interface PrTestPlanItem {
  item: string;
  status: PrTestPlanStatus;
}

export interface PrRenderV1 {
  schemaVersion: PrSchemaVersion;
  // 1–5 high-level bullets summarizing the change. The first
  // bullet typically restates the goal text; subsequent bullets
  // call out the most material decisions / actions. Each ≤ 140
  // chars (concision target).
  summary: string[];
  // One entry per file written. May be empty for read-only
  // sessions, in which case the renderer omits the "## Changes"
  // section.
  changes: PrChange[];
  // Test plan — derived from outcomes.testsRun (status='done' if
  // passed; 'todo' otherwise). LLM render path can add 'manual'
  // items based on notDone / decisions when the model is told to.
  testPlan: PrTestPlanItem[];
  // 0–3 free-form notes. Surfaces decisions[] entries with
  // decided_by='user' that the operator should remember in
  // review, plus any notDone items.
  notes: string[];
}

export const PR_LIMITS = {
  summaryMaxItems: 5,
  summaryMaxChars: 140,
  changesBulletsMaxItems: 4,
  changesBulletsMaxChars: 120,
  testPlanItemMaxChars: 100,
  notesMaxItems: 3,
  notesMaxChars: 140,
} as const;

// JSON Schema literal — the shape we hand to Anthropic
// `tool_choice` so the model is structurally constrained. Kept in
// sync with PrRenderV1 by hand; a divergence test in `schema.test.ts`
// asserts both shapes at the same depth.
export const PR_RENDER_V1_JSON_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'summary', 'changes', 'testPlan', 'notes'],
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'string', enum: [PR_SCHEMA_VERSION] },
    summary: {
      type: 'array',
      minItems: 1,
      maxItems: PR_LIMITS.summaryMaxItems,
      items: { type: 'string', maxLength: PR_LIMITS.summaryMaxChars },
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'bullets'],
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1 },
          bullets: {
            type: 'array',
            minItems: 1,
            maxItems: PR_LIMITS.changesBulletsMaxItems,
            items: { type: 'string', maxLength: PR_LIMITS.changesBulletsMaxChars },
          },
        },
      },
    },
    testPlan: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'status'],
        additionalProperties: false,
        properties: {
          item: { type: 'string', maxLength: PR_LIMITS.testPlanItemMaxChars },
          status: { type: 'string', enum: ['done', 'todo', 'manual'] },
        },
      },
    },
    notes: {
      type: 'array',
      maxItems: PR_LIMITS.notesMaxItems,
      items: { type: 'string', maxLength: PR_LIMITS.notesMaxChars },
    },
  },
} as const;

export interface PrSchemaValidationResult {
  ok: boolean;
  errors: string[];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

// Manual validator — Forja stack policy is no-Zod, so we hand-roll
// the checks. Same shape as the JSON Schema above; validates that
// the parsed JSON is structurally a PrRenderV1 AND that every cap
// is respected. Fidelity (path-existence) is checked separately in
// `llm.ts` because it requires the RecapIntermediate context.
//
// Returns all errors (not first-fail) so a debugging session sees
// every reason a model output failed at once.
export const validatePrRenderV1 = (value: unknown): PrSchemaValidationResult => {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  // Reject extras — this is the "no fields outside the schema"
  // contract from RECAP.md §7.3.
  const allowedKeys = new Set(['schemaVersion', 'summary', 'changes', 'testPlan', 'notes']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) errors.push(`unexpected property '${key}'`);
  }
  if (obj.schemaVersion !== PR_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${PR_SCHEMA_VERSION}'`);
  }
  if (!isStringArray(obj.summary)) {
    errors.push('summary must be string[]');
  } else {
    if (obj.summary.length === 0 || obj.summary.length > PR_LIMITS.summaryMaxItems) {
      errors.push(`summary must have 1..${PR_LIMITS.summaryMaxItems} items`);
    }
    obj.summary.forEach((s, i) => {
      if (s.length > PR_LIMITS.summaryMaxChars) {
        errors.push(`summary[${i}] exceeds ${PR_LIMITS.summaryMaxChars} chars`);
      }
    });
  }
  if (!Array.isArray(obj.changes)) {
    errors.push('changes must be array');
  } else {
    obj.changes.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) {
        errors.push(`changes[${i}] must be object`);
        return;
      }
      const change = c as Record<string, unknown>;
      const allowed = new Set(['path', 'bullets']);
      for (const k of Object.keys(change)) {
        if (!allowed.has(k)) errors.push(`changes[${i}] unexpected property '${k}'`);
      }
      if (typeof change.path !== 'string' || change.path.length === 0) {
        errors.push(`changes[${i}].path must be non-empty string`);
      }
      if (!isStringArray(change.bullets)) {
        errors.push(`changes[${i}].bullets must be string[]`);
      } else {
        if (
          change.bullets.length === 0 ||
          change.bullets.length > PR_LIMITS.changesBulletsMaxItems
        ) {
          errors.push(
            `changes[${i}].bullets must have 1..${PR_LIMITS.changesBulletsMaxItems} items`,
          );
        }
        change.bullets.forEach((b, j) => {
          if (b.length > PR_LIMITS.changesBulletsMaxChars) {
            errors.push(
              `changes[${i}].bullets[${j}] exceeds ${PR_LIMITS.changesBulletsMaxChars} chars`,
            );
          }
        });
      }
    });
  }
  if (!Array.isArray(obj.testPlan)) {
    errors.push('testPlan must be array');
  } else {
    obj.testPlan.forEach((t, i) => {
      if (typeof t !== 'object' || t === null) {
        errors.push(`testPlan[${i}] must be object`);
        return;
      }
      const item = t as Record<string, unknown>;
      const allowed = new Set(['item', 'status']);
      for (const k of Object.keys(item)) {
        if (!allowed.has(k)) errors.push(`testPlan[${i}] unexpected property '${k}'`);
      }
      if (typeof item.item !== 'string' || item.item.length > PR_LIMITS.testPlanItemMaxChars) {
        errors.push(
          `testPlan[${i}].item must be string, ≤ ${PR_LIMITS.testPlanItemMaxChars} chars`,
        );
      }
      if (typeof item.status !== 'string' || !['done', 'todo', 'manual'].includes(item.status)) {
        errors.push(`testPlan[${i}].status must be one of done|todo|manual`);
      }
    });
  }
  if (!isStringArray(obj.notes)) {
    errors.push('notes must be string[]');
  } else {
    if (obj.notes.length > PR_LIMITS.notesMaxItems) {
      errors.push(`notes must have at most ${PR_LIMITS.notesMaxItems} items`);
    }
    obj.notes.forEach((n, i) => {
      if (n.length > PR_LIMITS.notesMaxChars) {
        errors.push(`notes[${i}] exceeds ${PR_LIMITS.notesMaxChars} chars`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
};
