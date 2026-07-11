#!/usr/bin/env python3
"""Capability charts for the Forja self-SWE-bench.

Renders evals/swe-bench/results.csv into the views the per-tier capability
CEILING actually needs — which the ranking's cost x quality scatter cannot show
while every model is unmetered (they would collapse onto x=0):

  - ceiling: pass-rate vs tier, one line per model. The capability "ceiling" is
    the highest tier a model still clears; the line shows where it falls to 0.
    This is the headline while every model is free (cost separates nothing).
  - cost:    cost x capability Pareto scatter — the ranking's view applied to
    pass-rate instead of loop-quality. DORMANT while all models are unmetered
    (no metered model -> the figure is skipped with a note); it lights up the
    moment a paid model (gpt / cloud) lands, and then it is the headline (is the
    paid flagship worth it vs the free frontier?).
  - heatmap: model x task pass/fail/error grid. The task-level truth the
    aggregate hides — which task discriminates (one model clears it, others do
    not), which is an UNBROKEN ceiling (nobody clears it -> a corpus-quality
    flag, not necessarily legitimate difficulty), which is trivial.

The bench CSV is append-only with no per-row timestamp, so "latest" = the LAST
row for each (model, id) in file order. Outcome states are read straight from
`passed` / `regressed` / `status`, so an infra `error` reads grey (not a model
failure) and a `timeout` reads as budget — the same honesty the scorer keeps.

Usage:
  python scripts/plot_benchmark.py                          # all three figures
  python scripts/plot_benchmark.py --figure ceiling --out /tmp/ceiling.png
  python scripts/plot_benchmark.py --metric tier3           # scatter Y = tier-3 ceiling
  python scripts/plot_benchmark.py --models ollama/glm-5.2,ollama/kimi-k2.7-code:cloud

Only dependency is matplotlib (pip install matplotlib).
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import OrderedDict, defaultdict

# Provider family -> colour. Unknown families fall back to grey. Mirrors
# plot_ranking.py so a model keeps one colour across both charts.
FAMILY_COLORS = {
    "ollama": "#2ca02c",      # green   — unmetered / local-first
    "openai": "#1f77b4",      # blue
    "anthropic": "#d6604d",   # red
    "google": "#9467bd",      # purple
    "openrouter": "#ff7f0e",  # orange
}
DEFAULT_COLOR = "#7f7f7f"

# Per-MODEL palette for the ceiling lines. The family colours above collapse to
# one hue when every model shares a provider (all-ollama -> all green, lines
# indistinguishable), so the ceiling keys colour to the model instead. Style
# cycles as a colourblind backstop.
MODEL_PALETTE = [
    "#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e",
    "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#393b79",
]
LINE_STYLES = ["-", "--", "-.", ":"]

# Per-cell outcome states for the heatmap. Read from the SAME fields the scorer
# uses, so an infra error never masquerades as a model failure.
CELL_MISSING, CELL_SOLVED, CELL_FAIL, CELL_REGRESSED, CELL_TIMEOUT, CELL_ERROR = range(-1, 5)
CELL_COLOR = {
    CELL_SOLVED: "#2ca02c",      # green  — clean fix
    CELL_FAIL: "#d62728",        # red    — genuine model miss (oracle failed)
    CELL_REGRESSED: "#ff7f0e",   # orange — overfit (oracle passed, sibling broke)
    CELL_TIMEOUT: "#cccccc",     # grey   — budget, not incapacity
    CELL_ERROR: "#7f7f7f",       # dark   — harness / infra error, not the model
}
CELL_GLYPH = {
    CELL_SOLVED: "✓",       # check
    CELL_FAIL: "✗",         # cross
    CELL_REGRESSED: "R",
    CELL_TIMEOUT: "T",
    CELL_ERROR: "E",
}


def load_rows(path: str) -> list[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def to_float(s) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def dedup_latest(rows: list[dict]) -> list[dict]:
    """Append-only CSV, no per-row timestamp -> the LAST (model, id) row wins
    (a re-run of a model appends fresh rows after the stale ones)."""
    by_key: "OrderedDict[tuple[str, str], dict]" = OrderedDict()
    for r in rows:
        by_key[(r["model"], r["id"])] = r
    return list(by_key.values())


def cell_state(r: dict) -> int:
    """Map one result row to a heatmap state, severity-ordered like the scorer:
    an error/timeout is NOT a model failure and must not read as one."""
    if r.get("status") == "error":
        return CELL_ERROR
    if r.get("status") == "timeout":
        return CELL_TIMEOUT
    if r.get("regressed") == "1":
        return CELL_REGRESSED
    if r.get("passed") == "1":
        return CELL_SOLVED
    return CELL_FAIL


def aggregate(rows: list[dict]) -> list[dict]:
    """One record per model: per-tier (passed, total), overall, summed cost,
    and whether ANY of its tasks was metered (drives the free-lane split)."""
    by_model: "OrderedDict[str, dict]" = OrderedDict()
    for r in rows:
        m = r["model"]
        rec = by_model.get(m)
        if rec is None:
            rec = by_model[m] = {
                "model": m,
                "short": m.split("/", 1)[-1],
                "family": m.split("/", 1)[0],
                "tier_pass": defaultdict(lambda: [0, 0]),  # tier -> [passed, total]
                "passed": 0,
                "total": 0,
                "cost": 0.0,
                "metered": False,
            }
        try:
            tier = int(r["tier"])
        except (KeyError, ValueError):
            tier = 0
        p = 1 if r.get("passed") == "1" else 0
        rec["tier_pass"][tier][0] += p
        rec["tier_pass"][tier][1] += 1
        rec["passed"] += p
        rec["total"] += 1
        rec["cost"] += to_float(r.get("cost_usd")) or 0.0
        # `unmetered` is an explicit column (1/0); anything not "1" is billed.
        if r.get("unmetered") != "1":
            rec["metered"] = True
    return list(by_model.values())


def metric_value(m: dict, metric: str) -> float | None:
    """Y for the scatter: overall pass-rate, or a single tier's ceiling."""
    if metric == "overall":
        return m["passed"] / m["total"] if m["total"] else None
    tier = int(metric[-1])
    p, n = m["tier_pass"].get(tier, [0, 0])
    return p / n if n else None


