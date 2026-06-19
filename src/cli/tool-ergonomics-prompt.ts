// Eager system-prompt section that surfaces the highest-payoff
// tool-usage patterns from `docs/spec/TOOL_ERGONOMICS.md`. The
// spec doc itself stays as the source of truth (143 lines,
// catalogue of patterns + anti-patterns); this composer
// distills the small set of rules that:
//
//   1. Models default to the worse version observably (criterion
//      from `TOOL_ERGONOMICS.md §0`).
//   2. Save tokens / latency / risk MEASURABLY when fixed,
//      across every turn, not just inside a specific playbook.
//   3. Need to apply BEFORE the model decides what to call —
//      a pointer (via playbook `references:`) is a weak signal
//      for usage rules; the model has to internalize them at
//      decision time, not look them up after a failure.
//
// Keeping the section short on purpose: the full spec lands
// inline in playbooks that need depth via the existing
// `references:` mechanism. Here we want the rules that pay off
// every turn — base prompt territory, where 80 tokens × ~70%
// cache hit rate is the right cost ceiling.
//
// Patterns intentionally OUT of scope here:
//   - macOS-vs-Linux flag deltas (§3): sufficiently rare per
//     turn that base-prompt cost outweighs the value.
//   - Loop-vs-glob ergonomics (§4): legitimate edge cases exist
//     (per-iteration error handling); a base-prompt rule risks
//     overrule.
//   - The `rg` vs `grep` choice (§3): conditional on tool
//     availability — handle in tool descriptions where the
//     `command -v rg` probe lives, not as a blanket directive.
//
// Composition: this preamble is prepended after the parallelism
// hint (which is more foundational — "you can do many things at
// once") so the operating mode reads as: parallelism THEN
// efficiency THEN whatever the user / playbook specified.
export const TOOL_ERGONOMICS_PROMPT = `# Tool ergonomics

When picking tool calls, default to the patterns below. Full catalogue at \`docs/spec/TOOL_ERGONOMICS.md\` if you need depth.

- **Slice before reading.** When you know what you're looking for, do not read whole files. \`grep -n 'pattern' file\` returns line numbers; pass the line as \`offset\` to \`read_file\` with a small \`limit\`. Cost: ~50 tokens vs ~5000.
- **Filter before stdout.** Bash output that exceeds one screen burns context with no payoff. Pipe through \`head\`, \`grep\`, \`sed\`, or redirect to a file before the bytes hit your context window.
- **Scope conservatively.** \`find .\` not \`find /\`. Specific globs (\`src/**/*.ts\`) not \`**/*\`. \`grep -rn ... --include='*.py'\` not unfiltered tree-walks.
- **Prefer dedicated tools where they exist.** \`read_file\` over \`cat\`, \`edit_file\` over \`sed -i\` — they preserve semantics (encoding, atomic edits, structured args) and avoid flag drift. Search goes through \`bash\` (\`rg\`/\`grep\`); the \`grep\`/\`git\` tools sit behind \`tool_search\`.
- **Do not re-read in the same session.** If you read a file earlier in this session, do NOT read it again unless you suspect the file changed since (you ran an edit tool, the user mentioned a change, time passed). Cached context is free; redundant reads burn tokens.
- **Failed tool? Diagnose, do not retry blindly.** If a bash command failed, check cwd and arguments before issuing the same call again. Three failed retries of the same command is the operator's signal you are stuck.`;

// Compose the tool-ergonomics hint with a downstream prompt.
// Hint goes FIRST so it reads as background; downstream is the
// more-specific layer. Mirrors `composeWithParallelHint`.
// Returns the hint alone when no downstream is supplied.
export const composeWithToolErgonomics = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) {
    return TOOL_ERGONOMICS_PROMPT;
  }
  return `${TOOL_ERGONOMICS_PROMPT}\n\n---\n\n${downstream}`;
};
