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
// `Build only what's asked` and `Pin what must persist` are the
// two disciplines salvaged when the standalone `# Task discipline`
// section was dissolved (2026-06-07). The first folds the
// build/edit-craft norms (no premature abstraction, no error
// handling for impossible cases, no narrative comments, no
// back-compat shims, edit over rewrite, smallest diff) into one
// negative constraint. The second re-arms `pin_context`, which the
// cut otherwise left unmentioned in the whole system prompt — the
// tool ships but goes dormant without a nudge (the same reasoning
// that added the original mention; see BACKLOG 2026-06-05). Both
// belong with the global rules rather than as their own section.
// The dup nudges that section also carried (prefer-parallel/
// delegate, decompose) already lived in `# Parallelism` /
// `# Playbook subagents` and were dropped, not relocated.
//
// `Match the surrounding code` is newer — added after reviewing
// what an agentic code engineer needs that a generic baseline
// omits. It is the always-present floor against cross-file
// paradigm drift (functional here, OO there) for repos with no
// `AGENTS.md`. Explicit project rules still live in `AGENTS.md`,
// surfaced lazily by the `# Project context` pointer; this bullet
// only says "absent that, the existing code IS the convention" —
// the failure mode the frontier alignment does not cover alone.
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
- **Build only what's asked.** No abstractions, helpers, fallbacks, or error handling for cases that can't occur; no comments that restate what the code says; no back-compat shims for code with no consumers. Three similar lines beat a premature abstraction, and delete unused code rather than stubbing it. Prefer a targeted \`edit_file\` over rewriting a whole file, and a new file only when one truly doesn't exist yet — smallest correct diff.
- **Match the surrounding code.** Follow the conventions already in the files you touch — naming, error-handling, layering, functional-vs-OO style — rather than a cleaner pattern you would introduce. Diverge only with a stated reason; absent a project rule (\`AGENTS.md\`), the existing code is the convention.
- **Pin what must persist.** When a fact must hold across many later turns — an invariant the code relies on, a step to always run before committing — \`pin_context\` it so it survives compaction instead of trusting it stays in the window. Cross-session facts go in \`memory_write\` instead.
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
