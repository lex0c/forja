# Memory governance eval (Slice M-Eval)

Fixture suite for the memory governance pipeline (the LLM-judge
detectors S11 / S13 / S3 + the governance proposal apply path +
`transitionMemoryState` + the audit pair `memory_events` /
`eviction_events`).

Per `CLAUDE.md` principle 4 (and `docs/spec/AGENTIC_CLI.md §16`):

> Eval is load-bearing. A subsystem without eval doesn't ship.

`tests/memory/*.test.ts` covers each component in isolation
(dispatchers, governance repo, state machine). This eval suite is
different: it pins the **propose-not-mutate narrative end-to-end** —
a deterministic subagent verdict drives a real dispatcher run, which
lands a real proposal, which a real operator approve drives through
the real apply path, which fires the real state machine and writes
the real audit pair. If any wire between those layers silently
breaks, a fixture fails.

## Scope

What this suite catches:

- **Schema drift on detector outputs** — the subagent output format
  changes and the dispatcher silently records a malformed verdict.
- **Apply-path regression** — a confidence threshold tweak, a state
  machine guard edit, or a hook-fire reorder that lets a proposal
  apply when it shouldn't (or refuses one that should).
- **Audit-pair drift** — `memory_events` action / `eviction_events`
  outcome desync, or a transition that lands one row without the
  other.
- **State-on-disk drift** — the apply path mutates the DB but
  forgets to rewrite the file's frontmatter (or vice versa).
- **Trigger / motivo mapping** — `verify_failed` proposal landing
  with the wrong trigger string on the audit row.

What this suite does NOT catch:

- **Real-LLM verdict quality** — the subagent's accuracy. That's
  the smoke / regression tier's job (real provider, real prompts).
  Out of scope for deterministic eval.
- **TUI confirmation UX** — `memory_write` modal flow. The modal
  is wired via callback; eval bypasses it by calling repo / apply
  primitives directly.
- **Scheduler timing / cost caps** — covered by `tests/memory/
  verify-semantic-scheduler.test.ts` and siblings.

## Pattern

Each fixture is a TypeScript module exporting one
`MemoryGovernanceFixture` (see `fixtures/types.ts`). The runner
(`tests/memory/eval-fixtures.test.ts`) iterates every fixture:

1. **Seed phase** — temp cwd, in-memory SQLite, migrations, session,
   subagent_runs row, memory file written to disk, registry built.
2. **Dispatch phase** — invokes the detector's dispatcher with
   `spawnSubagentFn` stubbed to return the fixture's pinned
   `subagentOutput` verbatim (no real LLM call).
3. **Decision phase** (optional) — when `operator.decision` is set,
   the runner calls `applyProposal` (for `approve`) or
   `decideProposal` (for `reject` / `defer`) against the proposal
   the dispatcher just landed.
4. **Assertion phase** — checks the fixture's `expected` block
   against the final DB state (attempts, proposals,
   `memory_events`, `eviction_events`) and on-disk frontmatter.

The runner is a regular `bun test` file — no `--json` invocation,
no smoke-runner, no API key. Runs in CI without cost.

## Layout

```
evals/memory/
  README.md
  fixtures/
    types.ts                                       # MemoryGovernanceFixture
    01-s11-contradicted-approve-quarantine.ts      # S11 happy path end-to-end
```

Fixtures are numbered by the order they landed; the number is not a
priority signal.

## Adding a fixture

1. Pick the narrative the fixture pins (detector + outcome path).
2. Write the `subagentOutput` as the verbatim YAML the subagent
   would emit. Keep it minimal — only the fields the dispatcher
   reads.
3. Set `expected` to the *minimum* set of assertions that would
   fail if the narrative breaks. Over-assertion turns the fixture
   into an implementation-detail pin.
4. Import the fixture in `tests/memory/eval-fixtures.test.ts` and
   add it to the `FIXTURES` constant.
