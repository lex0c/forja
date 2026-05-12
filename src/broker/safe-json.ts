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

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

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