def pareto_frontier(points: list[dict]) -> list[dict]:
    """Skyline of (low cost, high capability): a point is on the frontier when
    nothing cheaper-or-equal scores higher. Returns frontier sorted by x."""
    frontier: list[dict] = []
    best_y = float("-inf")
    for p in sorted(points, key=lambda p: (p["x"], -p["y"])):
        if p["y"] > best_y:
            frontier.append(p)
            best_y = p["y"]
    return frontier


def spread_labels(values: list[float], min_gap: float) -> list[float]:
    """Push label y-positions apart (top-down) so consecutive labels differ by
    at least min_gap, preserving input order — de-overlaps the free lane."""
    order = sorted(range(len(values)), key=lambda i: -values[i])
    out = list(values)
    for k in range(1, len(order)):
        prev, cur = order[k - 1], order[k]
        if out[prev] - out[cur] < min_gap:
            out[cur] = out[prev] - min_gap
    return out


# --------------------------------------------------------------------------- #
# Figures                                                                      #
# --------------------------------------------------------------------------- #


def fig_ceiling(plt, models: list[dict], out: str) -> str:
    """Pass-rate vs tier, one line per model. The ceiling is where a line hits 0."""
    fig, ax = plt.subplots(figsize=(8.5, 6))
    tiers = sorted({t for m in models for t in m["tier_pass"]})
    # Stable per-model colour + style (keyed by id, sorted) so a model keeps its
    # look across runs and the lines stay distinct even when every model shares a
    # provider family (which would paint them all one colour).
    palette = sorted(models, key=lambda m: m["model"])
    color_for = {m["model"]: MODEL_PALETTE[i % len(MODEL_PALETTE)] for i, m in enumerate(palette)}
    style_for = {m["model"]: LINE_STYLES[i % len(LINE_STYLES)] for i, m in enumerate(palette)}
    ordered = sorted(models, key=lambda m: -(m["passed"] / m["total"] if m["total"] else 0))
    n = len(ordered)
    for i, m in enumerate(ordered):
        # Deterministic jitter (index-based, +/-0.8%) so models tied at 100% /
        # 0% do not paint over each other. Tiny + noted; the values are exact.
        jit = (i - (n - 1) / 2) * 0.006
        xs, ys = [], []
        for t in tiers:
            p, k = m["tier_pass"].get(t, [0, 0])
            if k:
                xs.append(t)
                ys.append(p / k + jit)
        ax.plot(
            xs, ys,
            marker="o", lw=2.0, markersize=7,
            color=color_for[m["model"]], ls=style_for[m["model"]],
            alpha=0.9,
            label=f"{m['short']}  ({m['passed']}/{m['total']})",
        )
    ax.set_xticks(tiers)
    ax.set_xticklabels([f"tier {t}" for t in tiers])
    ax.set_xlabel("difficulty tier   →   (deeper = harder)")
    ax.set_ylabel("pass rate")
    ax.set_ylim(-0.08, 1.08)
    ax.set_title("Forja self-SWE-bench — capability ceiling (pass rate by tier)")
    ax.grid(True, ls="--", lw=0.4, alpha=0.4)
    ax.legend(loc="lower left", fontsize=8, framealpha=0.9, title="model (solved / total)")
    fig.text(
        0.5, 0.01,
        "the ceiling is the highest tier a model still clears   ·   "
        "lines jittered ±0.8% to separate ties (values are exact)",
        ha="center", fontsize=7, color="#666666",
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out, dpi=150, bbox_inches="tight")
    return out


