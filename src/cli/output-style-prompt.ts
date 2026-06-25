// Eager system-prompt section setting the OUTPUT-density default:
// optimize signal per token, not word count. Lives in the stable
// cache segment (composed once at boot, byte-stable for the session)
// so it NEVER invalidates cache breakpoint #1.
//
// Why STATIC and not per-mode: the stable segment IS the cache
// prefix. Varying it per task (a "chat" vs "architecture" vs "debug"
// mode in the system prompt) would invalidate the prefix on every
// switch — and cache write is the dominant cost axis (a real session:
// ~47%). Per-task density modulation is the `effort` knob, a REQUEST
// parameter that bypasses the prefix entirely; lower effort already
// means terser output and fewer/consolidated tool calls. This section
// sets the floor; `/effort` modulates per task.
//
// Why now: Opus 4.8 narrates more by default than prior models
// (Anthropic's own migration guidance — more text between tool calls,
// longer end-of-task wrap-ups). A "default to silence between tool
// calls" line is the recommended re-tuning.
//
// Density, NOT brevity: the correctness/decision-quality clause is
// load-bearing — it stops the rule from stripping context that
// matters in architecture, debugging, and investigation, where signal
// lives in the detail. The goal is more information per token, not
// fewer tokens.
//
// Cost ceiling: ~55 tokens in the always-on prefix, same budget logic
// as `TOOL_ERGONOMICS_PROMPT` (a small fixed cost amortized by the
// session's cache hit rate). Composed adjacent to the response-format
// block — both are "how you write your output" rules.
export const OUTPUT_STYLE_PROMPT = `# Output
Optimize for signal per token, not word count. State findings before evidence. Default to silence between tool calls — narrate only a finding, a direction change, or a blocker. Keep enough detail to preserve correctness and decision quality; never trade information for brevity.`;

// Compose the output-style hint with a downstream prompt. Hint goes
// FIRST so it reads as a standing default; the downstream (more
// specific layers) follows. Mirrors `composeWithToolErgonomics` /
// `composeWithResponseFormat`. Returns the hint alone when no
// downstream is supplied.
export const composeWithOutputStyle = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) {
    return OUTPUT_STYLE_PROMPT;
  }
  return `${OUTPUT_STYLE_PROMPT}\n\n---\n\n${downstream}`;
};
