# Model Ranking — Forja

How models perform **inside the Forja harness** — not a general benchmark. It is *measured*: each
model runs the eval suites and is scored on what it actually did in the loop (tool-calling, edits,
compaction). The raw, append-only data lives in [`evals/ranking/results.csv`](../evals/ranking/results.csv);
this page explains how the ranking works — the methodology, not the models in it.

## Current ranking

> Snapshot of the latest run — **2026-06-20** (`smoke` ×2 + `edit-format` ×2 + `regression` ×1).
> Sorted by **composite**, highest first. Authoritative data:
> [`evals/ranking/results.csv`](../evals/ranking/results.csv) (when this table and the CSV disagree, the CSV wins).

| # | Model | Composite | smoke | edit-format | regression | steps/case | stable | unfinished | p50 lat |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `ollama/devstral-2:123b` | **87%** | 90% | 88% | 86% | 3.1 | 100% | 6% | 4.9s |
| 2 | `ollama/qwen3-coder:480b` | **78%** | 80% | 69% | 86% | 3.5 | 94% | 13% | 4.6s |
| 3 | `ollama/glm-5.2` | **76%** | 90% | 56% | 88% | 2.8 | 94% | 10% | 4.5s |
| 4 | `ollama/qwen3-coder-next` | **74%** | 80% | 56% | 88% | 2.8 | 94% | 8% | 3.6s |

---

## How the ranking is built

### What it measures

Behavior in **this** harness, not a leaderboard. The value is exactly that public benchmarks don't
capture how a model drives Forja's loop — does it call the right tool, produce an edit that applies
cleanly, recover from a failure, finish before the step cap.

### The unit: a case (pass/fail)

Each suite is a set of YAML cases. A case declares **expectations** — e.g. `tool_called`,
`output_contains`, `file_exists` / `file_contains`, `compaction_triggered`. The harness runs the
model for real (`executeCase`) and checks them.

> **Rule:** a case passes only if **every** expectation passes — all-or-nothing.

### The dimensions (suites)

| Suite | Cases | What it probes | Weight | Repeat |
|---|---|---|---|---|
| `smoke` | 10 | baseline competence in the loop (read/write/edit/grep/glob/skill/compaction/parallel) | ×1 | 2 |
| `edit-format` | 8 | **producing valid edits** (`edit_file` / `git_apply_patch`) — the coding skill | ×2 | 2 |
| `regression` | 43 | harder, broader competence | ×2 | 1 |

`edit-format` and `regression` weigh ×2 because, for a coding agent, producing valid edits and
holding up on harder cases matter more than the baseline. Small suites repeat (variance); `regression`
already has a stable N at repeat 1.

### Metrics

**Per suite:** `passRate = passed / total` (over its repeats).

**Composite** (the sort key) — the weighted mean of suite pass-rates:

```
composite = Σ(passRate_suite × weight_suite) / Σ(weights)
```

Worked example — why a model can lead on one suite yet rank lower. With two suites
(`smoke` ×1, `edit-format` ×2):

```
70% smoke, 88% edit-format → (0.70×1 + 0.88×2) / 3 = 82%
90% smoke, 50% edit-format → (0.90×1 + 0.50×2) / 3 = 63%   # high smoke, but edit-format (×2) dominates
```

A strong score on a lightly-weighted dimension does not win if a heavily-weighted one is weak.

**Separate axes** (reported beside the composite, **never folded into it** — passing efficiently is
not the same as passing):

- **`steps/case`** — efficiency. Fewer steps to the same result is better; it differentiates models
  even when cost is $0.
- **`stability`** — % of repeated cases that agreed on every round (trust). Only counts cases that
  ran ≥2 rounds, so it reflects the repeated suites.
- **`unfinished`** — % of runs that hit the step cap, were cut off, or errored (reliability),
  independent of pass/fail.
- **`p50 latency`** and **cost** — `cost_usd` is a real number for per-token-billed providers, and
  **blank** for **unmetered** ones (e.g. Ollama Cloud — billed by subscription / GPU-time, not per
  token; "untracked", NOT "$0 / free"). When cost is flat or blank, latency separates models. Note: a
  cost cap (`maxCostUsd`) cannot bound an unmetered model — bootstrap warns when one is set.
- **`cache_read_rate`** — fraction of prompt tokens served from a cache read (the prompt-cache hit
  rate). Filled only when the provider caches; **blank** for providers that don't (e.g. Ollama), so
  it reads as "n/a" rather than "0% hit". Like cost, it only matters once a caching model (e.g.
  Anthropic) is in the battery.

### Rules (summary)

1. Case = **pass/fail** (all expectations or nothing).
2. Suite `passRate` = passed / total (× repeats).
3. `composite` = weighted mean of suite pass-rates.
4. **Rank = composite, descending.** Ties keep input order (stable sort).
5. Efficiency/trust/latency/cost are **reported, not ranked** — weigh them yourself (a faster, more
   reliable 80% can beat a flaky 85%).
6. Repeats raise trust; tune them per suite.

### What it does NOT consider

Model size / parameters, headline price, advertised context window, public benchmarks, vibes. Only
measured behavior in the harness.

## Data & reproducibility

- **`evals/ranking/results.csv`** is the source of truth — **append-only**, one row per
  `(run, model)`, with `run_date`, `run_ts`, and `harness_commit` columns. No run is ever lost;
  build charts / pivots / summaries downstream from it.
- **One run = one comparable batch** (shared `run_ts` + `harness_commit`). The history is the
  *sequence* of batches — filter on `run_ts` for apples-to-apples; do not average across harness
  versions.
- This page's snapshot table is a hand-refreshed view; when it and the CSV disagree, **the CSV wins**.

## Running it

```bash
# Run the battery against the configured models → append a batch to the CSV
bun run scripts/model-ranking.ts

# Override repeat for the small suites (regression stays at 1)
RANKING_REPEAT=3 bun run scripts/model-ranking.ts

# Append an existing results.json to the CSV without re-running
RANKING_INGEST=1 bun run scripts/model-ranking.ts
```

Models and suites (with weights and repeats) are configured at the top of
[`scripts/model-ranking.ts`](../scripts/model-ranking.ts) — adding a model is one line in `MODELS`,
and the ranking takes any number of them. (Paid models bill real money, so set a budget first.)
