// camelCase → snake_case recursive key conversion. Used at the tool
// boundary to convert internal payloads (which use camelCase, the
// natural JS convention) into the snake_case shape models see at
// every other Forja tool surface (`process_id`, `exit_code`, etc).
//
// Without this, monitor/wait_for results would mix conventions:
// top-level `condition_met` snake but inner `payload.mtimeMs` camel.
// Models that learned snake from `process_id` get tripped up.
//
// The conversion walks arrays and plain objects; primitives,
// Functions, RegExps, Dates etc. pass through untouched. Cycles
// would loop forever — payloads here are JSON-shaped (no cycles by
// construction), so we don't pay for cycle detection.

const camelToSnake = (s: string): string => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

export const keysToSnake = (obj: unknown): unknown => {
  if (Array.isArray(obj)) return obj.map(keysToSnake);
  if (obj === null || typeof obj !== 'object') return obj;
  // Constructed objects (Date, RegExp, Buffer, etc.) get bypassed.
  // Plain objects come from JSON-shaped tool payloads — those are
  // the only ones we need to transform.
  if (Object.getPrototypeOf(obj) !== Object.prototype) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[camelToSnake(k)] = keysToSnake(v);
  }
  return out;
};
