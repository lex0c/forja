// Memory verification (MEMORY.md §6.5.2, Slice 2). The verifier
// substrate runs heuristics over factual memories to detect drift
// against current repo/FS state. A `contradicted` verdict drives
// `transitionMemoryState` to quarantine; `unknown` is silent (the
// heuristic couldn't ground-truth the claim, which is the default
// outcome for the long tail of memories with non-extractable prose).
//
// "verify" here means: heuristic check against repoRoot. Not LLM
// judge, not semantic equivalence — only patterns with unambiguous
// ground truth (file-exists, export resolution, path:line lookup).
// The bar is deliberately high: false-positive auto-quarantines
// erode operator trust in every detector, so the verifier
// short-circuits to `unknown` whenever the claim shape doesn't
// match a handled pattern. An LLM-judge second pass is a future
// opt-in extension, NOT default behavior.

import type { MemoryFile, MemoryScope } from '../types.ts';

// Discriminated verdict shape. `passed` is silent (no audit row,
// no state transition — verification succeeded against current
// reality). `unknown` is forensic-only (logged to stderr; no
// state change). `contradicted` triggers the state machine.
export type VerifyResult =
  | { kind: 'passed' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'contradicted'; claim: string; expected: string; observed: string };

// One verifier per memory `type`. The runtime composes verifiers
// by type — `project` claims run against the FS, `reference`
// claims would probe external systems (Linear, Grafana — out of
// scope in v1; stub returns `unknown`).
export interface MemoryVerifier {
  // Stable id for audit / debug (e.g., 'project-fs', 'reference-stub').
  readonly id: string;
  // Async because future verifiers may need network probes;
  // current v1 ProjectVerifier is sync-shaped but boxed in a
  // Promise for the interface to stay forward-compatible.
  verify(input: VerifyInput): Promise<VerifyResult>;
}

export interface VerifyInput {
  scope: MemoryScope;
  name: string;
  file: MemoryFile;
  // Resolved repo root for FS-based verifiers. Absolute path.
  // When the boot couldn't resolve a repo (subdir outside git),
  // factual verification is skipped at the dispatcher layer
  // before reaching the verifier — verifiers don't need to
  // double-check.
  repoRoot: string;
}
