import { describe, expect, test } from 'bun:test';
import {
  PR_LIMITS,
  PR_RENDER_V1_JSON_SCHEMA,
  PR_SCHEMA_VERSION,
  type PrRenderV1,
  validatePrRenderV1,
} from '../../src/recap/pr/schema.ts';

const baseValid = (): PrRenderV1 => ({
  schemaVersion: PR_SCHEMA_VERSION,
  summary: ['did the thing'],
  changes: [],
  testPlan: [],
  notes: [],
});

describe('validatePrRenderV1', () => {
  test('accepts a minimal valid shape', () => {
    const result = validatePrRenderV1(baseValid());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('accepts the maximally-populated shape', () => {
    const value: PrRenderV1 = {
      schemaVersion: PR_SCHEMA_VERSION,
      summary: ['a', 'b', 'c', 'd', 'e'],
      changes: [
        { path: '/p/a.ts', bullets: ['+1 / -0', 'reword'] },
        { path: '/p/b.ts', bullets: ['+5 / -2'] },
      ],
      testPlan: [
        { item: 'unit', status: 'done' },
        { item: 'manual sweep', status: 'manual' },
      ],
      notes: ['policy denial: foo', 'open question: bar'],
    };
    expect(validatePrRenderV1(value).ok).toBe(true);
  });

  test('rejects missing schemaVersion', () => {
    const v = baseValid() as Partial<PrRenderV1>;
    delete v.schemaVersion;
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  test('rejects wrong schemaVersion', () => {
    const v = { ...baseValid(), schemaVersion: 'pr-v0' as unknown as 'pr-v1' };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  test('rejects extra top-level properties (no fields outside schema)', () => {
    const v = { ...baseValid(), tone: 'cheerful' };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unexpected property 'tone'"))).toBe(true);
  });

  test('rejects extra properties on changes[]', () => {
    const v = {
      ...baseValid(),
      changes: [{ path: '/p/a.ts', bullets: ['x'], emoji: '🚀' }],
    };
    expect(validatePrRenderV1(v).ok).toBe(false);
  });

  test('rejects summary length over the cap', () => {
    const v = {
      ...baseValid(),
      summary: ['a'.repeat(PR_LIMITS.summaryMaxChars + 1)],
    };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('summary[0]'))).toBe(true);
  });

  test('rejects empty summary', () => {
    const v = { ...baseValid(), summary: [] };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true);
  });

  test('rejects too-many summary items', () => {
    const v = { ...baseValid(), summary: ['a', 'b', 'c', 'd', 'e', 'f'] };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('summary'))).toBe(true);
  });

  test('rejects bullet length over the cap', () => {
    const v: PrRenderV1 = {
      ...baseValid(),
      changes: [{ path: '/p/a.ts', bullets: ['x'.repeat(PR_LIMITS.changesBulletsMaxChars + 1)] }],
    };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
  });

  test('rejects testPlan with wrong status', () => {
    const v = {
      ...baseValid(),
      testPlan: [{ item: 'x', status: 'maybe' as 'done' }],
    };
    expect(validatePrRenderV1(v).ok).toBe(false);
  });

  test('rejects notes count over the cap', () => {
    const v = { ...baseValid(), notes: ['a', 'b', 'c', 'd'] };
    expect(validatePrRenderV1(v).ok).toBe(false);
  });

  test('reports multiple errors in one pass (no first-fail)', () => {
    const v = {
      ...baseValid(),
      summary: [],
      changes: 'not-an-array' as unknown as PrRenderV1['changes'],
      notes: ['a', 'b', 'c', 'd', 'e'],
    };
    const result = validatePrRenderV1(v);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  test('rejects non-object input', () => {
    expect(validatePrRenderV1(null).ok).toBe(false);
    expect(validatePrRenderV1('a string').ok).toBe(false);
    expect(validatePrRenderV1([]).ok).toBe(false);
    expect(validatePrRenderV1(42).ok).toBe(false);
  });
});

describe('PR_RENDER_V1_JSON_SCHEMA', () => {
  // The JSON Schema is what we hand to the Anthropic SDK as the
  // forced tool's input_schema. Even though the manual validator
  // is the authoritative gate, this test pins the JSON Schema's
  // required-fields list so a future edit can't silently drop one.
  test('declares the expected top-level required fields', () => {
    expect(new Set(PR_RENDER_V1_JSON_SCHEMA.required)).toEqual(
      new Set(['schemaVersion', 'summary', 'changes', 'testPlan', 'notes']),
    );
  });

  test('forbids additional top-level properties', () => {
    expect(PR_RENDER_V1_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  test('pins the schema version literal', () => {
    expect(PR_RENDER_V1_JSON_SCHEMA.properties.schemaVersion.enum).toEqual([PR_SCHEMA_VERSION]);
  });
});
