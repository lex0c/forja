# Recap eval (M4.1 → M4.3 slice e3)

Fixtures and golden outputs for the deterministic recap projection
+ renderer pipeline. Each fixture seeds a fresh in-memory SQLite
with pinned UUIDs and timestamps, runs `projectRecap` + the six
deterministic renderers (`human` / `json` / `pr` / `changelog` /
`slack` / `terse`), and compares against the golden files in
`golden/`.

The runner lives at `tests/recap/eval.test.ts` and runs as part of
`bun test`. Fidelity is PR-blocking (RECAP.md §11.3): a renderer
or projection change that diverges from the goldens fails CI.

## Layout

```
evals/recap/
  README.md
  fixtures/         # one .ts per scenario; exports seedFixture(db) + scope
  golden/           # one <name>.human.md, <name>.json, <name>.pr.md per fixture
```

## Scenarios

| # | Fixture | Covers |
|---|---|---|
| 01 | `01-read-only.ts` | files_read aggregation, single-session human shape |
| 02 | `02-write-refactor.ts` | files_written + commands + tests passed |
| 03 | `03-with-decisions.ts` | decisions section (user approval + hook deny) |
| 04 | `04-with-subagent.ts` | subagent spawn with payload summary |
| 05 | `05-incomplete-session.ts` | non-terminal session callout |
| 06 | `06-cross-day-single.ts` | scope=day; two same-cwd same-day sessions aggregated |
| 07 | `07-cross-day-range.ts` | scope=range; 3 days × 1 session, half-open window excludes day 4 |

§11.3 target is 15 fixtures (5 read-only + 5 write + 3 error-
recovered + 2 cross-day). The current 7 cover read-only (01),
write (02 / 03 / 04), incomplete (05), and both cross-day shapes
(06 / 07). The 3 error-recovered category is blocked on
`failure_events` table landing upstream — the projection's
`errors[]` field stays `[]` until then. Padding fixtures for read-
only / write categories (to reach 5 each) are deferred as
"add-a-shape-when-the-shape-changes"; they would be useful when a
new categorization (pure-add vs pure-delete file writes, etc.)
needs explicit eval coverage.

## Renderers covered

Every fixture has 6 deterministic goldens (one per renderer).
LLM-mode coverage lives in `tests/recap/<renderer>-llm.test.ts` —
mocked provider returning a known-valid structured payload, plus
schema/coverage/concision/fidelity assertions per RECAP §7.4.

## Updating goldens

When a renderer / projection change is INTENTIONAL, regenerate the
goldens:

```bash
UPDATE_GOLDENS=1 bun test tests/recap/eval.test.ts
```

Then review the diff and commit the regenerated `.md` / `.json`
files alongside the source change. NEVER use `UPDATE_GOLDENS=1` to
mask an unintended drift — the goldens exist to catch exactly that.

## Consistency metric (RECAP §7.4)

`tests/recap/consistency.test.ts` runs every fixture × every
renderer 5 times and asserts the outputs are byte-identical. The
spec frames consistency as "mesmo input ⇒ output similar (não 5
renderings diferentes)" — for the deterministic surface this is
the strongest possible claim. A hidden `Date.now()` /
`Math.random()` / non-deterministic iteration order in the
projection or a renderer would surface as a divergence between
the 5 runs. Threshold: 100% (every run must match the first).

## Determinism rules

- All UUIDs are pinned (pattern: `00000000-0000-0000-0000-<ord>`).
- All timestamps are pinned epoch ms (`1_000`-anchored).
- All paths use `/home/lex/proj/...` so the renderer's $HOME
  rewrite to `~/proj/...` is exercised.
- Renderer is invoked with `home: '/home/lex'` for stable output
  regardless of the host's actual `$HOME`.
