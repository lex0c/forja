// Payload sanitizer for failure_events. Two defenses run before
// the JSON hits the DB:
//
//   1. Proto-pollution scrub (slice 121's scrubProtoPollution from
//      src/broker/safe-json.ts) — failure callers pass arbitrary
//      objects; a `__proto__` key in some downstream worker's
//      JSON.parse'd payload would land here and poison
//      Object.prototype on any `Object.assign({}, payload)` later.
//
//   2. Telemetry scrub (slice 130) over every string VALUE
//      recursively — operator-bearing paths, hosts, tokens,
//      and SSH/URL shapes get redacted via the canonical
//      regex set in src/telemetry/scrubbing.ts. Keys are
//      vocabulary (operator never controls them), so they pass
//      through untouched.
//
// Size cap: 8 KiB serialized JSON. Past it the payload is
// truncated and an `_truncated: { original_bytes: N }` field is
// added. The cap protects against disk-fill via toxic payloads
// the same way write_file's slice 129 cap protects the FS — the
// failure pipeline shouldn't be turn-key for a runaway sink. The
// truncation marker preserves the signal that the payload was
// non-empty without keeping the actual bytes.
//
// Convention encouraged for downstream-of-decision failures (per
// the slice 131 outcome_signals hook): include
// `payload.approval_seq = <approvals_log.seq>` so the future
// outcome aggregator can join the failure to the approval that
// authorized the tool call. This is documented here as a
// convention, NOT enforced — adding it later via a typed wrapper
// is straightforward.

import { scrubProtoPollution } from '../broker/safe-json.ts';
import { scrubFreeformText } from '../telemetry/scrubbing.ts';

const MAX_PAYLOAD_BYTES = 8 * 1024;

// Slice 130 fixup #5: cycle guard sentinel — symmetric with the
// proto-pollution scrub in broker/safe-json.ts.
const CYCLE_SENTINEL = '__forja_cycle__';

// Walk the object tree applying scrubFreeformText to every string
// value. Arrays + nested objects recurse. Primitives other than
// string pass through. Returns a new tree — never mutates input,
// so callers can reuse their payload object freely.
//
// Cycle guard: a `WeakSet` records every object/array reference
// already visited on the current descent. A re-visit yields a
// CYCLE_SENTINEL string instead of recursing forever. Without
// this, a payload containing a back-reference (Error.cause that
// references its parent, or a future caller logging the result
// of a serializer that emits ref-shapes) would either blow the
// stack or — when called from JSON.stringify in the cap-check
// path — throw `TypeError: Converting circular structure to
// JSON`. Both failures would propagate to the wire-site outer
// try/catch, silently dropping the audit row about another
// failure.
const scrubStringsRecursive = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === 'string') return scrubFreeformText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return CYCLE_SENTINEL;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => scrubStringsRecursive(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubStringsRecursive(v, seen);
  }
  return out;
};

export interface ScrubResult {
  // Serialized JSON ready for the `payload_json` column. Always
  // valid JSON; `null` ONLY when input was null/undefined.
  json: string | null;
  // Whether the cap kicked in. Tests assert this; emit sites can
  // optionally log a warning when truncation actually fires
  // (signal that an emit pattern needs tuning).
  truncated: boolean;
}

export const scrubFailurePayload = (
  payload: Record<string, unknown> | null | undefined,
): ScrubResult => {
  if (payload === null || payload === undefined) return { json: null, truncated: false };

  // Two-pass defense. scrubProtoPollution strips __proto__ /
  // constructor / prototype keys at every depth (slice 130
  // fixup #5: now with cycle guard, replaces cycles with a
  // sentinel string). scrubStringsRecursive then redacts paths/
  // hosts/etc inside string values (also cycle-guarded).
  const protoSafe = scrubProtoPollution(payload);
  const stringSafe = scrubStringsRecursive(protoSafe, new WeakSet());

  // JSON.stringify itself can still throw on shapes the proto +
  // cycle scrub didn't normalize — e.g., BigInt values (not
  // representable in JSON). We catch and replace with a marker
  // payload so the wire-site's row STILL lands instead of being
  // swallowed silently. The marker carries the error class so
  // operators can pinpoint pathological emit sites.
  let json: string;
  try {
    json = JSON.stringify(stringSafe);
  } catch (e) {
    const errClass = e instanceof Error ? e.constructor.name : 'Unknown';
    return {
      json: JSON.stringify({ _scrub_failed: { reason: errClass } }),
      truncated: false,
    };
  }
  const initialBytes = Buffer.byteLength(json, 'utf8');
  if (initialBytes <= MAX_PAYLOAD_BYTES) {
    return { json, truncated: false };
  }

  // Truncation path. We replace the payload with a minimal object
  // that preserves the signal (an event happened) and the size
  // tell (so forensics knows the original was large). We do NOT
  // try to preserve a "head" of the original — partial JSON has
  // no useful shape, and a partial value could itself be a path
  // or token the scrub didn't catch in fragment form.
  const truncatedPayload = {
    _truncated: { original_bytes: initialBytes, cap_bytes: MAX_PAYLOAD_BYTES },
  };
  json = JSON.stringify(truncatedPayload);
  return { json, truncated: true };
};
