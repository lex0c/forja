import type { ProviderMessage } from '../providers/types.ts';
import { appendTextToLastUserMessage } from './turn-append.ts';

// Static operating guidance, appended to the bottom of [current_turn] directly
// below the [working_state] panel (the max-attention zone). Unlike the panel,
// this is CONSTANT and UNCONDITIONAL: it must be visible every step regardless
// of whether the session ever touched the working-state tool, so it is kept out
// of `formatWorkingState` (which no-ops on an empty panel and sheds content
// under the byte guard) and injected on its own. Re-injected per step like the
// panel — current_turn is rebuilt every step anyway, so the only cost is this
// block's own bytes; the cached stable prefix is untouched.
export const STATIC_GUIDANCE_BLOCK = `[workflow_discipline]
  - If new evidence invalidates the current plan or hypotheses, return to understand or plan.
  - If blocked by ambiguity or missing requirements, clarify.
  - Mark done only after satisfactory validation and review.
  - Keep the working state accurate.

[engineering_principles]
  - Favor high cohesion and low coupling.
  - Prefer maintainable and robust implementations.
  - Follow existing project conventions, patterns, and architecture unless there is a compelling reason to change them.`;

// Append the static guidance block at the bottom of [current_turn]. Always runs
// (no empty/condition check) so the guidance is present every step.
export const injectStaticGuidance = (messages: ProviderMessage[]): void => {
  appendTextToLastUserMessage(messages, STATIC_GUIDANCE_BLOCK);
};
