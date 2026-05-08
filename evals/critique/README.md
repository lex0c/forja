# Self-critique eval (Slice C)

Fixture suite for the self-critique engine (`src/critique/engine.ts`).
Per AGENTIC_CLI.md §5.4 line 572-577: "without eval, critic vira
ruído (warnings constantes que user aprende a ignorar)."

## Scope

Slice C ships **prompt + engine regression** against pinned critic
payloads. The fixtures are deterministic — each one carries a
hand-crafted critic response and an expected engine outcome. The
runner (`tests/critique/eval.test.ts`) exercises the engine against
every fixture and asserts the outcome matches.

What this DOES catch:

- Schema drift (engine starts dropping issues, mis-parsing
  confidence, mis-mapping severity).
- Threshold-filter regression (a tweak that lets sub-threshold
  issues leak through, or eats above-threshold ones).
- Marker / parse failures the engine should treat as soft-fail
  rather than crash.
- Cost / duration accounting on the engine's side.

What this does NOT catch:

- Real-model false positive / negative rates. That requires
  network + API keys + a CI gate willing to flake on provider
  outages. Out of scope for the deterministic suite.
- Prompt-quality regressions ("after we tweaked the system
  prompt, Haiku started missing this class of bug"). Tracked
  separately when the model eval lands.

## Layout

```
evals/critique/
  README.md
  fixtures/
    01-clean-output.ts        # critic emits empty issues, engine returns strategy=llm with no filtered issues
    02-flagged-bug.ts         # critic flags a real bug, engine surfaces it through filteredIssues
    03-tool-plan-writes.ts    # writes:true tool plan with safety concern, critic flags
    04-malformed-output.ts    # critic emits invalid marker payload, engine returns strategy=failed
    05-low-confidence.ts      # critic flags but confidence is below default threshold (0.7)
    06-mixed-severities.ts    # critic emits info/warn/error mix, engine preserves severity in rawIssues
    types.ts                  # shared CritiqueFixture interface
```

Each fixture exports `fixture: CritiqueFixture` with:

- `name`: stable identifier matching the file basename.
- `description`: one-line scenario summary.
- `input`: the `CritiqueInput` the engine receives.
- `criticResponse`: the raw text the (mock) provider emits as the
  critic's reply, including markers.
- `options`: `CritiqueRunOptions` overrides (default threshold=0.7,
  watchdog=0).
- `expected`: assertions on the resulting `CritiqueResult`
  (`strategy`, `rawCount`, `filteredCount`, optional reason
  fragments).

## Updating fixtures

Fixtures are deterministic — when the engine's behavior changes
intentionally (parse rule, threshold semantic), update the
fixture's `expected` block in the same PR as the engine change.
A drift between fixture and engine is a load-bearing signal that
something changed; review it before patching the fixture to
match.

## Adding fixtures

When extending the engine (a new severity, a new strategy, a new
parse path), add a fixture that exercises it BEFORE the engine
change lands. Catches latent regressions in the existing surface
that a single-purpose patch might overlook.
