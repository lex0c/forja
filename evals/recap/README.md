# Recap eval smoke (M4.1 slice d)

Fixtures and golden outputs for the deterministic recap projection
+ renderer pipeline. Each fixture seeds a fresh in-memory SQLite
with pinned UUIDs and timestamps, runs `projectRecap` + the
`human` / `json` renderers, and compares against the golden files
in `golden/`.

The runner lives at `tests/recap/eval.test.ts` and runs as part of
`bun test`. Fidelity is PR-blocking (RECAP.md §11.3): a renderer
or projection change that diverges from the goldens fails CI.

## Layout

```
evals/recap/
  README.md
  fixtures/         # one .ts per scenario; exports seedFixture(db) + scope
  golden/           # one <name>.human.md + <name>.json per fixture
```

## Scenarios (M4.1)

| # | Fixture | Covers |
|---|---|---|
| 01 | `01-read-only.ts` | files_read aggregation, single-session human shape |
| 02 | `02-write-refactor.ts` | files_written + commands + tests passed |
| 03 | `03-with-decisions.ts` | decisions section (user approval + hook deny) |
| 04 | `04-with-subagent.ts` | subagent spawn with payload summary |
| 05 | `05-incomplete-session.ts` | non-terminal session callout |

Future milestones add: cross-day fixtures (M4.3), error-recovery
fixtures (M4.x once `failure_events` lands), `pr` / `changelog` /
`slack` / `terse` golden outputs (M4.2 with the LLM render path).

## Updating goldens

When a renderer / projection change is INTENTIONAL, regenerate the
goldens:

```bash
UPDATE_GOLDENS=1 bun test tests/recap/eval.test.ts
```

Then review the diff and commit the regenerated `.md` / `.json`
files alongside the source change. NEVER use `UPDATE_GOLDENS=1` to
mask an unintended drift — the goldens exist to catch exactly that.

## Determinism rules

- All UUIDs are pinned (pattern: `00000000-0000-0000-0000-<ord>`).
- All timestamps are pinned epoch ms (`1_000`-anchored).
- All paths use `/home/lex/proj/...` so the renderer's $HOME
  rewrite to `~/proj/...` is exercised.
- Renderer is invoked with `home: '/home/lex'` for stable output
  regardless of the host's actual `$HOME`.
