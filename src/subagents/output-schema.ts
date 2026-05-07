// Output-schema validation for playbook subagents
// (`PLAYBOOKS.md` §1.2). The author declares an `output_schema` in
// the .md frontmatter; the child renders it into its system
// prompt and the runtime validates the terminal assistant text
// against it post-hoc. A mismatch buys the child one retry with
// a diagnostic message; a second mismatch surfaces as a
// `playbook.output_invalid` envelope reason.
//
// Two schema dialects coexist (PLAYBOOKS.md §1.2 examples both
// shapes side by side):
//
//   1. **Shorthand** — a flat or nested mapping of field name →
//      type-string. Examples: `summary: string`, `blockers: array`,
//      `findings: { file: string, line: int }`. Closer to YAML
//      readability; what most playbooks adopt.
//
//   2. **JSON Schema** — the full canonical shape (`{ type:
//      'object', properties: {...}, required: [...] }`). Used by
//      playbooks that need stricter typing or downstream tooling.
//
// Detection is by presence of a top-level `type: 'object'` field.
// Both modes are validated *shallowly*: top-level keys, required
// presence, primitive type tags. We do NOT recurse into nested
// schemas — that would multiply the surface and overfit the tests
// without catching meaningfully more mistakes than the
// shallow check (most schema mismatches in practice are missing
// fields or typos).

import { parse as parseYaml } from 'yaml';

// Parse the model's terminal text as a structured object. The
// model is told to emit YAML; YAML is a superset of JSON so this
// path also handles JSON output without a branch. A code fence
// (```yaml ... ``` or ```json ... ```) is recognized anywhere in
// the text — not just at the start — because playbooks that also
// enable `step_reflection` instruct the model to begin every step
// with a `Reflection:` prose line, which lands BEFORE the final
// YAML fence.
//
// Returns null on parse failure or non-object root. The caller
// treats null as "did not emit a structured object" — a distinct
// failure mode from "emitted a structured object but missing
// fields", and surfaces a different diagnostic.
export const parseOutputAsObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Prefer fenced blocks when present, walked LAST-FIRST. The
  // output_schema prompt tells the model to wrap its TERMINAL
  // mapping in a ```yaml fence; outputs with multiple fences
  // (e.g., a brief snippet block earlier in the response,
  // followed by the final YAML) need the LAST block, not a
  // slice that conflates both. Falling through to whole-text
  // parse covers the bare-YAML case (no fence).
  for (const candidate of extractFencedCandidates(trimmed)) {
    const obj = tryParseObject(candidate);
    if (obj !== null) return obj;
  }
  return tryParseObject(trimmed);
};

