// Base system prompt preamble that fixes the response surface
// (`docs/spec/CONTEXT_TUNING.md §1.5`, `ANTI_PATTERNS.md §1.3`).
//
// The spec is explicit that "be concise" / "explain thoroughly"
// as adjective is rejected — verbosity is a consequence of schema
// + budget, not of tuning. This module exists for the surface
// rules that ARE measurable: render target, code-reference shape,
// emoji default, structural padding (prefaces / summaries). Each
// rule is testable (regex / count / presence-or-absence) and tied
// to the TUI's actual rendering, not to taste.
//
// Persona tuning is explicitly out of scope (`ANTI_PATTERNS.md
// §1.2`). Nothing in this block describes WHO the model is —
// only WHERE its output lands and which structural patterns the
// renderer or operator depend on.
//
// Composition (`bootstrap.ts`): in the assembled prompt this
// section lands after `# Environment` and before `# Constraints`
// — it is NOT the outermost layer (identity and environment
// precede it). The authoritative top-down layer order lives in
// `docs/CONTEXT.md §5.1`; consult it rather than a per-file
// recap, which is what drifted stale here.
//
// Token cost: ~200 tokens. Earns its place ONLY because every
// rule below has a verifiable consequence in the rendered output;
// adding more rules requires the same test.

export const RESPONSE_FORMAT_PROMPT = `# Response surface

The operator's terminal renders your text as CommonMark in monospace ANSI. Format with that target in mind:

- Code, file paths, identifiers, and command lines go inside backticks (\`like_this\`).
- Code references use \`file:line\` form (e.g., \`src/auth.ts:42\`) so the renderer can link them.
- Default to no emojis — use them only if the user asks.
- Don't preface work with "I will…" or end with a recap of what you just did — the operator sees the diff and the tool calls.
- Every sentence should change what the reader knows or does next. When a question is answerable in one sentence, answer in one sentence. Don't pad with headers, bullets, or restated prompts.
- Multi-step internal reasoning belongs in tools (\`todo_create\` for plans the operator should see); chat text is for results and decisions, not commentary on the work in flight.`;

// Compose the response-format hint with a downstream prompt.
// Same shape as `composeWithParallelHint` — hint goes FIRST as
// the most-general background, downstream goes after with a
// `---` separator. Returns the hint alone when no downstream
// was passed.
export const composeWithResponseFormat = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) {
    return RESPONSE_FORMAT_PROMPT;
  }
  return `${RESPONSE_FORMAT_PROMPT}\n\n---\n\n${downstream}`;
};
