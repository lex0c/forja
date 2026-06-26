// Base system prompt preamble that surfaces the harness's
// parallelism affordances to the model.
//
// Without this hint, models tend toward the default of one
// tool_use per turn (especially older-generation training
// data). The harness's parallel-tool dispatch (spec
// ORCHESTRATION.md §1.3) and the `task_async` /
// `task_await` family go unused — capability-dormant.
//
// The hint stays compact: tool descriptions carry the per-tool
// "Parallel-safe: ..." line, so the system prompt only needs the
// META rule. It frames parallel as the DEFAULT (not a balanced
// "parallel-when-independent / sequential-when-dependent" choice
// — models under-fan-out, so the burden is inverted: serialize
// ONLY on a real data dependency) and names the concrete
// anti-pattern (looping one read/grep per turn). Anchoring to
// concrete tools (read_file, grep, glob) and the subagent surface
// (task_async/task_await) keeps it actionable rather than abstract.
//
// Composition (principal): in the assembled prompt this hint
// lands AFTER `# Constraints` and BEFORE `# Tool ergonomics` — it
// is NOT the outermost layer (identity, environment, response
// surface, and constraints precede it). The subagent path
// (`subagent-child.ts`) also prepends this hint, there as the
// outermost layer over the playbook body. The authoritative
// top-down layer order for both pipelines lives in
// `docs/CONTEXT.md §5.1`; consult it rather than a per-file
// recap, which is what drifted stale here.
export const PARALLEL_HINT_PROMPT = `# Parallelism

Default to parallelism. When the work is independent, emit MULTIPLE tool calls in a SINGLE turn — the harness dispatches them concurrently and hands you every result at once.

- Read-only tools (\`read_file\`, \`grep\`, \`glob\`, \`memory_read\`, \`memory_list\`, \`memory_search\`) are parallel-safe. The moment you know the set — "read these N files", "search for X, Y, and Z", "check the callers and the definition" — emit them together. Looping one read or grep per turn is the anti-pattern: it serializes work that carries no dependency and pays a round-trip per item.
- For independent subtasks that need a full subagent run, spawn several with \`task_async\` in one turn, then \`task_await\` each to collect. The child's intermediate tool output stays out of your context — you keep the conclusion, not the file dumps — so fanning out is cheaper than reading it all yourself. \`task_cancel\` aborts one whose result is no longer needed; \`task_list\` recovers handle ids you lost track of (long context, post-compaction, after a resume) or confirms what is still in flight before fanning out more.

Sequential dispatch is correct ONLY when a call's inputs depend on a previous call's output — read the file the grep just located, spawn B from A's result. Absent that dependency, fan out; when unsure whether two calls depend, assume they do not.`;

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
