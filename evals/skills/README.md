# Skills evals

Model-driven behavioral evals for the skills subsystem (spec `docs/spec/SKILLS.md`).

These use the same YAML harness as `evals/smoke` / `evals/regression` (`src/evals/`). The
runner discovers any directory of `*.yaml` cases — there is no framework change here, just a
dedicated directory so skills has eval parity with `memory/` and `recap/`.

## Why these exist

The two smoke cases (`evals/smoke/11-skill-invoke`, `12-skill-list`) prove the tool plumbing:
the body loads, the catalog enumerates. But both name the action in the prompt ("…use it",
"Call the skill_list tool"), so they never test the property that *is* the subsystem's thesis —
that the one-line `description` surfaced in the eager catalog (§0.2, §4) drives the model's
decision to invoke. Unit tests (`tests/skills/`) cover parse/precedence/lifecycle/sandbox
mechanics in isolation; neither tier puts the model in the loop deciding. This suite does.

## Cases

| Case | Property |
|---|---|
| `01-selection-by-description` | POSITIVE gate — model invokes from the description alone, unprompted |
| `02-no-false-invoke` | NEGATIVE gate — no skill invoked for a task no description matches (§11) |
| `03-precedence-local-over-shadowed` | no-scope invoke resolves to the project_local winner (§3.5) |
| `04-show-does-not-invoke` | `skill_show` inspects without invoking (no `invoked` audit row) |
| `05-expired-still-invokes` | an expired skill is invoked anyway (§5.4) |

## Running

```
bun run eval:skills          # runs on a capable model (see below)
```

These call a real provider and cost tokens (~$0.27 for the full suite on opus) — they are NOT part
of `bun test`. Run on demand.

### Why a capable model, not the cheap regression model

Autonomous skill *selection* — choosing to invoke from the description alone (`01`) — is a
capability-sensitive behavior. At temperature 0, `claude-haiku-4-5` deterministically prefers
`skill_show` + a manual `read_file` over `skill_invoke`: it peeks at the body and executes the
procedure by hand, bypassing the invoke path (and its `invoked` audit row + `<skill>` trust
marker). The same case passes on `claude-sonnet-4-6` and `claude-opus-4-8`, which invoke from the
description as intended — so the gate is correctly built; the haiku result is model weakness, not a
subsystem bug. The runner has no per-case model override (model is a whole-run flag), so the
script defaults to a capable model (`claude-opus-4-8`). The negative gate (`02`), precedence
(`03`), show-not-invoke (`04`), and expired-still-invokes (`05`) all pass on haiku too; only the
positive-selection gate needs the stronger model.
