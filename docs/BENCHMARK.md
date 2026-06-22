# Coding Benchmark — Forja self-SWE-bench

The **capability** axis: can a model, driving Forja's full agent loop, *fix a real bug* — verified by
the project's own tests, not by matching a diff. A separate axis from the [ranking](RANKING.md)
composite (which probes loop behavior across fixed suites); the two are **never folded together** —
passing harder real fixes is a different claim than driving the loop cleanly.

Each task is a real Forja commit replayed without the answer: the buggy parent tree + the commit's
failing test are materialized, the model fixes `src/`, and a verifier runs the test. The corpus
**generates itself** — every future fix is a candidate task.

## Results

Per-tier pass-rate (the capability **ceiling**, not a uniform average) beside the separate axes, one
row per model. Hand-refreshed from `evals/swe-bench/results.csv`; when they disagree, **the CSV wins**.

| Model | Tier 1 | Tier 2 | Tier 3 | Overall | Regressed | Steps / solved | Tool-err rate | Cost / solved |
|---|---|---|---|---|---|---|---|---|
| _pending first corpus run_ | — | — | — | — | — | — | — | — |

> A smoke (`--limit 1`) validates the pipeline; the table fills from a full corpus run. The CSV is
> append-only — no run is ever lost.

**Why per-tier, not one number.** A uniform pass-rate hides the ceiling:

```
Model A: 90% tier-1, 30% tier-2, 10% tier-3   → strong on trivial fixes, falls off fast
Model B: 70% tier-1, 60% tier-2, 50% tier-3   → lower on easy, holds up on hard
```

A single average can rank these the same; the per-tier split shows B reaches deeper. Read the highest
tier a model clears reliably as its ceiling.

## How the benchmark works

### What it measures

**Outcome, not form.** The model fixes `src/` and the commit's own test decides pass/fail. There is no
diff-match, no rubric, no LLM judge — the gold fix's *behavior* is the spec, and any `src/` change that
reproduces it passes. This removes the format/convention confound a public diff-benchmark carries (a
correct fix written differently still passes).

Still **capability AS exercised through Forja's loop** — see the [honest caveat](#honest-caveat). The
model acts through the system prompt, tool schemas, context builder, step cap, and provider adapter,
all held fixed.

### The unit: a task

One task = one real Forja fix commit `C`, replayed without the answer:

1. Materialize the **parent** tree `C^` (the buggy code) + apply `C`'s test patch → at this state the
   oracle test **FAILS**.
2. The model gets only the **failing test** as the spec — never the commit message / BACKLOG (that
   would leak the fix) — and edits `src/` in a container.
3. A verifier runs the oracle test. **Pass = it now exits 0** — a real fail-to-pass.

**Tiers** — assigned structurally by the miner (`srcFiles` count + `srcLines`) as a difficulty proxy:

| Tier | Shape | Reads as |
|---|---|---|
| 1 | one small src file (≤30 lines) | trivial, localized fix |
| 2 | one large file, or 2–3 files | multi-location / reasoning |
| 3 | >3 files | multi-file / recover-from-wrong-attempt |

`kind` (bug / feature, from the commit subject) is recorded too, so a corpus skew toward one isn't
mistaken for capability.

### Ephemeral container per task + the split-flow anti-cheat

The whole point of outcome-verification is that the model must **fix the code**, not game the check.
Five gates enforce that:

1. **No answer reachable.** The container mounts ONLY the materialized `/task` — no `.git`, no
   `corpus.json`, no gold fix, no changelog. `git show C` is impossible because `C` isn't there.
2. **Egress locked.** The task container sits on an `--internal` docker network (no direct route out);
   its only egress is a proxy sidecar that tunnels **HTTPS to the model host alone** (`:443`,
   allowlisted). A direct `curl github` has no route; a proxied one gets 403 — the agent can't fetch
   the gold from GitHub.
3. **Test surface restored.** The agent runs in its OWN container; then — before scoring — the host
   **re-materializes `tests/` + the runner config from `C`**, discarding any agent edit to the oracle.
   A model that "fixes" the bug by weakening the test is undone.
4. **Dependencies baked.** `node_modules` is forced to the image's baked deps before the verifier runs,
   even if the agent replaced it with its own `bun install` — so the oracle can't pass via dependency
   tampering rather than a `src/` fix.
5. **PASS_TO_PASS regression.** Sibling tests that pass at `C` must STAY green. A fix that
   special-cases the visible oracle and corrupts other callers is flagged `regressed` (a fail, not a
   pass). The siblings are computed (vetted to pass at `C`), and now ranked toward those that import
   the changed `src` — so the guard exercises the touched code, not just same-dir neighbors.

### Metrics

`evals/swe-bench/results.csv`, one row per (model × task):

