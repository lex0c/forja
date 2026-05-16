// Memory factuality classifier (MEMORY.md §6.5.2, S2/T2.1).
// Splits memories into FACTUAL (verifiable against current state)
// vs PREFERENCE (subjective claims that drift but can't be
// ground-truthed).
//
// `type` is the canonical axis:
//
//   - `project`   — facts about THIS codebase. File paths, exports,
//                   schema fields, version constraints. Verifiable
//                   via FS read / grep against the active repoRoot.
//   - `reference` — pointers to EXTERNAL systems (Linear projects,
//                   Grafana dashboards, Slack channels). Verifiable
//                   only via external probes (out of scope in v1).
//   - `user`      — facts about the OPERATOR. "Senior engineer",
//                   "deep Go experience", "first time on React".
//                   Subjective — no ground truth in the repo.
//   - `feedback`  — preferences and corrections. "Prefer pure
//                   functions", "always run lint before commit".
//                   By definition a rule the operator stated; no
//                   "current state" to verify against.
//
// The classifier returns true ONLY for `project` and `reference`.
// `user` / `feedback` short-circuit at the dispatcher layer
// before the verifier runs — they're preference data, not facts.

import type { MemoryFrontmatter } from '../types.ts';

export const isMemoryFactual = (frontmatter: MemoryFrontmatter): boolean => {
  return frontmatter.type === 'project' || frontmatter.type === 'reference';
};
