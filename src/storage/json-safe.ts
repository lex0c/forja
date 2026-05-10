// Wraps JSON.parse with a typed error so a tampered/corrupt DB row doesn't
// surface as a bare SyntaxError to the harness. Storage stores JSON as TEXT
// (no JSONB in SQLite); any schema we own can't generate invalid JSON, so
// hitting this path means external corruption.
export class StorageJsonError extends Error {
  readonly context: string;
  constructor(context: string, cause: Error) {
    super(`storage: corrupt JSON in ${context}: ${cause.message}`);
    this.name = 'StorageJsonError';
    this.context = context;
  }
}

export const parseJsonSafe = (raw: string, context: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new StorageJsonError(context, e as Error);
  }
};

// Canonical JSON: object keys are emitted in lexicographic order at every
// depth; arrays preserve index order; primitives are stringified the same
// way `JSON.stringify` would. Two structurally equal values produce the
// same string regardless of in-memory key insertion order — the property
// the recap cache key (RECAP.md §8.3) depends on.
//
// Caveats (matching `JSON.stringify` semantics):
// - `undefined` object values are dropped.
// - Cyclic structures throw.
// - `NaN` / `Infinity` serialize as `null` (JSON spec).
// - Plain data only: functions / symbols / class instances are not
//   supported. The recap projection emits plain shapes; callers
//   passing exotic values will see the same surprises they'd see
//   from `JSON.stringify`.
export const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value !== 'object') {
    const stringified = JSON.stringify(value);
    return stringified === undefined ? 'null' : stringified;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(',')}}`;
};