def fig_cost(plt, models: list[dict], metric: str, out: str) -> str | None:
    """Cost x capability Pareto scatter — skipped (with a note) while every
    model is unmetered, since the cost axis would separate nothing."""
    from matplotlib.lines import Line2D

    if not any(m["metered"] for m in models):
        print(
            "cost scatter skipped: every model is unmetered (cost x capability "
            "needs >=1 paid model; it lights up when gpt / a paid cloud lands)"
        )
        return None

    pts = []
    for m in models:
        y = metric_value(m, metric)
        if y is None:
            continue
        pts.append({
            "short": m["short"],
            "family": m["family"],
            "y": y,
            "cost": m["cost"],
            "free": not m["metered"],
            "x": 0.0 if not m["metered"] else m["cost"],
        })
    if not pts:
        print("cost scatter skipped: no model carries the chosen metric")
        return None

    metered = [p for p in pts if not p["free"]]
    max_cost = max((p["cost"] for p in metered), default=1.0)

    fig, ax = plt.subplots(figsize=(10, 6.5))

    # Divider between the free lane (x=0) and the metered region.
    ax.axvline(min(p["cost"] for p in metered) / 2, color="#bbbbbb", ls=":", lw=1, zorder=1)

    # Pareto frontier (up-and-left is better: more capability for less money).
    front = pareto_frontier(pts)
    if len(front) > 1:
        ax.plot(
            [p["x"] for p in front], [p["y"] for p in front],
            ls="--", lw=1.2, color="#444444", alpha=0.6, zorder=2,
        )

    for p in pts:
        ax.scatter(
            p["x"], p["y"], s=180,
            color=FAMILY_COLORS.get(p["family"], DEFAULT_COLOR),
            edgecolor="white", linewidth=0.8, alpha=0.9, zorder=3,
        )

    # Labels, de-overlapped per lane with thin leader lines (free lane shares x).
    ys_pts = [p["y"] for p in pts]
    spread = (max(ys_pts) - min(ys_pts)) or 1.0
    min_gap = max(0.02, 0.06 * spread)
    label_ys: list[float] = []
    for free_lane in (True, False):
        lane = sorted((p for p in pts if p["free"] is free_lane), key=lambda p: -p["y"])
        if not lane:
            continue
        for p, ly in zip(lane, spread_labels([p["y"] for p in lane], min_gap)):
            label_ys.append(ly)
            lx = -0.06 * max_cost if free_lane else p["x"] + 0.03 * max_cost
            ax.annotate(
                p["short"], xy=(p["x"], p["y"]), xytext=(lx, ly),
                fontsize=8, va="center", ha="right" if free_lane else "left", zorder=4,
                arrowprops=dict(arrowstyle="-", lw=0.5, color="#aaaaaa", shrinkA=0, shrinkB=4),
            )

    ax.set_xlim(-0.52 * max_cost, max_cost * 1.30)
    ys = ys_pts + label_ys
    pad = max(0.03, (max(ys) - min(ys)) * 0.12)
    ax.set_ylim(max(-0.02, min(ys) - pad), min(1.05, max(ys) + pad))
    ax.set_xlabel("cost of the full corpus run (USD)   ·   left lane (x = 0) = free / unmetered")
    label = "overall" if metric == "overall" else f"{metric} ceiling"
    ax.set_ylabel(f"{label}   (pass rate)")
    ax.set_title("Forja self-SWE-bench — capability vs cost (Pareto view)")
    ax.grid(True, ls="--", lw=0.4, alpha=0.4)

    handles = [
        Line2D([0], [0], marker="o", color="w",
               markerfacecolor=FAMILY_COLORS.get(fam, DEFAULT_COLOR), markersize=9, label=fam)
        for fam in dict.fromkeys(p["family"] for p in pts)
    ]
    if len(front) > 1:
        handles.append(Line2D([0], [0], ls="--", color="#444444", label="Pareto frontier"))
    ax.legend(handles=handles, title="provider", loc="lower right", fontsize=8, framealpha=0.9)

    fig.tight_layout()
    fig.savefig(out, dpi=150, bbox_inches="tight")
    return out


