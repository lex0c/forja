// Prompt for the `pr` renderer, version v1. RECAP.md §7.1 says
// each prompt is versioned by file name; bumping is a copy of this
// file to `pr-v2.ts` so the prior version stays observable.
//
// The prompt does NOT generate markdown. It tells the model to
// emit a structured JSON shape (PrRenderV1) that a deterministic
// template (template.ts) then renders. Schema enforcement is
// native (forced tool_choice on Anthropic); the prompt augments
// that with the negative constraints from RECAP.md §7.3 to push
// for fidelity inside the schema's allowed shape.

import type { RecapIntermediate } from '../types.ts';

export const PR_PROMPT_VERSION = 'pr-v1' as const;

const stringifyForPrompt = (value: unknown): string => JSON.stringify(value, null, 2);

// Build the system+user pair the provider receives. Returns just
// the user content; system is supplied separately so the cache
// breakpoint logic in providers/anthropic/cache.ts can anchor it.
export const buildPrPromptV1 = (
  intermediate: RecapIntermediate,
): { system: string; user: string } => {
  // Hard rules mirror RECAP.md §7.3 verbatim. Schema enforcement
  // (forced tool_choice on Anthropic) handles the structural side
  // — these rules cover the semantic side that schema cannot:
  // hallucination of values, voice, decoration, speculative
  // motivation. Adding a rule here means an eval fixture should
  // exercise it; bumping the prompt version (pr-v2) is a copy of
  // this file, never an in-place edit.
  const system = [
    'You convert a structured recap of an agent session into a PR description.',
    'Output is constrained to the `render_recap_pr` schema; you cannot add fields.',
    '',
    'Hard rules:',
    '- Do NOT invent files, decisions, costs, or commands. Every value MUST be',
    '  traceable to a field in the supplied recap intermediate.',
    '- Do NOT use first person ("I", "we", "the agent"). Use passive voice or',
    '  imperative mood: "Extracted helper", "Added 3 tests".',
    '- Do NOT repeat the goal text verbatim across multiple summary bullets.',
    '- Do NOT include emoji, ANSI escape sequences, or other stylistic decoration.',
    '- Do NOT speculate about motivations beyond what is recorded in `decisions[].why`.',
    '- Each `changes[].path` MUST appear exactly as given in `actions.filesWritten`.',
    '- Stay within the per-field caps declared in the schema.',
  ].join('\n');

  // The user message contains the canonical intermediate. We pass
  // the full structure (caps, errors, decisions, actions) — the
  // schema then constrains what the model can DO with it. Forcing
  // it to look at the literal data rather than a digest avoids
  // accidental loss of information that a prose-summary prompt
  // would risk.
  const user = [
    'Render the following recap intermediate as a PR description per the',
    'forced `render_recap_pr` tool. Use only fields present below.',
    '',
    '```json',
    stringifyForPrompt(intermediate),
    '```',
  ].join('\n');

  return { system, user };
};
