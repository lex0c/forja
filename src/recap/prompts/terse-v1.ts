// Prompt for the `terse` renderer, version v1. RECAP §4.6.

import { redactSecretsInIntermediate } from '../format.ts';
import type { RecapIntermediate } from '../types.ts';

export const TERSE_PROMPT_VERSION = 'terse-v1' as const;

const stringifyForPrompt = (value: unknown): string => JSON.stringify(value, null, 2);

export const buildTersePromptV1 = (
  intermediate: RecapIntermediate,
): { system: string; user: string } => {
  const system = [
    'You convert a structured recap of an agent session into a single sentence.',
    'Output is constrained to the `render_recap_terse` schema; you cannot add fields.',
    '',
    'Hard rules (RECAP §7.3):',
    '- Output is exactly ONE sentence, ≤ 200 characters total.',
    '- Do NOT invent files, decisions, costs, or durations. Every value MUST be',
    '  traceable to a field in the supplied recap intermediate.',
    '- Do NOT use first person ("I", "we", "the agent"). Past tense:',
    '  "Refactored ...", "Added ...", "Removed ...".',
    '- Do NOT include emoji, ANSI escape sequences, or stylistic decoration.',
    '- Do NOT speculate about motivations beyond what is recorded in `decisions[].why`.',
    '- Surface the most material thing first (the goal or the headline change),',
    '  then quantitative summary (file count, test pass), then duration and cost.',
    '- End with a single period.',
  ].join('\n');

  // Redact secrets before serializing (see `pr-v1.ts` for the
  // canonical rationale — SECURITY §6.2).
  const user = [
    'Render the following recap intermediate as a single-sentence summary per the',
    'forced `render_recap_terse` tool. Use only fields present below.',
    '',
    '```json',
    stringifyForPrompt(redactSecretsInIntermediate(intermediate)),
    '```',
  ].join('\n');

  return { system, user };
};
