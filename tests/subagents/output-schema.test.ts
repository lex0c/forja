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

  test('prefers the LAST fenced block when multiple top-level blocks are present', () => {
    // Regression: previously the extractor paired the FIRST
    // opener with the LAST closer, so an earlier snippet fence
    // and the final YAML fence were sliced into one unparseable
    // chunk. Real outputs look like this whenever the model
    // shows an example before the final mapping (common under
    // step_reflection: full or any playbook where the model
    // "demonstrates" something before the schema-bound YAML).
    const text =
      'Reflection: I will show a snippet first, then emit the final YAML.\n\n' +
      '```text\nbrief illustrative snippet\n```\n\n' +
      'Now the schema-bound output:\n\n' +
      '```yaml\nsummary: ok\nblockers: []\n```';
    const out = parseOutputAsObject(text);
    expect(out).toEqual({ summary: 'ok', blockers: [] });
  });

  test('refuses an earlier valid mapping followed by a terminal non-mapping fence', () => {
    // The motivating shape from the bug report: model emits a
    // clean YAML mapping in fence A, then a second fence B
    // whose content does not parse as a mapping. The terminal
    // contract refuses — only fence B (the final answer)
    // satisfies the gate.
    const text =
      'Setup:\n\n```yaml\ntopic: ok\n```\n\nFinal answer:\n\n```text\njust some prose, no mapping\n```';
    expect(parseOutputAsObject(text)).toBeNull();
  });

  test('terminal mapping fence wins even when an earlier fence is also a mapping', () => {
    // Counterpart pin: when BOTH the earlier fence AND the
    // terminal fence are mappings, the terminal one is the
    // authoritative answer (per `output_schema` contract). The
    // returned object must be the LAST mapping, not the first.
    const text =
      '```yaml\ntopic: scratch\n```\n\nFinal answer:\n\n```yaml\ntopic: real_answer\nsummary: ok\n```';
    const out = parseOutputAsObject(text);
    expect(out).toEqual({ topic: 'real_answer', summary: 'ok' });
  });

  test('refuses to fall back to an EARLIER fenced block when the LAST one is non-mapping', () => {
    // Strict terminal-output contract: the schema instruction
    // ("Your final assistant turn MUST be a YAML mapping")
    // means an earlier fenced object MUST NOT satisfy the gate
    // when the terminal block is non-conformant. Without this
    // strictness, a model could emit a clean object in fence
    // A, then continue with prose / another invalid fence B,
    // and silently pass the schema check — defeating the
    // post-hoc contract meant for the FINAL answer. Whole-text
    // parse is the only fallback path; it fails here too
    // because the surrounding text is not a YAML mapping at
    // root, so the verdict is null (→ playbook.output_invalid
    // upstream).
    const text =
      '```yaml\nsummary: ok\nblockers: []\n```\n\n' +
      'For reference, a related illustration:\n\n' +
      '```text\njust prose\n```';
    expect(parseOutputAsObject(text)).toBeNull();
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

  test('accepts integral values for the int alias', () => {
    const result = validateOutput('count: 5', { count: 'int' });
    expect(result.valid).toBe(true);
    // Negative + zero are integers too; no off-by-one in the gate.
    expect(validateOutput('count: 0', { count: 'int' }).valid).toBe(true);
    expect(validateOutput('count: -7', { count: 'int' }).valid).toBe(true);
  });

  test('rejects fractional values for the int / integer alias', () => {
    // Regression: int/integer used to share the `number` branch,
    // so 3.14 silently passed schemas that asked for line numbers,
    // counts, or ids. JSON Schema's integer type is "number with
    // no fractional component"; the validator now mirrors it via
    // Number.isInteger so the contract is real.
    for (const alias of ['int', 'integer'] as const) {
      const result = validateOutput('count: 3.14', { count: alias });
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      const m = result.typeMismatches.find((x) => x.key === 'count');
      expect(m?.expected).toBe(alias);
      expect(m?.actual).toBe('number');
    }
  });

  test('rejects NaN and Infinity for int (not an integer per Number.isInteger)', () => {
    // YAML parses `.nan` / `.inf` per the YAML 1.1 float spec;
    // both are valid `number` values but neither is an integer.
    // Number.isInteger naturally rules them out — pinning the
    // behavior here so a future "tolerant" rewrite doesn't
    // re-introduce the gap.
    expect(validateOutput('count: .nan', { count: 'int' }).valid).toBe(false);
    expect(validateOutput('count: .inf', { count: 'int' }).valid).toBe(false);
  });

  test('number alias still accepts fractional values (no over-tightening)', () => {
    // Don't let the integer fix bleed into the `number` branch —
    // an author who wrote `confidence: number` still expects 0.9
    // to pass.
    expect(validateOutput('confidence: 0.9', { confidence: 'number' }).valid).toBe(true);
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

  test('non-required keys are not gated for PRESENCE', () => {
    // `severity` is in properties but not required → output may
    // omit it without invalidating. Mirrors JSON Schema semantics.
    const result = validateOutput('summary: ok\nfindings: []', schema);
    expect(result.valid).toBe(true);
  });

  test('optional keys ARE type-gated when present', () => {
    // Regression: type checks used to live inside the
    // required-key loop, so an optional property with the wrong
    // type slipped through. `severity` is optional but typed
    // `string`; emitting `[1]` violates the declared schema and
    // must be flagged.
    const result = validateOutput('summary: ok\nfindings: []\nseverity: [1]', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.typeMismatches.length).toBe(1);
    expect(result.typeMismatches[0]).toEqual({
      key: 'severity',
      expected: 'string',
      actual: 'array',
    });
  });

  test('optional key absent stays valid (no spurious type-mismatch)', () => {
    // Counterpart pin to the above. Without this assertion, a
    // future refactor that always type-checks declared properties
    // (regardless of presence) would also pass the optional-
    // wrong-type test but flag every absent optional field.
    const result = validateOutput('summary: ok\nfindings: []', schema);
    expect(result.valid).toBe(true);
  });

  test('required-missing AND optional-wrong-type compose into one verdict', () => {
    // Aggregation pin: the validator collects ALL violations in
    // one pass — a single failure mode does not short-circuit
    // the others. The model gets a complete diagnostic on the
    // retry pass, not a piecemeal one.
    const result = validateOutput('severity: [1]', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.missingKeys).toContain('summary');
    expect(result.missingKeys).toContain('findings');
    expect(result.typeMismatches.find((m) => m.key === 'severity')?.expected).toBe('string');
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

  test('empty schema is permissive (parseable mapping)', () => {
    // An empty mapping has no required keys — any output passes.
    expect(validateOutput('foo: bar', {}).valid).toBe(true);
  });

  test('empty schema accepts free-form text (no parse gate when no constraints)', () => {
    // Regression: previously, `audit.outputSchema !== null` gated
    // enforcement, so an empty mapping `{}` still ran through
    // validateOutput, which required the output to be parseable
    // YAML/JSON. Free-form text would fail the parse and surface
    // a spurious playbook.output_invalid even though the author
    // intentionally declared no structured contract (the prompt
    // composer in output-schema-block.ts already suppresses the
    // "emit YAML" instruction for empty schemas). The validator
    // now short-circuits empty schemas to mirror that intent.
    expect(validateOutput('Just a free-form answer.\n\nNo YAML at all.', {}).valid).toBe(true);
    expect(validateOutput('', {}).valid).toBe(true);
    expect(validateOutput('- not\n- a\n- mapping', {}).valid).toBe(true);
  });

  test('JSON-schema-shaped schema with null/array properties does not crash', () => {
    // Regression contract: `typeof null === 'object'` previously
    // let a malformed `{type: "object", properties: null}` index
    // into a null properties record and throw a TypeError on a
    // clean `done` run. The discriminator now classifies any
    // `type: "object"` schema as JSON Schema mode — including
    // these malformed shapes — and validateJsonSchema's
    // extraction guard normalizes null / array properties into
    // an empty object so the runtime stays well-formed.
    const malformed = [
      { type: 'object', properties: null, required: ['foo'] },
      { type: 'object', properties: ['foo', 'bar'], required: ['foo'] },
    ];
    for (const schema of malformed) {
      expect(() => validateOutput('summary: ok', schema)).not.toThrow();
      const result = validateOutput('summary: ok', schema);
      expect(typeof result.valid).toBe('boolean');
    }
  });

  test('JSON-schema with required but no properties block validates correctly', () => {
    // Regression: requiring properties on the discriminator
    // misclassified valid schemas like `{type: "object",
    // required: [...]}` (no properties declared) as shorthand.
    // The validator then iterated `Object.keys(schema)` and
    // treated `type` and `required` as required OUTPUT keys —
    // a false `playbook.output_invalid` even when the model
    // emitted exactly what the schema asked for.
    const schema = { type: 'object', required: ['summary'] };
    // summary present → valid (no properties means no type checks).
    expect(validateOutput('summary: ok', schema).valid).toBe(true);
    // summary absent → missing required key (NOT "missing type / required").
    const result = validateOutput('other: 42', schema);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.missingKeys).toEqual(['summary']);
    // Defensive: the schema's own keywords MUST NOT leak into
    // the missing-keys list (the symptom of the misclassification).
    expect(result.missingKeys).not.toContain('type');
    expect(result.missingKeys).not.toContain('required');
  });

  test('JSON-schema with bare type=object (no required, no properties) accepts any output', () => {
    // The most permissive JSON Schema: declares "must be an
    // object" with no further constraints. Output is unconditionally
    // valid because there are no required keys and no typed
    // properties to gate.
    const schema = { type: 'object' };
    expect(validateOutput('summary: anything\nother: 42', schema).valid).toBe(true);
    expect(validateOutput('foo: bar', schema).valid).toBe(true);
  });

  test('JSON-schema mode validates against the declared properties block when present', () => {
    // Counterpart pin to the discriminator change. A schema
    // that DOES declare properties must still type-check them
    // (defends against an over-permissive rewrite that skips
    // the type gate when the discriminator loosens).
    const valid = {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' } },
    };
    expect(validateOutput('summary: ok', valid).valid).toBe(true);
    const fail = validateOutput('other: 42', valid);
    expect(fail.valid).toBe(false);
    if (fail.valid) return;
    expect(fail.missingKeys).toContain('summary');
  });
});
