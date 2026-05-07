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
// path also handles JSON output without a branch. A leading code
// fence (```yaml ... ``` or ```json ... ```) is stripped before
// parsing — models commonly wrap output in fences when the
// surrounding prompt contains other markdown.
//
// Returns null on parse failure or non-object root. The caller
// treats null as "did not emit a structured object" — a distinct
// failure mode from "emitted a structured object but missing
// fields", and surfaces a different diagnostic.
export const parseOutputAsObject = (text: string): Record<string, unknown> | null => {
  // Strip a leading / trailing code fence if present. The
  // commonest shape is:
  //
  //   ```yaml
  //   summary: ...
  //   ```
  //
  // We also handle ```json, ``` (no language), and bare text.
  const stripped = stripCodeFence(text.trim());
  if (stripped.length === 0) return null;
  try {
    const parsed = parseYaml(stripped) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const stripCodeFence = (text: string): string => {
  // Match ```<lang>?\n ... \n```. Allow trailing whitespace after
  // the closing fence (common when the model adds a sign-off
  // line). Conservative: only strip the OUTER fence; nested
  // fences inside content stay verbatim.
  const lines = text.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('```')) {
    // Find the matching close.
    let closeIdx = -1;
    for (let i = lines.length - 1; i > 0; i--) {
      if (lines[i]?.trim() === '```') {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx > 0) {
      return lines.slice(1, closeIdx).join('\n');
    }
  }
  return text;
};

// Discriminator: did the author write JSON Schema or shorthand?
// JSON Schema unambiguously declares a top-level `type` (the
// only canonical entry point for an object schema is `type:
// 'object'`). Anything else is shorthand.
const isJsonSchema = (schema: Record<string, unknown>): boolean =>
  schema.type === 'object' && typeof schema.properties === 'object';

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
    case 'integer':
    case 'int':
      return typeof value === 'number';
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
  const properties =
    schema.properties !== undefined && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const missingKeys: string[] = [];
  const typeMismatches: { key: string; expected: string; actual: string }[] = [];
  for (const key of required) {
    if (!(key in output)) {
      missingKeys.push(key);
      continue;
    }
    const propSchema = properties[key];
    if (
      propSchema !== null &&
      typeof propSchema === 'object' &&
      !Array.isArray(propSchema) &&
      typeof (propSchema as Record<string, unknown>).type === 'string'
    ) {
      const expected = (propSchema as Record<string, unknown>).type as string;
      if (!typeMatches(expected, output[key])) {
        typeMismatches.push({ key, expected, actual: actualType(output[key]) });
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