**Outcome** (from the verifier)
- `passed` — oracle passed AND PASS_TO_PASS held (a clean fix).
- `regressed` — oracle passed but a sibling broke (overfit — scored as a fail, not a pass).
- `status` — `ok` (scored) · `timeout` (agent hit the per-task cap) · `error` (restore failed, or the
  verifier produced no result — a task that EXPECTS a PASS_TO_PASS result but yields none is an error,
  never a silent pass).

**Effort** (from the agent's done-line)
- `steps`, `duration_ms`, `input_tokens`, `output_tokens`.
- `cost_usd` — real for per-token providers; **0 / blank for `unmetered`** (Ollama Cloud bills by
  subscription, not per token — "untracked", not "free"). Compare unmetered models by `tokens/solved`.
- `exit_reason` — the reason half of forja's terminal marker (`done` / `maxSteps` / `degenerateLoop`).

**Harness fluency** (counted over the agent log)
- `tool_calls`, `tool_errors` — how cleanly the model drove the loop. Two models can share a pass-rate
  yet differ sharply in tool fumbling; the Forja-specific signal a vacuum benchmark can't see.

**Derived** (computed at report time, not stored):
- **Outcome taxonomy** = `passed` × `exit_reason`: *solved* / *wrong-fix* (`done` but the oracle fails
  — false confidence) / *exhausted* (`maxSteps` — budget, not incapacity) / *stuck* (`degenerateLoop`
  — loop friction). Separates a weak model from a low budget from a harness snag.
- **Efficiency** = `cost` / `tokens` / `steps` per **solved** task (a model that solves at 3× the
  tokens is worse — a flat pass-rate hides it).
- **Fluency** = `tool_errors / tool_calls`.

These are **separate axes** — reported beside the per-tier pass-rate, **never folded into it** (passing
efficiently is not the same as passing; RANKING.md holds the same rule).

## Honest caveat

This is **capability AS exercised through Forja's loop**, not a vacuum benchmark. The model acts through
the harness — the system prompt, tool schemas, error messages, step cap, context builder, sampling, and
provider adapter all shape the result, held fixed, not removed. A different harness would give different
numbers.

What outcome-verification *does* buy: it removes the format/convention confound (a correct fix passes
regardless of style), so the number reflects whether the model **solved the problem**, not whether it
matched a house diff. It is the most honest capability claim an agent harness can make about the models
it runs — and it is scoped as exactly that, never advertised as a model-isolation leaderboard.

## Relation to the ranking

[`RANKING.md`](RANKING.md) ranks **loop behavior** across fixed suites (smoke / edit-format /
regression) — does the model call the right tool, produce a clean edit, recover, finish. This benchmark
adds **`capability`** = the per-tier pass-rate of real fixes. They are **separate axes**: a model can
drive the loop cleanly (high ranking) yet clear few tier-3 fixes (low capability), or the reverse. The
capability axis is **never folded into the ranking composite** — reported beside it, weighed by the
reader.

## Data & reproducibility

- **`evals/swe-bench/results.csv`** — append-only source of truth, one row per (model × task). Build
  per-tier pivots downstream; the page table is a hand-refreshed view, and **the CSV wins** on
  disagreement. (Gitignored: it holds local run data, not a committed leaderboard.)
- **`evals/swe-bench/corpus.json`** — the frozen task set (id = the commit's short SHA, so a task is
  reproducible from history). Regenerated by `scripts/swe-bench-mine.ts`; `passToPass` is **computed**
  (`scripts/swe-bench-passtopass.ts`), not hand-curated.
- **`evals/swe-bench/logs/<run>/<model>/<id>/`** — per-task debug: `run.log` (agent), `verify.log`,
  `proxy.log` (the egress ALLOW/DENY), `workspace-path.txt` (the retained workspace on a failure, to
  inspect the agent's actual `src/` edits).
- **Comparability key = the harness commit + the corpus set**, not the run timestamp — the loop /
  prompt / tools change between versions, so don't compare across them. The image is rebuilt every run,
  so a stale binary never bakes an old agent in.

## Running it

```bash
# Smoke the pipeline first (one tier-1 task) — cheap, validates build → agent → verify → CSV
bun run scripts/swe-bench-run.ts --models ollama/devstral-2:123b --tier 1 --limit 1

# The full corpus against one or more models
bun run scripts/swe-bench-run.ts --models ollama/devstral-2:123b,openrouter/deepseek/deepseek-r1

# Filters: --tier N · --limit N · --id <sha> · --max-steps N · --timeout MS · --no-build
```

- A **cloud** model needs its key in the environment (`OLLAMA_API_KEY`, `OPENROUTER_API_KEY`,
  `GOOGLE_API_KEY`, …). The runner forwards the selected models' `api_key_env` into the container; the
  binary does **not** read `.env`, and a non-interactive shell won't source `~/.bashrc`, so export it
  first: `set -a; source .env; set +a`.
- **Docker is required** (the bench is container-per-task). The first run builds the image (the
  compiled binary + baked deps + the Go egress proxy); `--no-build` reuses a known-current `dist/`.
- **Paid models bill real money** — smoke first, then scope the corpus.
