// Base system prompt preamble that surfaces the harness's
// parallelism affordances to the model.
//
// Without this hint, models tend toward the default of one
// tool_use per turn (especially older-generation training
// data). The harness's parallel-tool dispatch (spec
// ORCHESTRATION.md §1.3) and the `task_async` /
// `task_await` family go unused — capability-dormant.
//
// The hint is short on purpose: tool descriptions carry the
// per-tool "Parallel-safe: ..." line, so the system prompt
// only needs to teach the META rule ("emit several tool_uses
// in one turn when the work is independent"). Anchoring the
// rule to concrete tools (read_file, grep, glob) and the
// concrete subagent surface (task_async/task_await) keeps it
// actionable rather than abstract.
//
// Composition: this preamble is prepended to whatever
// system prompt the caller supplied. The model sees parallelism
// guidance FIRST so it has it as background; the user-supplied
// prompt appears AFTER as the more specific instruction layer. A
// separator makes the boundary visible to the model and to anyone
// debugging the prompt.
export const PARALLEL_HINT_PROMPT = `# Parallelism

When the work is independent, emit MULTIPLE tool calls in a SINGLE turn — the harness dispatches them concurrently:

- Read-only tools (\`read_file\`, \`grep\`, \`glob\`, \`memory_read\`, \`memory_list\`, \`memory_search\`) are parallel-safe. Batch them in one turn instead of looping turn-by-turn.
- For independent subtasks that need a full subagent run, use \`task_async\` to spawn several subagents in parallel, then \`task_await\` each to collect their outputs. Use \`task_cancel\` to abort one mid-run if its results are no longer needed.
- Use \`task_list\` to recover handle ids you may have lost track of (long context, post-compaction, after a resume) or to confirm what is still in flight before fanning out more work.

Sequential dispatch is the right call when each step depends on the previous one's result; parallel dispatch is the right call when steps are independent. Default to parallel for read-heavy exploration ("explore these N files", "search for X across the tree") and for fan-out subagent work ("review these three modules in parallel").`;

// Compose the parallelism hint with a downstream (caller-
// supplied) prompt. The hint goes FIRST as the background
// framing; the more-specific prompt goes after. Returns the
// hint alone when no
// downstream prompt was passed — the call site's
// `length === 0` check still distinguishes empty-string from
// undefined.
export const composeWithParallelHint = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) {
    return PARALLEL_HINT_PROMPT;
  }
  return `${PARALLEL_HINT_PROMPT}\n\n---\n\n${downstream}`;
};
