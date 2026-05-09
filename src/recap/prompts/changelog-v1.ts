// Prompt for the `changelog` renderer, version v1. Bumping is a
// copy of this file to `changelog-v2.ts`, never an in-place edit
// (RECAP.md §7.1).

import type { RecapIntermediate } from '../types.ts';

export const CHANGELOG_PROMPT_VERSION = 'changelog-v1' as const;

const stringifyForPrompt = (value: unknown): string => JSON.stringify(value, null, 2);

export const buildChangelogPromptV1 = (
  intermediate: RecapIntermediate,
): { system: string; user: string } => {
  const system = [
    'You convert a structured recap of an agent session into a Keep a Changelog entry.',
    'Output is constrained to the `render_recap_changelog` schema; you cannot add fields.',
    '',
    'Hard rules (RECAP §7.3):',
    '- Do NOT invent files, decisions, or features. Every entry MUST be',
    '  traceable to a field in the supplied recap intermediate.',
    '- Use the user-impacting framing: "what does the consumer of this code',
    '  experience differently?", not "what did the agent do internally?".',
    '- Do NOT use first person ("I", "we", "the agent"). Imperative mood:',
    '  "Add ...", "Fix ...", "Remove ...".',
    '- Do NOT include emoji, ANSI escape sequences, or stylistic decoration.',
    '- Do NOT speculate about motivations beyond what is recorded in `decisions[].why`.',
    '- Pick categories from {Added, Changed, Fixed, Removed, Deprecated, Security}',
    '  based on intent, not source-line counts:',
    '    - Added: a new capability the user can now invoke.',
    '    - Changed: an existing behavior visibly differs.',
    '    - Fixed: a defect was repaired (typically maps to recovered errors',
    '      or decisions about bug fixes).',
    '    - Removed: a capability is no longer available.',
    '    - Deprecated: a capability still exists but is marked for removal.',
    '    - Security: a fix or change with security impact (auth, secrets,',
    '      token handling, policy enforcement).',
    '- Stay within the per-field caps declared in the schema.',
    '- Bullets MUST be one line, no trailing period (Keep a Changelog convention).',
  ].join('\n');

  const user = [
    'Render the following recap intermediate as a Keep a Changelog entry per the',
    'forced `render_recap_changelog` tool. Use only fields present below.',
    '',
    '```json',
    stringifyForPrompt(intermediate),
    '```',
  ].join('\n');

  return { system, user };
};
