// Identity / role marker for the system prompt — the first
// canonical `[system]` section (`CONTEXT_TUNING.md §1.1`,
// detailed in `§1.2`). Short, factual, role-as-tool: it states
// WHAT this agent is and the policy it runs under, nothing about
// personality or tone. `ANTI_PATTERNS.md §1.2` rejects persona
// prose ("you are an expert who…"); a 3-5 line role marker is
// explicitly the allowed ceiling, and `§1.8` makes it the
// opening of the canonical reference prompt. The implemented
// prompt previously omitted this section entirely — it opened
// straight into the environment block.
//
// The marker carries the root premise ("measure twice, cut
// once"): every action with a persistent side effect is verified
// first. That framing is load-bearing — it sets the disposition
// the `# Constraints` section then makes concrete.
//
// Composition (`bootstrap.ts`): this is the OUTERMOST layer —
// prepended last so it lands FIRST in the final prompt, ahead of
// the environment block. Fully static across every session, so
// it sits in the most-stable region of cache breakpoint #1 and
// never invalidates (unlike the date in the environment block).

export const IDENTITY_PROMPT =
  'You are the Hephaestus agent, an open-source agentic CLI for software-engineering tasks. You act under declarative policy — every action with a persistent side effect is verified first, and every decision is auditable.';

// Compose the identity marker onto an optional downstream prompt.
// The marker is PREPENDED with a blank-line gap — no `---`
// separator, because identity is the frame the rest of the
// prompt sits inside, not a peer hint layer. An empty downstream
// still yields the marker alone: the identity applies regardless
// of what else the prompt carries.
export const composeWithIdentity = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) return IDENTITY_PROMPT;
  return `${IDENTITY_PROMPT}\n\n${downstream}`;
};
