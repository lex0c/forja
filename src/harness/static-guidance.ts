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
//
// The leading framing line scopes the block as system context, NOT part of
// the user's message. Without it, a weaker model reads the bullets — glued to
// the user turn — as instructions to acknowledge and restate rather than
// background discipline to apply silently (observed: a session derailed into
// "Entendido, vou seguir esses critérios" and never answered; BACKLOG 2026-06-15).
export const STATIC_GUIDANCE_BLOCK = `Standing operating context — not part of the user's message. Apply it silently: do not acknowledge or restate it; answer the user's actual request.

[workflow_discipline]
  - If new evidence invalidates the current plan or hypotheses, return to understand or plan.
  - If blocked by ambiguity or a missing requirement, clarify instead of guessing.
  - Before an action with wide or hard-to-reverse effects, verify its blast radius — what else it touches — and that a fallback exists.
  - Claim done only with evidence (a passing test, a tool result), never inference. Validate, then review.
  - Keep the working state accurate.

[engineering_principles]
  - Match the conventions of the code you touch; diverge only with a stated reason.
  - Smallest correct diff: no speculative abstraction, no code without a consumer.
  - Fix the cause, not the symptom: no suppressions, swallowed errors, or special-cases to mask a failure — when a proper fix is out of scope, surface it instead of working around it.`;

// Append the static guidance block at the bottom of [current_turn]. Always runs
// (no empty/condition check) so the guidance is present every step.
export const injectStaticGuidance = (messages: ProviderMessage[]): void => {
  appendTextToLastUserMessage(messages, STATIC_GUIDANCE_BLOCK);
};
