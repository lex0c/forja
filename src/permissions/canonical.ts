// Canonical JSON encoder (RFC 8785 essentials) for hashing audit
// rows. The chain stored in `approvals_log` must verify byte-for-byte
// across implementations and across time, so two writers given the
// same logical row must produce the same hash input. JSON.stringify
// is non-deterministic with respect to key order (V8 preserves
// insertion order; future engines might not, and an object built
// from spreads / Object.fromEntries can reorder silently).
//
// Scope of conformance:
//   - Lexicographic key ordering (UTF-16 code unit comparison, which
//     is what V8 String#localeCompare gives by default and what
//     Array#sort uses without a comparator).
//   - No whitespace between tokens.
//   - Strings encoded via JSON.stringify (JSON spec escaping, which
//     also covers control chars + surrogate pairs).
//   - Numbers: finite only. Negative zero canonicalized to `0`.
//     NaN/Infinity rejected (they're not valid JSON anyway).
//   - Booleans, null, arrays as JSON spec.
//   - undefined / functions / symbols / bigint rejected — they
//     don't appear in audit rows and silent-coercion is a bug
//     class we'd rather catch.
//
// What this DOESN'T do that the full RFC 8785 specifies:
//   - JSON-LD context handling.
//   - Scientific notation normalization beyond what `String(n)`
//     gives for finite numbers (sufficient for integer ms
//     timestamps + scoring components 0..1).
//   - Full Unicode normalization. Audit row strings are produced by
//     the engine, not user input, and stay in NFC by construction
//     (UUID hex, paths from realpath, tool names from manifests).
//
// Bun.CryptoHasher is faster than node:crypto for sha256 and is the
// codebase's standard for runtime-level crypto (Bun:sqlite, Bun.Glob
// follow the same alignment).

import { CryptoHasher } from 'bun';

export const canonicalize = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) {
    // undefined leaks past JSON.stringify silently (as a missing
    // key inside an object, or as null inside an array). Either
    // shape is a chain corruption: two writers given different
    // input objects (one with `x: undefined`, one without) would
    // produce the same hash. Refuse to encode.
    throw new TypeError('canonical: undefined is not JSON');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical: non-finite number ${value}`);
    }
    // -0 and 0 must hash identically — they're mathematically
    // equal and a row carrying either should chain the same. The
    // Object.is check is the only way to distinguish; `=== 0`
    // matches both.
    if (Object.is(value, -0)) return '0';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Sort keys via default String#localeCompare-free ordering —
    // Array#sort without comparator uses UTF-16 code-unit order,
    // matching RFC 8785's "Code Unit Comparison" rule. Object.keys
    // returns own enumerable string keys; Symbol keys would slip
    // past JSON anyway (JSON.stringify skips them) and are not
    // audit-row legitimate.
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new TypeError(`canonical: unsupported type ${typeof value}`);
};

// Sha256 of the canonical encoding, hex-lowercased. Used directly in
// audit chain assembly: `this_hash = sha256(prev_hash || canonical_row)`
// per PERMISSION_ENGINE.md §7.2.
export const sha256Hex = (input: string): string => {
  const hasher = new CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
};

export const canonicalHash = (value: unknown): string => sha256Hex(canonicalize(value));
