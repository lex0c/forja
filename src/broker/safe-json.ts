// Proto-pollution-safe JSON parse for broker/worker IPC boundaries
// (slice 104, R6 #42).
//
// Both wire boundaries — broker → worker (request line) and worker
// → broker (response line) — consume attacker-controlled JSON.
// Pre-slice both sites used bare `JSON.parse`, which leaves the
// parsed object with `__proto__` / `constructor` / `prototype` as
// own enumerable properties when the input includes them. The
// resulting object's prototype chain isn't immediately polluted
// (JSON.parse special-cases `__proto__` and stores it as a data
// property), but downstream patterns that copy the object — most
// commonly `Object.assign({}, parsed)`, `{...parsed}`, or
// per-key handler dispatch — trigger the `__proto__` setter on
// the target, mutating its prototype chain.
//
// The known exploitation shape:
//
//   const raw = '{"__proto__":{"isAdmin":true}}';
//   const parsed = JSON.parse(raw);
//   const args = Object.assign({}, parsed);
//   // args is now {} BUT every {} created from now on has
//   // isAdmin=true via prototype chain pollution. Handler bug:
//   // `if (args.isAdmin) doDangerous()` fires on every call.
//
// Defense: a reviver that returns `undefined` for the dangerous
// key names. `JSON.parse(text, reviver)` calls `reviver(key,
// value)` recursively; returning `undefined` deletes that key
// from the parsed result. Applied at every JSON.parse site on
// the broker IPC perimeter so the property never reaches
// downstream handler code.
//
// Three keys covered: `__proto__` (the canonical proto-pollution
// vector), `constructor` (a poisoned `constructor.prototype`
// inheritance), `prototype` (defensive — rare but legitimate
// proto-walk shape on function-shaped values).

export const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

// Strip dangerous keys at every nesting level. Returning
// `undefined` from the reviver removes the property from the
// parsed result; for everything else we return the value verbatim.
const safeReviver = (key: string, value: unknown): unknown => {
  if (DANGEROUS_KEYS.has(key)) return undefined;
  return value;
};

// Drop-in replacement for `JSON.parse` at trust boundaries.
// Throws the same SyntaxError shapes as the native function so
// callers can keep their try/catch logic unchanged.
export const safeJsonParse = (text: string): unknown => {
  return JSON.parse(text, safeReviver);
};

// Strip proto-pollution keys from an already-parsed object tree
// (slice 121, R5 args proto-pollution defense). Useful when JSON
// parsing happened upstream (e.g., the Anthropic SDK parses
// tool-call args before they reach Forja) and the in-process
// broker can't rely on `safeJsonParse` to defend downstream
// `Object.assign({}, args)` patterns.
//
// Returns the SAME reference when no dangerous keys are present
// anywhere in the tree — common case (no allocation overhead).
// Returns a fresh object/array tree only when scrubbing is
// needed. Primitives and `null` pass through unchanged.
//
// Symmetric with `safeJsonParse`'s reviver: both refuse the same
// three keys (`__proto__`, `constructor`, `prototype`) at every
// nesting depth so the IPC perimeter and the in-process boundary
// share one threat model.
// Slice 130 fixup #5: a WeakSet cycle guard sentinel. Replaces a
// cyclic reference with this string in the output so downstream
// callers (e.g., the failure_events scrub pipeline) still produce
// valid JSON instead of throwing on JSON.stringify or recursing
// until stack overflow.
const CYCLE_SENTINEL = '__forja_cycle__';

export const scrubProtoPollution = (value: unknown): unknown => {
  return scrubProtoPollutionWithGuard(value, new WeakSet());
};

const scrubProtoPollutionWithGuard = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || typeof value !== 'object') return value;
  // Slice 130 fixup #5: cycle guard. Without this, a payload
  // containing `{ self: <cycle> }` would recurse until the JS
  // stack runs out; the RangeError escapes the proto-scrub call
  // and the caller's outer try/catch (e.g., a failure_events
  // wire site) swallows it, silently dropping the audit row that
  // was meant to report another failure. Returning a sentinel
  // string keeps the output JSON-stringifiable + preserves the
  // signal that a cycle was elided at this position.
  if (seen.has(value as object)) return CYCLE_SENTINEL;
  seen.add(value as object);
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const v of value) {
      const r = scrubProtoPollutionWithGuard(v, seen);
      if (r !== v) changed = true;
      out.push(r);
    }
    return changed ? out : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) {
      changed = true;
      continue;
    }
    const r = scrubProtoPollutionWithGuard(v, seen);
    if (r !== v) changed = true;
    out[k] = r;
  }
  return changed ? out : value;
};