def fig_heatmap(plt, rows: list[dict], models: list[dict], out: str) -> str:
    """model x task pass/fail/error grid, tasks grouped by tier."""
    from matplotlib.lines import Line2D
    from matplotlib.patches import Rectangle

    # Columns: tasks ordered by (tier, id). Rows: models by overall pass-rate.
    task_tier: "OrderedDict[str, int]" = OrderedDict()
    for r in rows:
        try:
            task_tier.setdefault(r["id"], int(r["tier"]))
        except (KeyError, ValueError):
            task_tier.setdefault(r["id"], 0)
    tasks = sorted(task_tier, key=lambda t: (task_tier[t], t))
    state = {(r["model"], r["id"]): cell_state(r) for r in rows}

    ordered = sorted(models, key=lambda m: -(m["passed"] / m["total"] if m["total"] else 0))
    mlabels = [f"{m['short']}  {m['passed']}/{m['total']}" for m in ordered]

    nrows, ncols = len(ordered), len(tasks)
    fig, ax = plt.subplots(figsize=(1.6 + 0.62 * ncols, 1.4 + 0.5 * nrows))

    for ri, m in enumerate(ordered):
        y = nrows - 1 - ri  # first model on top
        for ci, task in enumerate(tasks):
            st = state.get((m["model"], task), CELL_MISSING)
            if st == CELL_MISSING:
                ax.add_patch(Rectangle((ci, y), 1, 1, facecolor="white", edgecolor="#dddddd", lw=0.5))
                ax.text(ci + 0.5, y + 0.5, "·", ha="center", va="center", color="#cccccc")
                continue
            ax.add_patch(Rectangle((ci, y), 1, 1, facecolor=CELL_COLOR[st], edgecolor="white", lw=1.0))
            ax.text(
                ci + 0.5, y + 0.5, CELL_GLYPH[st],
                ha="center", va="center", fontsize=10, color="white", fontweight="bold",
            )

    # Tier-group separators + a tier band along the top.
    prev_tier = None
    for ci, task in enumerate(tasks):
        t = task_tier[task]
        if prev_tier is not None and t != prev_tier:
            ax.axvline(ci, color="#333333", lw=1.4)
        prev_tier = t
    # tier label centred over each group
    group_start = 0
    for ci in range(ncols + 1):
        at_end = ci == ncols
        if at_end or (ci > 0 and task_tier[tasks[ci]] != task_tier[tasks[ci - 1]]):
            mid = (group_start + ci) / 2
            ax.text(mid, nrows + 0.18, f"tier {task_tier[tasks[group_start]]}",
                    ha="center", va="bottom", fontsize=9, fontweight="bold", color="#333333")
            group_start = ci

    ax.set_xlim(0, ncols)
    ax.set_ylim(0, nrows + 0.6)
    ax.set_xticks([c + 0.5 for c in range(ncols)])
    ax.set_xticklabels([t[:8] for t in tasks], rotation=45, ha="right", fontsize=7)
    ax.set_yticks([nrows - 1 - ri + 0.5 for ri in range(nrows)])
    ax.set_yticklabels(mlabels, fontsize=8)
    ax.set_xlabel("task (short SHA)")
    ax.tick_params(length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.set_title("Forja self-SWE-bench — model × task outcomes", pad=22)

    legend = [
        Line2D([0], [0], marker="s", color="w", markerfacecolor=CELL_COLOR[CELL_SOLVED], markersize=10, label="solved ✓"),
        Line2D([0], [0], marker="s", color="w", markerfacecolor=CELL_COLOR[CELL_FAIL], markersize=10, label="miss ✗"),
        Line2D([0], [0], marker="s", color="w", markerfacecolor=CELL_COLOR[CELL_REGRESSED], markersize=10, label="regressed R"),
        Line2D([0], [0], marker="s", color="w", markerfacecolor=CELL_COLOR[CELL_TIMEOUT], markersize=10, label="timeout T"),
        Line2D([0], [0], marker="s", color="w", markerfacecolor=CELL_COLOR[CELL_ERROR], markersize=10, label="infra error E"),
    ]
    ax.legend(handles=legend, loc="upper left", bbox_to_anchor=(1.01, 1.0), fontsize=8, framealpha=0.9)
    fig.text(
        0.5, 0.005,
        "an all-miss column is the corpus ceiling — nobody clears it; a one-model column is a discriminator",
        ha="center", fontsize=7, color="#666666",
    )
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(out, dpi=150, bbox_inches="tight")
    return out


# --------------------------------------------------------------------------- #


def out_path(stem: str, name: str, single: bool) -> str:
    if single and stem.endswith(".png"):
        return stem
    base = stem[:-4] if stem.endswith(".png") else stem
    return f"{base}-{name}.png"


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--csv", default="evals/swe-bench/results.csv")
    ap.add_argument("--out", default="evals/swe-bench/benchmark",
                    help="output stem; each figure writes <stem>-<figure>.png")
    ap.add_argument("--figure", default="all", choices=["all", "ceiling", "cost", "heatmap"])
    ap.add_argument("--metric", default="overall", choices=["overall", "tier1", "tier2", "tier3"],
                    help="cost-scatter Y axis: overall pass-rate or a single tier's ceiling")
    ap.add_argument("--models", default=None,
                    help="comma-separated allowlist (full id or short name)")
    args = ap.parse_args()

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        sys.exit("matplotlib is required: pip install matplotlib")

    rows = dedup_latest(load_rows(args.csv))
    if args.models:
        wanted = {s.strip() for s in args.models.split(",") if s.strip()}
        rows = [r for r in rows if r["model"] in wanted or r["model"].split("/", 1)[-1] in wanted]
    if not rows:
        sys.exit("no rows matched (check --csv / --models)")
    models = aggregate(rows)

    figures = ["ceiling", "cost", "heatmap"] if args.figure == "all" else [args.figure]
    single = len(figures) == 1
    written: list[str] = []
    for name in figures:
        out = out_path(args.out, name, single)
        if name == "ceiling":
            written.append(fig_ceiling(plt, models, out))
        elif name == "cost":
            res = fig_cost(plt, models, args.metric, out)
            if res:
                written.append(res)
        elif name == "heatmap":
            written.append(fig_heatmap(plt, rows, models, out))

    n_metered = sum(m["metered"] for m in models)
    print(f"wrote {len([w for w in written if w])} figure(s) for "
          f"{len(models)} model(s) ({n_metered} metered): {', '.join(w for w in written if w)}")


if __name__ == "__main__":
    main()
