// Template for `.agent/config.toml` written by `agent init`.
// Spec: AGENTIC_CLI.md §2.1.1.
//
// Posture: the scaffolded file contains ACTIVE values for every
// operator-tunable section ([providers], [budget], [memory]) sourced
// from the canonical code defaults. Operator opens the file, sees the
// running values literal in front of them, edits in-place to override.
//
// NO comments are written into the scaffold. Two reasons:
//
//   1. `/memory governance enable|disable` rewrites the file via
//      TOML round-trip (parse → mutate → emit), and `Bun.TOML.parse`
//      does not preserve comments. A richly-commented scaffold would
//      silently lose every line of inline documentation on the first
//      slash toggle — operator-visible promise broken at exactly
//      the moment the operator first acted on the file.
//   2. With active values present, the file IS its own
//      documentation: section names and key names ARE the schema.
//      The full schema reference (with descriptions, valid ranges,
//      illustrative non-default values) lives in AGENTIC_CLI.md
//      §2.1.1, where comments don't get rewritten.
//
// The code-side DEFAULT_BUDGET / DEFAULT_MEMORY_CONFIG remain
// authoritative as safety floors (fresh install before init,
// programmatic test seams, subagent_run contexts that don't carry
// config). When the operator edits a value in config.toml, the
// per-key merge in the bootstrap layer overrides the code default
// for that key only — other keys still inherit the code-side floor.

import type { MemoryConfigKeys } from '../config/loaders.ts';
import type { RunBudget } from '../harness/types.ts';

export interface InitConfigDefaults {
  model: string;
  budget: RunBudget;
  memory: MemoryConfigKeys;
}

// Quote a TOML string value defensively — handles backslash and
// double-quote in the unlikely case a future model id / mode enum
// carries one. Values written today (model registry ids, the
// 'off'|'on_writes'|'always' enum) are safe ASCII, so this is
// belt-and-suspenders for forward-compat.
const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const renderInitConfigTemplate = (defaults: InitConfigDefaults): string => {
  const { model, budget: b, memory: m } = defaults;
  // maxCostUsd is `number | undefined` — explicit-undefined is
  // operator opt-out semantics (RunBudget docstring at
  // harness/types.ts:484). DEFAULT_BUDGET ships it as 5, but
  // defensively skip the line when the caller hands us undefined
  // so the scaffold doesn't write `max_cost_usd = undefined` as
  // literal text.
  const maxCostLine = b.maxCostUsd !== undefined ? `max_cost_usd = ${b.maxCostUsd}\n` : '';
  return `[providers]
model = ${tomlString(model)}

[budget]
max_steps = ${b.maxSteps}
${maxCostLine}max_wall_clock_ms = ${b.maxWallClockMs}
max_step_stall_ms = ${b.maxStepStallMs}
compaction_threshold = ${b.compactionThreshold}
compaction_preserve_tail = ${b.compactionPreserveTail}
compaction_relevance = ${b.compactionRelevance}

[memory]
verify_semantic_llm = ${m.verifySemanticLlm}
conflict_detect_llm = ${m.conflictDetectLlm}
override_detect_llm = ${m.overrideDetectLlm}
`;
};