const tryParseObject = (text: string): Record<string, unknown> | null => {
  if (text.trim().length === 0) return null;
  try {
    const parsed = parseYaml(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

// Walk the text top-to-bottom, pairing each opener (line
// starting with ```) with the NEXT bare-``` close line. Returns
// the inner contents of every paired block in REVERSE order
// (last block first) — the schema instruction places the
// authoritative YAML at the end of the assistant turn, so
// preferring the last block reaches the right answer when the
// model emits a brief snippet fence earlier in the response.
//
// Trade-off vs. the prior "first-open + last-close" strategy: a
// YAML scalar that contains a nested ``` line (e.g., a string
// field whose body is markdown with its own fences) will close
// the outer fence prematurely under nearest-pair walking, and
// the inner block parses as a partial mapping. The previous
// strategy handled that edge but conflated multi-block outputs
// into one unparseable chunk — the bug report that prompted
// this change. Nested-fence-in-YAML is rare in practice (a
// playbook must declare a string-typed field AND the model must
// emit markdown with code fences in it); multi-block responses
// are the common case under step_reflection: full or any
// playbook where the model "shows its work" before the final
// YAML.
const extractFencedCandidates = (text: string): string[] => {
  const lines = text.split('\n');
  const pairs: Array<{ open: number; close: number }> = [];
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (openIdx === -1) {
      if (line.startsWith('```')) {
        openIdx = i;
      }
    } else if (line.trim() === '```') {
      pairs.push({ open: openIdx, close: i });
      openIdx = -1;
    }
  }
  const out: string[] = [];
  for (let i = pairs.length - 1; i >= 0; i--) {
    const p = pairs[i];
    if (p === undefined) continue;
    out.push(lines.slice(p.open + 1, p.close).join('\n'));
  }
  return out;
};

// Discriminator: did the author write JSON Schema or shorthand?
// JSON Schema unambiguously declares a top-level `type` (the
// only canonical entry point for an object schema is `type:
// 'object'`). Anything else is shorthand.
//
// `properties` shape is intentionally NOT part of the
// discriminator: a valid JSON Schema can declare
// `{type: 'object', required: [...]}` with no properties block
// at all, or rely only on keywords like `additionalProperties`
// / `patternProperties`. Requiring properties here would have
// misclassified those as shorthand and started treating schema
// keywords (`type`, `required`) as required output keys —
// false `playbook.output_invalid` against otherwise-correct
// output. validateJsonSchema below is robust against null /
// array `properties` (extraction guard normalizes to `{}`),
// so loosening the discriminator does not reintroduce the
// null-properties crash that motivated the earlier tightening.
const isJsonSchema = (schema: Record<string, unknown>): boolean => schema.type === 'object';

// Map a JSON Schema primitive type to a runtime test against the
// observed value. We accept the conventional aliases the spec
// uses (`int` and `number` both map to numeric, `array` and
// `list` both map to arrays, etc.) — the validator's job is to
// catch obvious mismatches, not to enforce JSON Schema's exact
// dialect rules.
const typeMatches = (declared: string, value: unknown): boolean => {
  switch (declared) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
    case 'int':
      // Author asked for an integer specifically — fractional
      // values (3.14) must NOT pass. JSON Schema's integer type
      // is "number with no fractional component"; we mirror that
      // with `Number.isInteger`, which also rejects NaN /
      // ±Infinity. Downstream consumers that assume integral
      // fields (line numbers, counts, IDs) get a real gate.
      return Number.isInteger(value);
    case 'boolean':
    case 'bool':
      return typeof value === 'boolean';
    case 'array':
    case 'list':
      return Array.isArray(value);
    case 'object':
    case 'mapping':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    case 'any':
      return value !== undefined;
    default:
      // Unknown type-string — common when shorthand uses
      // `enum [a, b, c]` or composite descriptors. We pass
      // through as "valid" rather than refuse, because the
      // shallow validator's job is to catch obvious mismatches
      // (missing fields, swapped string vs. array). Authors who
      // need stricter typing should adopt JSON Schema mode.
      return true;
  }
};

export interface ValidationOk {
  valid: true;
}

export interface ValidationFail {
  valid: false;
  // Human-readable summary, suitable for prompt injection on the
  // retry pass. Lists the specific gripes — missing fields,
  // type mismatches — so the model can correct without guessing
  // what was wrong.
  reason: string;
  // Structured details for audit / programmatic consumers. Both
  // arrays may be empty (e.g., when the parse itself failed).
  missingKeys: string[];
  typeMismatches: { key: string; expected: string; actual: string }[];
}

export type ValidationResult = ValidationOk | ValidationFail;

// Validate output text against schema. Returns a discriminated
// result so callers can branch on `valid` without a separate
// error path. The function never throws — every failure mode is
// reported as `valid: false` with a diagnostic.
export const validateOutput = (text: string, schema: unknown): ValidationResult => {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    // Caller passed a malformed schema (corrupt audit row, etc).
    // Treat as "no schema" — the output is unconditionally OK.
    // Refusing here would punish the model for the loader's bug.
    return { valid: true };
  }
  const schemaObj = schema as Record<string, unknown>;
  // Empty schema → no constraints. Mirrors `buildOutputSchemaBlock`
  // (output-schema-block.ts), which suppresses the prompt-side
  // "emit a YAML mapping" instruction for empty schemas. Without
  // this short-circuit, free-form output would fail the parse
  // gate below even though the author intentionally declared no
  // structured contract — a prompt/runtime mismatch that forces
  // unnecessary retries or `playbook.output_invalid` errors.
  if (Object.keys(schemaObj).length === 0) return { valid: true };
  const parsed = parseOutputAsObject(text);
  if (parsed === null) {
    return {
      valid: false,
      reason:
        'output could not be parsed as YAML/JSON object — emit a structured mapping (with or without a ```yaml code fence)',
      missingKeys: [],
      typeMismatches: [],
    };
  }
  if (isJsonSchema(schemaObj)) {
    return validateJsonSchema(parsed, schemaObj);
  }
  return validateShorthand(parsed, schemaObj);
};

