// Canonical JSON — deterministic bytes for the same logical value,
// independent of object key insertion order.
//
// Why this exists: prompt-cache hits depend on a byte-stable prefix
// (CONTEXT_TUNING.md §3). Tool-call arguments are stored as objects
// (ProviderToolUseBlock.input) and echoed back into every subsequent
// request; if a key's position drifts between turns — a future refactor
// that spreads partials, or a hydrate-from-DB that rebuilds the object —
// the serialized bytes change and the cached prefix is invalidated.
// `JSON.stringify` follows insertion order, so it only "happens to" be
// stable. Sorting keys makes the same key/value set ALWAYS serialize to
// the same bytes — the guarantee, not the hope.
//
// Arrays keep their element order (order is meaningful in a list); only
// object KEYS are sorted, recursively. Primitives and null pass through.
// JSON key order is semantically irrelevant, so canonicalizing a tool
// arg or a hashed message never changes meaning — only the bytes.

export const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortKeysDeep(src[key]);
    }
    return out;
  }
  return value;
};

// Same-value-equal inputs (regardless of key order) produce identical
// bytes. Use anywhere serialized JSON feeds a cache prefix or a hash.
export const stableStringify = (value: unknown): string => JSON.stringify(sortKeysDeep(value));

// Canonicalize an object's keys (deep) while keeping the object type —
// for call sites that store the value back as a Record, e.g. a tool
// call's `input`.
export const canonicalizeObject = (obj: Record<string, unknown>): Record<string, unknown> =>
  sortKeysDeep(obj) as Record<string, unknown>;
