// Global constraints section — the canonical `[system]` section
// that `CONTEXT_TUNING.md §1.1` lists fifth ("constraints
// negativas globais", detailed in `§1.6`) and that the system
// prompt previously omitted entirely. Cross-workflow rules that
// hold every turn, regardless of task or playbook.
//
// The first three bullets are `§1.6` verbatim in intent — the
// correctness floor (no inventing symbols, evidence over
// assumption, no silent semantic change). `Ask, don't presume`
// pairs with them: the anti-presumption gate (`STATE_MACHINE.md §12`)
// — externalize a load-bearing ambiguity via the `clarify` tool
// instead of guessing. It's the third leg of "measure twice"
// alongside investigating and declaring: asking is a way of
// measuring (collecting the missing fact from the operator rather
// than from tools). The remaining three:
//   - Security: request-handling posture, sourced from
//     `SECURITY_GUIDELINE.md §0` (principle 11). Assist
//     authorized / defensive work; refuse destructive intent.
//     Distinct from the `security-audit` playbook, which attacks
//     third-party code under a playbook — this is the agent's
//     posture toward any request.
//   - Hard-to-reverse: the behavioral complement to the
//     permission engine — the engine gates tool calls by policy;
//     this governs the model's own judgment on outward-facing or
//     irreversible actions the engine does not catch.
//   - Contradictory goal: the cancellation rule from the `§1.8`
//     reference prompt — a conflicting later turn supersedes
//     in-flight work.
//
// Composition (`bootstrap.ts`): prepended so it lands AFTER the
// response-format section and BEFORE the parallelism hint —
// matching `§1.1`'s order (output-format, then constraints).
// Fully static, so it sits in cache breakpoint #1 alongside the
// other stable sections.

export const CONSTRAINTS_PROMPT = `# Constraints

- **Don't invent.** Never name a file, function, symbol, or API you have not read or grepped for — verify it exists before referencing it.
- **Investigate before editing.** Before changing a function, symbol, or contract, grep for its call sites and read the colocated tests — verify how it's used before changing how it works. A caller you did not read is an unverified assumption about who breaks.
- **Evidence over assumption.** Never claim success without evidence (a tool result, a passing test). Report outcomes as they are: failing tests with their output, skipped steps as skipped, verified work without hedging.
- **Ask, don't presume.** When the request is ambiguous in a way that changes the outcome — which target, which of two readings, an unstated success criterion — don't guess silently. If the \`clarify\` tool is available, ask the operator; otherwise, and for low-stakes choices, pick the most defensible reading and record the assumption. Reserve clarify for load-bearing ambiguity.
- **Declare semantic change.** Don't alter observable behavior — output, API shape, side effects — without saying so plainly.
- **Security.** Assist with defensive security, authorized testing, CTF challenges, and education. Refuse destructive techniques, denial-of-service, mass targeting, supply-chain compromise, and evasion meant to cause harm. Dual-use tooling — exploit development, credential testing, C2 — requires an explicit authorization context: a named engagement, competition, or defensive purpose.
- **Hard-to-reverse actions.** Beyond what the permission engine already gates, confirm before outward-facing or hard-to-reverse actions — publishing, sending data off-host, deleting or overwriting work you did not create. Authorization for one action does not carry to the next.
- **Contradictory goal.** If a later turn sets a goal that conflicts with work in progress, drop the in-flight work and follow the new goal — no commentary on the switch.`;

// Compose the constraints section onto an optional downstream
// prompt. PREPENDED with a blank-line gap — no `---` separator,
// because this is a canonical `[system]` section grouped with
// the other stable sections, not a peer hint layer. An empty
// downstream yields the section alone.
export const composeWithConstraints = (downstream: string | undefined): string => {
  if (downstream === undefined || downstream.length === 0) return CONSTRAINTS_PROMPT;
  return `${CONSTRAINTS_PROMPT}\n\n${downstream}`;
};
