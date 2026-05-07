import { describe, expect, test } from 'bun:test';
import { parseOutputAsObject, validateOutput } from '../../src/subagents/output-schema.ts';

describe('parseOutputAsObject', () => {
  test('parses bare YAML object', () => {
    const out = parseOutputAsObject('summary: ok\nblockers: []');
    expect(out).toEqual({ summary: 'ok', blockers: [] });
  });

  test('parses bare JSON object (YAML is a superset)', () => {
    const out = parseOutputAsObject('{"summary":"ok","blockers":[]}');
    expect(out).toEqual({ summary: 'ok', blockers: [] });
  });

  test('strips a ```yaml code fence', () => {
    const out = parseOutputAsObject('```yaml\nsummary: ok\n```');
    expect(out).toEqual({ summary: 'ok' });
  });

  test('strips a ```json code fence', () => {
    const out = parseOutputAsObject('```json\n{"summary": "ok"}\n```');
    expect(out).toEqual({ summary: 'ok' });
  });

  test('strips a bare ``` fence (no language tag)', () => {
    const out = parseOutputAsObject('```\nsummary: ok\n```');
    expect(out).toEqual({ summary: 'ok' });
  });

  test('extracts a fenced block preceded by prose (Reflection: line)', () => {
    // step_reflection: terse forces a `Reflection:` prefix line
    // BEFORE the YAML fence. The whole text is not parseable
    // YAML, but the fence contents are.
    const text =
      'Reflection: Previous YAML was rejected — re-emitting clean YAML.\n\n```yaml\nsummary: ok\nblockers: []\n```';
    const out = parseOutputAsObject(text);
    expect(out).toEqual({ summary: 'ok', blockers: [] });
  });

  test('extracts a fenced block preceded by multi-paragraph prose', () => {
    const text =
      'Reflection: First line.\nSecond paragraph of reasoning.\n\n```json\n{"summary": "ok"}\n```';
    const out = parseOutputAsObject(text);
    expect(out).toEqual({ summary: 'ok' });
  });

  test('falls back to whole-text parse when the fence content is not a mapping', () => {
    // The fence exists but its inner content is not a YAML
    // object (here it's just a scalar). The parser should fall
    // through and try the whole text — which here is also not a
    // mapping, so returns null. Guards against the fence path
    // shadowing a successful whole-text parse.
    const text = 'foo: bar\n\n```\njust a string\n```';
    const out = parseOutputAsObject(text);
    // Whole text isn't a clean mapping either (the fence inside
    // breaks YAML), so result is null. The point of this test is
    // that we don't throw and we don't lock onto the fence.
    expect(out).toBeNull();
  });

  test('returns null for non-object root (array)', () => {
    // The schema validator expects a top-level mapping. An array
    // root can't be validated against `{ summary: string, ... }`
    // — collapse to null so the caller surfaces "could not parse
    // as YAML/JSON object".
    expect(parseOutputAsObject('- item1\n- item2')).toBeNull();
  });

  test('returns null for primitive root (string scalar)', () => {
    expect(parseOutputAsObject('"just a string"')).toBeNull();
  });

  test('returns null on parse failure', () => {
    expect(parseOutputAsObject('summary: [unclosed')).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(parseOutputAsObject('')).toBeNull();
    expect(parseOutputAsObject('   \n  ')).toBeNull();
  });
});

describe('validateOutput — shorthand schema', () => {
  const schema = {
    summary: 'string',
    blockers: 'array',
    confidence: 'number',
  };

  test('all required keys with correct types → valid', () => {
    const text = 'summary: looks good\nblockers: []\nconfidence: 0.9';
    const result = validateOutput(text, schema);
    expect(result.valid).toBe(true);
  });

  test('reports missing keys', () => {
    const result = validateOutput('summary: ok', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.missingKeys).toEqual(['blockers', 'confidence']);
    expect(result.reason).toContain('missing required key');
    expect(result.reason).toContain('blockers');
  });

  test('reports type mismatches with expected/actual', () => {
    const text = 'summary: 42\nblockers: not-array\nconfidence: yes';
    const result = validateOutput(text, schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.missingKeys).toEqual([]);
    expect(result.typeMismatches.length).toBe(3);
    expect(result.typeMismatches.find((m) => m.key === 'summary')?.expected).toBe('string');
    expect(result.typeMismatches.find((m) => m.key === 'summary')?.actual).toBe('number');
    expect(result.typeMismatches.find((m) => m.key === 'blockers')?.actual).toBe('string');
  });

  test('accepts the int alias for number', () => {
    const result = validateOutput('count: 5', { count: 'int' });
    expect(result.valid).toBe(true);
  });

  test('accepts the list alias for array', () => {
    const result = validateOutput('items: [1, 2]', { items: 'list' });
    expect(result.valid).toBe(true);
  });

  test('unknown type-string passes through (forward-compat)', () => {
    // Authors using `enum [a, b, c]` or composite descriptors
    // get a passthrough — we don't refuse, we just don't gate on
    // the unknown declaration. The shallow validator's job is
    // catching obvious mismatches, not enforcing the dialect.
    const result = validateOutput('mode: speculation', { mode: 'enum [confirmed, speculation]' });
    expect(result.valid).toBe(true);
  });

  test('unparseable output produces a parse-failure reason', () => {
    const result = validateOutput('not a yaml mapping', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toContain('parse');
    expect(result.missingKeys).toEqual([]);
  });
});

describe('validateOutput — JSON Schema mode', () => {
  const schema = {
    type: 'object',
    required: ['summary', 'findings'],
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array' },
      severity: { type: 'string' },
    },
  };

  test('all required keys present, types match → valid', () => {
    const text = 'summary: ok\nfindings: []\nseverity: low';
    expect(validateOutput(text, schema).valid).toBe(true);
  });

  test('missing required key → invalid', () => {
    const result = validateOutput('summary: ok', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.missingKeys).toContain('findings');
  });

  test('type mismatch on required key → invalid', () => {
    const result = validateOutput('summary: ok\nfindings: not-an-array', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.typeMismatches.length).toBe(1);
    expect(result.typeMismatches[0]).toEqual({
      key: 'findings',
      expected: 'array',
      actual: 'string',
    });
  });

  test('non-required keys are not gated', () => {
    // `severity` is in properties but not required → output may
    // omit it without invalidating. Mirrors JSON Schema semantics.
    const result = validateOutput('summary: ok\nfindings: []', schema);
    expect(result.valid).toBe(true);
  });
});

describe('validateOutput — schema-side edge cases', () => {
  test('null schema accepts any output (defensive against corrupt audit)', () => {
    expect(validateOutput('whatever', null).valid).toBe(true);
  });

  test('non-object schema accepts any output', () => {
    expect(validateOutput('whatever', 'a string').valid).toBe(true);
    expect(validateOutput('whatever', [1, 2]).valid).toBe(true);
  });

  test('empty schema is permissive', () => {
    // An empty mapping has no required keys — any output passes.
    expect(validateOutput('foo: bar', {}).valid).toBe(true);
  });
});
