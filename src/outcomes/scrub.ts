// Outcome signal payload sanitizer. Same shape + defenses as
// failure_events' scrub (slice 130): proto-pollution scrub then
// recursive string scrub via the telemetry regex set, with the
// 8 KiB cap and BigInt/cycle/JSON-throw fallback. Slice 131 keeps
// the cap identical so calibration consumers reading either table
// have uniform size expectations.
//
// Re-export rather than inlining a copy: identical semantics
// across both audit tables means one bugfix lands in both. The
// `scrubFailurePayload` name reflects its origin (slice 130)
// but the regex set + scrub passes are generic; outcome signals
// reuse it verbatim.

import { scrubFailurePayload as scrubGeneric } from '../failures/scrub.ts';

export const scrubOutcomePayload = scrubGeneric;
