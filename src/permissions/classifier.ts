// Classifier hint per PERMISSION_ENGINE.md §6.4.
//
// An optional, hint-only signal that adjusts the deterministic score
// by ±0.2 clamped. The classifier exists to catch patterns the
// deterministic rules don't enumerate — novel attack shapes, "benign
// looking but malicious" sequences, etc. — but it can NEVER produce
// a decision the deterministic floor wouldn't already produce. Its
// job is to nudge borderline scores, not to gate.
//
// Three invariants from the spec, all enforced here:
//
//   1. The classifier NEVER sees raw args, tool outputs, file
//      contents, or web fetches. Its input carries only:
//        - tool name (registry-controlled string)
//        - resolved capability STRINGS (already formatted; no
//          raw arg values)
//        - the deterministic score (a number)
//        - the classifier hash (version pin for replay)
//        - an optional context summary (engine-built; not
//          model-controlled)
//      This is the defense against prompt injection IN the
//      classifier — adversary-controlled bytes never reach it.
//
//   2. Output is clamped to [-0.2, +0.2]. A misbehaving classifier
//      returning +1.0 / NaN / Infinity / garbage cannot push the
//      score outside the deterministic + 0.2 ceiling. `clampAdjust`
//      is the only path into the engine.
//
//   3. Failure (offline, schema invalid, throw) emits
//      `classifier_unavailable` in the reason chain. In strict
//      mode (`classifierRequired`), the engine transitions to
//      `degraded`. In lenient mode (default), the deterministic
//      score is kept as-is and the call proceeds.
//
// The interface is SYNC. The engine's check() is sync; making the
// classifier async cascades into every consumer (audit, modal, REPL,
// CLI). When a real ML classifier with inference latency lands, the
// caller wraps it with a precomputed cache or a sync stub that
// defers to a background worker — the engine doesn't model that.

import type { Capability } from './capabilities.ts';
import { formatCapability } from './capabilities.ts';

export interface ClassifierInput {
  toolName: string;
  // Capability strings (already canonical-formatted). The classifier
  // can branch on capability kinds and on scope structure without
  // touching raw paths or hosts the model controlled.
  capabilities: readonly string[];
  // Deterministic score from §6.3. Classifier sees what the rules
  // already concluded so its adjust is RELATIVE to that floor.
  score: number;
  // Version pin for the classifier model. Audit row records this so
  // a model swap mid-install shows up in forensic replays.
  classifierHash: string;
  // Free-text engine-built summary of recent activity (last N
  // steps), MEANT to be model-readable. Capped + sanitized
  // upstream so adversary-controlled bytes from tool outputs
  // don't leak in. Caller-supplied; defaults to empty.
  contextSummary?: string;
}

export interface ClassifierOutput {
  // Number in (-Infinity, Infinity) at construction; engine clamps
  // to [-0.2, 0.2] before applying. NaN/Infinity treated as a
  // schema failure (validate rejects).
  score_adjust: number;
  // Operator-facing one-liner. Surfaced in the audit row's reason
  // chain and the modal preview when classifier is consulted.
  reason: string;
}

// Sync function type. `null` return means "no signal available
// right now" — same effect as `classifier_unavailable`. The engine
// treats null + thrown exception identically: lenient → continue,
// strict → degrade.
export type Classifier = (input: ClassifierInput) => ClassifierOutput | null;

// Clamp bounds per spec §6.4. Exported so tests + callers can
// reference the canonical values rather than re-encoding them.
export const CLASSIFIER_ADJUST_BOUNDS = { min: -0.2, max: 0.2 } as const;

// Clamp an arbitrary number into the score-adjust range. Treats
// NaN as 0 (no adjust — neutral) so a classifier returning NaN
// doesn't poison the chain hash. Infinity / -Infinity clamp to the
// bounds. The audit row records the POST-clamp value; the raw
// classifier output is not persisted.
export const clampAdjust = (raw: number): number => {
  if (Number.isNaN(raw)) return 0;
  if (raw > CLASSIFIER_ADJUST_BOUNDS.max) return CLASSIFIER_ADJUST_BOUNDS.max;
  if (raw < CLASSIFIER_ADJUST_BOUNDS.min) return CLASSIFIER_ADJUST_BOUNDS.min;
  return raw;
};

// Schema gate. Returns the output unchanged when it passes; null
// when the shape is wrong (treated as `classifier_unavailable`
// downstream). The check is intentionally narrow — wrong shape is
// a programming bug or a hostile classifier, both of which warrant
// the unavailable path.
export const validateClassifierOutput = (output: unknown): ClassifierOutput | null => {
  if (output === null || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (typeof o.score_adjust !== 'number') return null;
  if (typeof o.reason !== 'string') return null;
  // NaN slips past `typeof === 'number'`. `clampAdjust` would
  // canonicalize NaN to 0, but explicit rejection at the schema
  // layer keeps the audit row honest: an unavailable classifier
  // is not the same as one returning "no adjust".
  if (Number.isNaN(o.score_adjust)) return null;
  return { score_adjust: o.score_adjust, reason: o.reason };
};

// No-op classifier. Returns null for every call — same effect as
// "no classifier configured", but distinguishable in tests because
// the function reference identity is stable.
export const createNoopClassifier = (): Classifier => () => null;

// Build the input shape from engine state. Keeps construction
// centralized so adding a new field (e.g. classifierVersion) is one
// edit. Also enforces the "no raw args" invariant by literally not
// accepting raw args here — the engine NEVER has the chance to leak
// them.
export interface BuildClassifierInputArgs {
  toolName: string;
  capabilities: readonly Capability[];
  score: number;
  classifierHash: string;
  contextSummary?: string;
}

export const buildClassifierInput = (args: BuildClassifierInputArgs): ClassifierInput => ({
  toolName: args.toolName,
  capabilities: args.capabilities.map(formatCapability),
  score: args.score,
  classifierHash: args.classifierHash,
  ...(args.contextSummary !== undefined ? { contextSummary: args.contextSummary } : {}),
});
