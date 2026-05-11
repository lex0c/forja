// Context summary for the classifier hint per PERMISSION_ENGINE.md §6.4.
//
// The classifier receives, among other inputs, "contexto resumido
// (últimos N steps, sumarizados pela engine)". This module owns the
// SUMMARIZATION primitive: given an engine-controlled ring buffer of
// recent decisions, render a model-readable string the classifier
// can branch on WITHOUT ever seeing adversary-controlled bytes.
//
// Spec §6.4 invariants enforced here:
//
//   - NO raw args (the resolver already canonicalized capability
//     STRINGS; we strip further to capability KINDS only).
//   - NO tool outputs (never present in the entry shape — the
//     engine doesn't have them; this module wouldn't accept them
//     even if it did).
//   - NO file contents (same as outputs).
//   - NO web-fetched bytes (same).
//
// The entry shape carries only registry-controlled or canonical
// fields:
//
//   - toolName: registered via the harness, not user-supplied at the
//     wire.
//   - decision: 'allow' / 'deny' / 'confirm' — engine's own output.
//   - capabilityKinds: the closed `CapabilityKind` enum. We
//     deliberately drop SCOPES (paths, hosts) at this layer — even
//     though the resolver canonicalized them, scopes can still
//     contain operator-meaningful fragments (`/home/op/secret.txt`)
//     that aren't worth surfacing to a sometimes-remote classifier.
//
// Format: one line per step, capped to `maxBytes` bytes total. If
// the next entry's bytes would push the total past the cap, we stop
// at the entries that fit — the truncation is implicit (no `...`
// marker) so byte budgets are deterministic across runs and the
// chain hash stays stable.

import type { CapabilityKind } from './capabilities.ts';

export interface ContextSummaryEntry {
  toolName: string;
  decision: 'allow' | 'deny' | 'confirm';
  capabilityKinds: readonly CapabilityKind[];
}

export interface BuildContextSummaryOptions {
  // Byte ceiling for the full string. Default 1024 (1 KiB). The
  // classifier prompt has bounded budget; 1 KiB is more than enough
  // for ~30 condensed entries and keeps tokens predictable.
  maxBytes?: number;
}

// Default byte ceiling. Sourced here so tests + audit replays can
// reference the canonical value rather than re-encoding the literal.
export const DEFAULT_CONTEXT_SUMMARY_MAX_BYTES = 1024;

// Default ring-buffer depth (number of entries retained). Spec §6.4
// says "últimos N steps"; the v2 baseline picks 10 — enough recent
// activity to surface a "this is the 4th `bash rm` in a row" pattern,
// small enough that the classifier doesn't pay a token tax for stale
// context. Calibration can adjust the constant via the option below.
export const DEFAULT_CONTEXT_SUMMARY_DEPTH = 10;

// Format a single entry. Stable, parseable shape so the classifier
// can branch on it programmatically and audit replays can diff
// summaries across versions. No leading/trailing whitespace; one
// line per call.
const formatEntry = (entry: ContextSummaryEntry, index: number): string => {
  // Sort kinds alphabetically so two semantically-equivalent entries
  // produce byte-identical strings (chain-hash determinism + replay).
  const kinds = entry.capabilityKinds.slice().sort().join(',');
  // Empty caps render as `caps=-`; a classifier that wants to special-
  // case "no observed effects" gets a stable marker instead of
  // `caps=` with nothing after it.
  const capsField = kinds.length > 0 ? kinds : '-';
  return `step ${index + 1}: tool=${entry.toolName} decision=${entry.decision} caps=${capsField}`;
};

// Build the summary string from the buffer's chronological order
// (oldest first → newest last). Spec §6.4 "últimos N steps" — the
// caller is responsible for retaining only the last N entries; this
// renderer assumes the caller already trimmed.
//
// Byte cap enforcement: we walk entries in order and stop AS SOON AS
// the next line would push the running total past `maxBytes`. The
// caller gets only the entries that fit. If even the FIRST entry
// doesn't fit, the result is empty (defensive; a classifier that
// receives no summary degrades gracefully — same as if the engine
// had zero history).
export const buildContextSummary = (
  buffer: readonly ContextSummaryEntry[],
  options: BuildContextSummaryOptions = {},
): string => {
  const maxBytes = options.maxBytes ?? DEFAULT_CONTEXT_SUMMARY_MAX_BYTES;
  if (buffer.length === 0 || maxBytes <= 0) return '';

  const lines: string[] = [];
  let bytes = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const entry = buffer[i];
    if (entry === undefined) continue;
    const line = formatEntry(entry, i);
    // +1 for the newline joiner (only counted between lines; the
    // first entry has no leading newline).
    const candidate = bytes === 0 ? line.length : bytes + 1 + line.length;
    if (candidate > maxBytes) break;
    lines.push(line);
    bytes = candidate;
  }
  return lines.join('\n');
};

// Ring buffer with bounded depth. Push appends; snapshot returns
// the chronological list (oldest first). The buffer never resizes
// past `depth` — pushing into a full buffer evicts the oldest entry.
//
// Implementation note: a `readonly` snapshot is cloned each call
// (cheap at the v2 depth of ~10 entries) so a caller that mutates
// the result can't corrupt buffer state. Same defensive convention
// as `engine.policy()` returning a deep copy.
export interface ContextSummaryBuffer {
  // Append an entry. Evicts the oldest when the buffer is full.
  push(entry: ContextSummaryEntry): void;
  // Snapshot in chronological order. Caller may mutate freely.
  snapshot(): ContextSummaryEntry[];
  // For tests / debug — current entry count.
  size(): number;
}

export const createContextSummaryBuffer = (
  depth = DEFAULT_CONTEXT_SUMMARY_DEPTH,
): ContextSummaryBuffer => {
  const entries: ContextSummaryEntry[] = [];

  const push = (entry: ContextSummaryEntry): void => {
    entries.push(entry);
    while (entries.length > depth) {
      entries.shift();
    }
  };

  const snapshot = (): ContextSummaryEntry[] => entries.slice();

  const size = (): number => entries.length;

  return { push, snapshot, size };
};
