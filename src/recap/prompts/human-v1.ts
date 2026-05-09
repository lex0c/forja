// Prompt for the `human` renderer's `## Resumo` section, version
// v1. Bumping is a copy of this file to `human-v2.ts`, never an
// in-place edit (RECAP §7.1).

import type { RecapIntermediate } from '../types.ts';

export const HUMAN_PROMPT_VERSION = 'human-v1' as const;

const stringifyForPrompt = (value: unknown): string => JSON.stringify(value, null, 2);

export const buildHumanPromptV1 = (
  intermediate: RecapIntermediate,
): { system: string; user: string } => {
  const system = [
    'You convert a structured recap of an agent session into the `## Resumo`',
    'section of a human-facing recap. The section is 1–5 short bullets that',
    'distill what mattered in this session for someone reviewing it later.',
    'Output is constrained to the `render_recap_human` schema; you cannot add fields.',
    '',
    'Hard rules (RECAP §7.3):',
    '- Do NOT invent files, decisions, costs, or commands. Every value MUST be',
    '  traceable to a field in the supplied recap intermediate.',
    '- Do NOT use first person ("I", "we", "the agent"). Past tense or',
    '  imperative: "Refactored ...", "Decided to ...".',
    '- Do NOT include emoji, ANSI escape sequences, or stylistic decoration.',
    '- Do NOT speculate about motivations beyond what is recorded in `decisions[].why`.',
    '- Lead with the most material change (the goal restated, the headline',
    '  outcome). Subsequent bullets call out user-approved decisions, then',
    '  notable outcomes / not-done items.',
    '- Bullets are sentences, no trailing period required. ≤ 200 chars each.',
    '- Skip purely mechanical counts ("3 files edited") — those land in the',
    '  deterministic `## What changed` section that follows.',
  ].join('\n');

  const user = [
    'Render the `## Resumo` bullets per the forced `render_recap_human` tool.',
    'Use only fields present below.',
    '',
    '```json',
    stringifyForPrompt(intermediate),
    '```',
  ].join('\n');

  return { system, user };
};
