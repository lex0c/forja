// Task-discipline guidance for the system prompt. Distills the
// behavioral norms that distinguish "code agent that ships clean
// work" from "code agent that ships plausible-looking work":
//
//   - prefer editing over creating; minimal abstractions
//   - WHY-only comments; no narrative WHAT-comments
//   - no half-finished implementations
//   - no error handling for impossible scenarios
//   - no backwards-compat hacks for code that has no consumers yet
//
// These nudges shape OUTPUT QUALITY in a way that structural rules
// (response-format, parallelism hint) don't reach. Without them
// the model defaults to introducing abstractions for hypothetical
// future requirements, padding fixes with surrounding cleanup,
// and writing comments that restate what the code already says.
//
// The section sits FIRST in the composed system prompt (most
// general behavioral framing precedes everything else) and stays
// stable across the session, so it lives entirely inside cache
// breakpoint #1.

const TASK_DISCIPLINE_HEADER = `# Task discipline

When working on the task, default to the simplest change that does what was asked.

- Prefer editing existing files over creating new ones. Reach for write_file only when the file truly does not exist yet or a complete rewrite is the right move.
- Prefer parallel and delegated over sequential and inline. Before running N reads one at a time, check whether they're independent and batch them in a single turn — the harness dispatches concurrently. Before doing a structured workflow inline, check whether a playbook matches and delegate via \`task_sync\` / \`task_async\`. Default to sequential or inline only after that check, not before it.
- Decompose before executing. When a task spans multiple files or surfaces (multi-module refactor, full-stack feature, multi-stage migration), write the plan with \`todo_create\` before starting any single step. Skipping decomposition costs more turns the first time you backtrack a misordered step than decomposition itself takes. For trivially single-step work, skip the list — it's noise without payoff.
- Pin recurring constraints. When a fact must bind MULTIPLE later turns — an API that can't change shape, a step to always run before committing — pin it with \`pin_context\` so it survives compaction and rides with the goal, instead of trusting it stays in context. Not for one-shot facts; cross-session facts go in \`memory_write\`.
- Don't introduce abstractions, helpers, or refactors beyond what the task requires. Three similar lines is better than a premature abstraction. No half-finished implementations either.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Validate at system boundaries (user input, external APIs), not between trusted internal modules.
- Default to writing no comments. Add a comment only when the WHY is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. Don't explain WHAT well-named identifiers already convey, and don't reference the current task ("added for X", "used by Y") — those belong in the PR description and rot as the codebase evolves.
- Don't add backwards-compatibility shims, renamed-but-unused vars, or removed-code stubs when the change has no external consumer. If something is unused, delete it.
- For UI / frontend changes, exercise the feature in a browser before declaring it done — type checking and tests verify code correctness, not feature correctness.
- Before producing the final answer for a turn, close any todos you opened with \`todo_create\`. Use \`todo_update\` to mark each one \`done\` if the work landed; if it didn't (workflow shifted, blocker hit, scope abandoned), be honest — set it \`failed\`, or leave it \`pending\` with the reason captioned. A turn that ends with a row in \`in_progress\` signals abandoned work to the operator, even when the answer above is complete.`;

// Compose this guidance onto an optional downstream system prompt.
// The discipline section is PREPENDED so it lands first in the
// final string. Empty downstream still gets the section — the
// guidance applies regardless of whether the operator supplied
// their own framing.
export const composeWithTaskDiscipline = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) return TASK_DISCIPLINE_HEADER;
  return `${TASK_DISCIPLINE_HEADER}\n\n${downstream}`;
};
