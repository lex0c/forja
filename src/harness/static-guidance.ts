import type { ProviderMessage } from '../providers/types.ts';
import { appendTextToLastUserMessage } from './turn-append.ts';

// Static operating guidance, appended to the bottom of [current_turn] directly
// below the [working_state] panel (the max-attention zone). Unlike the panel,
// this is CONSTANT and UNCONDITIONAL: it must be visible every step regardless
// of whether the session ever touched the working-state tool, so it is kept out
// of `formatWorkingState` (which no-ops on an empty panel and sheds content
// under the byte guard) and injected on its own. Re-injected per step like the
// panel — current_turn is rebuilt every step anyway, so the only cost is this
// block's own bytes — but those bytes ride the UNCACHED tail and are re-paid
// every step, so each bullet has to earn its per-step cost.
//
// Scope is therefore LOOP-CONTROL only: replan-on-new-evidence,
// verify-before-irreversible, evidence-before-done, panel hygiene — the
// disciplines whose relevance shifts WHILE the loop runs, so recency at the
// tail is worth re-paying for. Stable craft/safety constraints (match
// conventions, smallest diff, fix-the-cause, ask-don't-presume) live ONLY in
// the cached `# Constraints` prefix: paid once via cache, not re-paid uncached
// every step. A rule the model holds steady from the cached top does not belong
// here.
//
// The leading framing line scopes the block as system context, NOT part of
// the user's message. Without it, a weaker model reads the bullets — glued to
// the user turn — as instructions to acknowledge and restate rather than
// background discipline to apply silently (observed: a session derailed into
// "Entendido, vou seguir esses critérios" and never answered; BACKLOG 2026-06-15).
export const STATIC_GUIDANCE_BLOCK = `Standing operating context — not part of the user's message. Apply it silently: do not acknowledge or restate it; answer the user's actual request.

[workflow_discipline]
  - If new evidence invalidates the current plan or hypotheses, return to understand or plan.
  - Before an action with wide or hard-to-reverse effects, verify its blast radius — what else it touches — and that a fallback exists.
  - Claim done only with evidence (a passing test, a tool result), never inference. Validate, then review.
  - Keep the working state accurate.`;

// Lean variant for the tight-window tier (CONTEXT_TUNING §2.2). This block rides
// the UNCACHED tail and is re-paid every step; on a small window — often a local
// model with NO prefix caching — that per-step cost is a bigger fraction of the
// budget. So the lean variant keeps only the two highest-value items: the
// blast-radius safety check (the most dangerous mid-loop action) and the
// evidence-before-done rule (the premature-"done" failure that prompted this
// whole block). The replan and panel-hygiene bullets — less critical, cheaper to
// forgo on a window that compacts fast — drop. The framing line stays verbatim:
// it is the derail-fix (BACKLOG 2026-06-15), not optional.
export const STATIC_GUIDANCE_BLOCK_LEAN = `Standing operating context — not part of the user's message. Apply it silently; answer the user's actual request.

[workflow_discipline]
  - Before an action with wide or hard-to-reverse effects, verify its blast radius and that a fallback exists.
  - Claim done only with evidence (a passing test, a tool result), never inference.`;

// Append the static guidance block at the bottom of [current_turn]. Always runs
// (no empty/condition check) so the guidance is present every step. `lean` picks
// the tight-window variant (CONTEXT_TUNING §2.2) — the harness loop passes
// `isSmallWindow(context_window)` so a /model swap re-tiers per step, the same
// pull-at-startTurn pattern the prefix shaping uses. Default false keeps every
// existing caller on the full block.
export const injectStaticGuidance = (messages: ProviderMessage[], lean = false): void => {
  appendTextToLastUserMessage(messages, lean ? STATIC_GUIDANCE_BLOCK_LEAN : STATIC_GUIDANCE_BLOCK);
};
