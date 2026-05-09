// Prompt for the `slack` renderer, version v1. RECAP §4.4
// (ASCII-template variant).

import type { RecapIntermediate } from '../types.ts';

export const SLACK_PROMPT_VERSION = 'slack-v1' as const;

const stringifyForPrompt = (value: unknown): string => JSON.stringify(value, null, 2);

export const buildSlackPromptV1 = (
  intermediate: RecapIntermediate,
): { system: string; user: string } => {
  const system = [
    'You convert a structured recap of an agent session into a Slack-friendly status post.',
    'Output is constrained to the `render_recap_slack` schema; you cannot add fields.',
    '',
    'Hard rules (RECAP §7.3):',
    '- Do NOT invent files, decisions, costs, or durations. Every value MUST be',
    '  traceable to a field in the supplied recap intermediate.',
    '- Do NOT use first person ("I", "we", "the agent"). Past tense or imperative:',
    '  "Refactored queue retry logic", "Added 3 tests".',
    '- Do NOT include emoji, ANSI escape sequences, or stylistic decoration.',
    '- Do NOT speculate about motivations beyond what is recorded in `decisions[].why`.',
    '- `title` is one sentence summarizing the session, ≤ 80 chars, no trailing period.',
    '- `durationLabel` mirrors the format produced by formatDuration: e.g. "4m32s",',
    '  "2h05m", "120ms". Do not invent a duration; use the value from costs.durationMs.',
    '- `costLabel` mirrors formatUsd: "$0.00", "<$0.01", "$1.23".',
    '- `files` paths MUST appear exactly as given in `actions.filesWritten`.',
    '- `decisions` surface user-approved decisions first, then hook/policy denials.',
    '- Stay within the per-field caps declared in the schema.',
  ].join('\n');

  const user = [
    'Render the following recap intermediate as a Slack post per the',
    'forced `render_recap_slack` tool. Use only fields present below.',
    '',
    '```json',
    stringifyForPrompt(intermediate),
    '```',
  ].join('\n');

  return { system, user };
};