const validateJsonSchema = (
  output: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationResult => {
  // Defense in depth: even though `isJsonSchema` already gates
  // null/array out of this branch, extract with the same null/
  // array guard so a future call site that bypasses the
  // discriminator does not regress to indexing into null.
  const properties =
    schema.properties !== null &&
    schema.properties !== undefined &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const missingKeys: string[] = [];
  const typeMismatches: { key: string; expected: string; actual: string }[] = [];
  // Pass 1 — required-presence gate. An absent required key
  // surfaces as missingKey; the type check on its (absent) value
  // would be incoherent, so skip via continue.
  for (const key of required) {
    if (!(key in output)) {
      missingKeys.push(key);
    }
  }
  // Pass 2 — type gate over EVERY declared property that is
  // PRESENT in the output. Required-and-present + optional-and-
  // present both run through the same loop. Absent optional
  // properties are not gated (JSON Schema semantics — optional
  // means "may omit"). The earlier shape, which only ran type
  // checks inside the required loop, silently accepted a
  // wrong-typed optional value: `{severity: [1]}` against
  // `{properties.severity.type: 'string'}` passed because
  // severity was not in `required`. Iterating over `properties`
  // closes that gap; output keys not declared in properties stay
  // ignored (additionalProperties: true is the default).
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in output)) continue;
    if (
      propSchema === null ||
      typeof propSchema !== 'object' ||
      Array.isArray(propSchema) ||
      typeof (propSchema as Record<string, unknown>).type !== 'string'
    ) {
      continue;
    }
    const expected = (propSchema as Record<string, unknown>).type as string;
    if (!typeMatches(expected, output[key])) {
      typeMismatches.push({ key, expected, actual: actualType(output[key]) });
    }
  }
  if (missingKeys.length === 0 && typeMismatches.length === 0) return { valid: true };
  return {
    valid: false,
    reason: composeReason(missingKeys, typeMismatches),
    missingKeys,
    typeMismatches,
  };
};

const validateShorthand = (
  output: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationResult => {
  const missingKeys: string[] = [];
  const typeMismatches: { key: string; expected: string; actual: string }[] = [];
  for (const key of Object.keys(schema)) {
    if (!(key in output)) {
      missingKeys.push(key);
      continue;
    }
    const declared = schema[key];
    // Shorthand declares the type as a STRING (`summary: string`,
    // `blockers: array`). Nested object/array shapes are not
    // shallow-checked — see the docstring.
    if (typeof declared === 'string') {
      if (!typeMatches(declared, output[key])) {
        typeMismatches.push({ key, expected: declared, actual: actualType(output[key]) });
      }
    }
  }
  if (missingKeys.length === 0 && typeMismatches.length === 0) return { valid: true };
  return {
    valid: false,
    reason: composeReason(missingKeys, typeMismatches),
    missingKeys,
    typeMismatches,
  };
};

const actualType = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const composeReason = (
  missingKeys: string[],
  typeMismatches: { key: string; expected: string; actual: string }[],
): string => {
  const parts: string[] = [];
  if (missingKeys.length > 0) {
    parts.push(`missing required key(s): ${missingKeys.join(', ')}`);
  }
  for (const m of typeMismatches) {
    parts.push(`'${m.key}' expected ${m.expected} but got ${m.actual}`);
  }
  return parts.join('; ');
};
