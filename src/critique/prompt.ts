// Self-critique prompt (AGENTIC_CLI.md §5.4). The critic is a
// distinct LLM role — it reviews the executor's proposed output and
// emits a structured opinion before the harness commits anything to
// context.
//
// Output contract:
//   - The critic emits ONE JSON object between fixed markers.
//     Markers + JSON (rather than raw JSON) survives providers that
//     wrap output in chatter, partial markdown fences, or refusal
//     prefaces; the parser only needs to find the first `{` after
//     the open marker and the last `}` before the close marker.
//   - JSON shape mirrors §5.4 exactly: `issues[]` with severity,
//     description, confidence, suggestion; plus
//     `overall_confidence`. Field names use snake_case for two
//     reasons: (a) the spec table uses snake_case, (b) Anthropic
//     and OpenAI both bias toward snake_case under JSON instruction.
//
// Versioned: bumping the version string forces audit rows to
// distinguish replays of older critiques from new ones.

import type { CritiqueInput, CritiqueToolPlanEntry } from './types.ts';

export const CRITIQUE_PROMPT_VERSION_V1 = 'v1';
export const DEFAULT_CRITIQUE_PROMPT_VERSION = CRITIQUE_PROMPT_VERSION_V1;

export const CRITIQUE_MARKER_OPEN = '[critique]';
export const CRITIQUE_MARKER_CLOSE = '[/critique]';

// System prompt for the critic. Holds two invariants the parser
// relies on:
//   1. Output is wrapped between the two markers — nothing else.
//   2. The wrapped block is a single JSON object literal.
// Anything outside the markers is allowed (some models add a
// "Sure, here:" preface) but ignored.
export const CRITIQUE_SYSTEM_PROMPT_V1 = `You are a code review critic. An autonomous coding agent has just produced an output (assistant text and/or tool calls) in response to a user prompt. Your job: REVIEW the proposed output BEFORE it commits, and surface concrete issues — bugs, missed requirements, unsafe operations, unjustified assumptions, gaps in the plan.

The output you are reviewing has NOT been committed or executed. Tool calls are PROPOSED, not run. Frame your issues as "before-the-fact" — what would go wrong if this output proceeded as-is.

Output rules:
- Emit EXACTLY ONE JSON object wrapped between the markers ${CRITIQUE_MARKER_OPEN} and ${CRITIQUE_MARKER_CLOSE}.
- Anything outside the markers is ignored. Do not emit prose explanations outside the markers.
- Do not invent issues. If the output looks correct, emit an empty issues array with high overall_confidence.

JSON schema:
{
  "issues": [
    {
      "severity": "info" | "warn" | "error",
      "description": "what is wrong, in one or two short sentences",
      "confidence": <float 0..1, how sure you are this is a real issue>,
      "suggestion": "what the executor should do instead, in one sentence"
    }
  ],
  "overall_confidence": <float 0..1, your confidence in the proposed output as a whole>
}

Severity guide:
- error: would break the user's intent or introduce a bug if run as-is.
- warn: smells off — probable issue but not certain, or minor correctness concern.
- info: stylistic / clarity nit; never a blocker.

Confidence guide:
- 1.0 — certainty (the output literally contradicts a stated requirement).
- 0.7 — clear signal (an experienced reviewer would flag this).
- 0.5 — coin flip. Lean toward NOT emitting at all unless severity=error.
- < 0.5 — do not emit. Issues this uncertain are noise.

If you have nothing to flag, emit:
${CRITIQUE_MARKER_OPEN}
{"issues":[],"overall_confidence":1.0}
${CRITIQUE_MARKER_CLOSE}`;

// Strip any pre-existing `[critique]...[/critique]` block(s) from a
// string. The markers are well-known constants — without this scrub,
// a malicious `assistantText` (jailbroken model, poisoned tool
// output, copy-pasted regression fixture) carrying its own marker
// pair would short-circuit the parser: `extractMarkerPayload` finds
// the FIRST pair, so injected content trumps the critic's real
// response.
//
// Mirrors the `stripPriorSummary` defense in `compaction.ts`. Same
// trade-off: a legitimate input that happens to contain the literal
// markers gets partially corrupted (the inner block is removed). We
// accept that to close the injection vector — operators producing
// content with these literal strings should be exceedingly rare,
// while the injection vector is real for any model or upstream tool
// that handles attacker-controlled text.
//
// Non-greedy match across newlines so multiple consecutive blocks
// are each stripped independently. The `\n*` anchors at both ends
// also collapse extra blank lines around the removed block so the
// surrounding text reads cleanly.
const CRITIQUE_BLOCK_RE = /\n*\[critique\][\s\S]*?\[\/critique\]\n*/g;

export const stripPriorCritique = (text: string): string =>
  text.replace(CRITIQUE_BLOCK_RE, '\n').trim();

// Render the user-side message that carries the executor's proposal.
// Kept separate from the system prompt so the critic's instructions
// stay pinned and only the per-call payload varies — caching-friendly
// for providers that cache the system block.
//
// All free-form input fields are scrubbed via `stripPriorCritique`
// to defeat the marker-injection vector. `userPrompt` is most
// risky (operator-supplied or tool-result-derived), but
// `assistantText` and `executorSystemPrompt` go through the same
// scrub for symmetry — a defensive layer should not depend on
// "this field is trusted" assumptions that drift over time.
export const renderCritiqueUserMessage = (input: CritiqueInput): string => {
  const sections: string[] = [];

  const userPrompt = stripPriorCritique(input.userPrompt);
  sections.push(`USER PROMPT:\n${userPrompt.length > 0 ? userPrompt : '(empty)'}`);

  if (input.executorSystemPrompt !== undefined) {
    const sys = stripPriorCritique(input.executorSystemPrompt);
    if (sys.length > 0) {
      sections.push(`EXECUTOR SYSTEM PROMPT (background):\n${sys}`);
    }
  }

  const text = stripPriorCritique(input.assistantText);
  sections.push(
    `PROPOSED ASSISTANT OUTPUT:\n${text.length > 0 ? text : '(no text — only tool calls)'}`,
  );

  if (input.toolPlan !== undefined && input.toolPlan.length > 0) {
    sections.push(`PROPOSED TOOL CALLS (NOT YET EXECUTED):\n${renderToolPlan(input.toolPlan)}`);
  }

  sections.push(
    'Review the proposal. Emit your structured critique between the markers. Nothing else.',
  );

  return sections.join('\n\n');
};

// Render one tool-plan entry. The `args` object goes through
// JSON.stringify; if it contained a literal `[critique]` substring
// (a string field with attacker-controlled content), the resulting
// JSON string would carry it through to the critic's user message.
// We scrub the SERIALIZED form rather than walking the object —
// catches the common case (string values) and is robust to nested
// shapes without hand-rolling a deep walk. JSON.stringify on a
// scrubbed form roundtrips as itself, so no JSON-shape damage; the
// only effect is that any internal `[critique]` substring in a
// string field is replaced with a newline.
const renderToolPlan = (plan: readonly CritiqueToolPlanEntry[]): string =>
  plan
    .map((entry, idx) => {
      const tag = entry.writes ? '[writes:true]' : '[read-only]';
      const args = stripPriorCritique(JSON.stringify(entry.input, null, 2));
      return `${idx + 1}. ${entry.name} ${tag}\nargs: ${args}`;
    })
    .join('\n\n');
