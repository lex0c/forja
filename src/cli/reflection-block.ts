// Step-reflection block compositor (`PLAYBOOKS.md` §1.1
// `context_recipe.step_reflection`, `CONTEXT_TUNING.md` §13.10).
// The author opts the playbook into per-step reasoning traces by
// declaring `step_reflection: terse` (one-line) or `full`
// (paragraph). The compositor injects an instruction block into
// the system prompt; runtime emission is the model's
// responsibility — we don't intercept turns to enforce.
//
// The instruction sits at the system-prompt suffix because the
// reflection contract describes how the model should OPEN each
// step, and the model encounters it most recently when reasoning
// about whether to emit a Reflection line.

import type { StepReflection } from '../subagents/types.ts';

export const REFLECTION_BLOCK_HEADER = '## Step reflection';

const TERSE_BODY =
  'Begin every step with a one-line `Reflection: <one-line trace>` before any tool use. The line summarizes what you observed in the previous step result and what the next step targets. Keep it under 120 characters; it is a navigation aid, not a journal entry.';

const FULL_BODY =
  'Begin every step with a `Reflection:` paragraph (3-5 sentences) before any tool use. Cover: (a) what the previous step result told you, (b) what hypothesis you are testing now, (c) why this is the next step. Skip when the step is a pure follow-up to a tool result you already explained.';

// Build the trailing block for the requested mode. `off` and
// undefined collapse to null — the compositor returns the prompt
// untouched in those cases. An unknown mode is also null
// (defensive against a corrupt audit row).
export const buildReflectionBlock = (mode: StepReflection | undefined | null): string | null => {
  if (mode === undefined || mode === null || mode === 'off') return null;
  if (mode === 'terse') return `${REFLECTION_BLOCK_HEADER}\n\n${TERSE_BODY}`;
  if (mode === 'full') return `${REFLECTION_BLOCK_HEADER}\n\n${FULL_BODY}`;
  return null;
};

// Append the reflection block to a downstream prompt. Suffix
// composition mirrors the reference and output-schema blocks
// (slices 7 & 8) — the model reads role → resources → output
// contract → reflection cadence.
export const composeWithReflectionBlock = (
  downstream: string | undefined,
  mode: StepReflection | undefined | null,
): string | undefined => {
  const block = buildReflectionBlock(mode);
  if (block === null) return downstream;
  if (downstream === undefined || downstream.length === 0) return block;
  return `${downstream}\n\n---\n\n${block}`;
};
