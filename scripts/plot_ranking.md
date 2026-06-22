# `plot_ranking.py` — cost × quality chart for the model ranking

Renders `evals/ranking/results.csv` as a **cost vs quality scatter (Pareto view)** —
the honest way to read a ranking whose quality scores saturate near the top and whose
cost lives on a separate axis.

The chart encodes:

- **unmetered (free) models** in a left lane at `x = 0`; **metered models** at their
  dollar cost — the two regimes share one plane;
- a shaded **tie / noise band** at the top, because the suites saturate and single-round
  regression is flaky, so small vertical differences are not signal;
- **colour** = provider family, **point size** = speed (bigger = faster);
- a dashed **Pareto frontier** through the non-dominated models (up-and-left is better).
  When one free model dominates everything, the frontier collapses to that single point
  and no line is drawn.

## Prerequisites

Only `matplotlib`:

```bash
pip install matplotlib
```

## Quick start

```bash
python3 scripts/plot_ranking.py
```

Reads `evals/ranking/results.csv`, writes `evals/ranking/ranking.png`, and prints what it
saved plus any models it omitted.

## How it picks the data

- **Most recent row per model.** The CSV accumulates every run ever appended; the script
  keeps each model's latest row (by `run_ts`), so the chart shows the freshest number for
  each model even when models were measured on different harness commits. Use `--commit`
  to pin a single run instead.
- **Quality floor.** By default it drops models scoring below `--min-quality` (30%) on the
  chosen metric — these are broken/abandoned runs that would otherwise squash the scale.
  The omitted models are printed; pass `--min-quality 0` to keep all, or `--models` to pick
  an explicit set.

## Options

| Flag | Default | Purpose |
|---|---|---|
| `--csv` | `evals/ranking/results.csv` | input CSV |
| `--out` | `evals/ranking/ranking.png` | output path — **extension picks the format** (`.png` / `.svg`) |
| `--metric` | `composite` | quality axis (Y): `composite`, `smoke`, `edit-format`, `regression`. `smoke` separates the most; the others saturate near 1.0 |
| `--commit` | — | pin to one `harness_commit` (substring match) instead of latest-per-model |
| `--models` | — | comma-separated allowlist (full id or short name); overrides `--min-quality` |
| `--min-quality` | `0.3` | drop models below this on the chosen metric; `0` keeps all |
| `--tie-band` | `0.025` | height of the top tie/noise band (pass-rate units) |
| `--no-size` | off | do not size points by speed (uniform markers) |

## Recipes

```bash
# Smoke is the discriminating suite — this view separates the leaders that
# the saturated composite ties (e.g. surfaces gpt-5.5's perfect smoke run).
python3 scripts/plot_ranking.py --metric smoke --out /tmp/ranking_smoke.png

# Strict provenance: only the models measured on one commit.
python3 scripts/plot_ranking.py --commit 4e74fea7

# Compare a subset head-to-head.
python3 scripts/plot_ranking.py --models devstral-2:123b,gpt-5.5,gpt-5.4

# Vector output for a slide/doc, including every model (no quality floor).
python3 scripts/plot_ranking.py --out ranking.svg --min-quality 0
```

## How to read the chart

- **Top-left is best** — more quality for less cost. The `x = 0` lane is free / unmetered.
- The **grey band** at the top is the tie/noise zone: vertical differences inside it are
  not significant. Do not rank models by sub-band gaps.
- **Point size** is speed (bigger = faster); **colour** is the provider family.
- A model **down-and-right** of another is dominated (costs more, scores no higher).

### Important caveat

The ranking measures **harness-use on saturated cases**, with cost reported as a separate
axis — it is *not* a capability verdict. `edit-format` and `regression` sit near 1.0 for
most leaders, so the `composite` ordering at the top is driven by single-round flakiness,
not skill. Read the chart as "which model drives the Forja loop well, and at what cost,"
and cross-check with `--metric smoke` before concluding one model is "better" than another.
See `docs/RANKING.md` for the full methodology and the saturation discussion.

## Data source

The script reads these columns from `results.csv` (others are ignored):

| Column | Used for |
|---|---|
| `model` | label + provider family (prefix before `/`) |
| `run_ts`, `harness_commit` | latest-per-model selection / `--commit` pin / caption |
| `composite`, `smoke`, `edit-format`, `regression` | quality axis (Y), per `--metric` |
| `cost_usd` | cost axis (X); **blank = unmetered**, plotted in the free lane |
| `p50_ms` | point size (speed) |
