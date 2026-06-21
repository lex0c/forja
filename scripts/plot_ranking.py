#!/usr/bin/env python3
"""Cost x quality scatter (Pareto view) for the Forja model ranking.

Renders the honest "quality vs cost" story from evals/ranking/results.csv:

  - unmetered (free) models sit in a left lane at x=0; metered models at
    their dollar cost, so the two regimes share one plane;
  - a shaded tie/noise band near the top marks differences too small to
    trust (the suites saturate and single-round regression is flaky);
  - colour encodes the provider family, point size encodes speed
    (bigger = faster), and a dashed Pareto frontier connects the
    non-dominated models (more quality for less cost is "up-and-left").

It keeps the MOST RECENT row per model, so the chart shows each model's
freshest run even when models were measured on different harness commits
(use --commit to pin a single run instead).

Usage:
  python scripts/plot_ranking.py
  python scripts/plot_ranking.py --metric smoke --out /tmp/ranking.svg
  python scripts/plot_ranking.py --commit 9af6ed9a      # pin one run
  python scripts/plot_ranking.py --no-size --tie-band 0.03

Only dependency is matplotlib (pip install matplotlib).
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import OrderedDict

# Provider family -> colour. Unknown families fall back to grey.
FAMILY_COLORS = {
    "ollama": "#2ca02c",      # green   — unmetered / local-first
    "openai": "#1f77b4",      # blue
    "anthropic": "#d6604d",   # red
    "google": "#9467bd",      # purple
    "openrouter": "#ff7f0e",  # orange
}
DEFAULT_COLOR = "#7f7f7f"


def load_rows(path: str) -> list[dict]:
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def latest_per_model(rows: list[dict], commit: str | None) -> list[dict]:
    """Keep the most-recent row per model (run_ts is ISO8601, so string sort
    orders chronologically). --commit pins to one harness_commit first."""
    if commit:
        rows = [r for r in rows if commit in (r.get("harness_commit") or "")]
    by_model: "OrderedDict[str, dict]" = OrderedDict()
    for r in sorted(rows, key=lambda r: r.get("run_ts", "")):
        by_model[r["model"]] = r  # a later run_ts overwrites an earlier one
    return list(by_model.values())


def to_float(s) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def pareto_frontier(points: list[dict]) -> list[dict]:
    """Skyline of (low cost, high quality): a point is on the frontier when
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
    at least min_gap, preserving input order. Used to de-overlap a column of
    labels (e.g. the free lane, where every point shares x=0)."""
    order = sorted(range(len(values)), key=lambda i: -values[i])
    out = list(values)
    for k in range(1, len(order)):
        prev, cur = order[k - 1], order[k]
        if out[prev] - out[cur] < min_gap:
            out[cur] = out[prev] - min_gap
    return out


def build_points(rows: list[dict], metric: str) -> list[dict]:
    pts: list[dict] = []
    for r in rows:
        y = to_float(r.get(metric))
        if y is None:
            continue  # model without this metric in its row
        cost = to_float(r.get("cost_usd"))  # blank => unmetered (free)
        pts.append(
            {
                "model": r["model"],
                "short": r["model"].split("/", 1)[-1],
                "family": r["model"].split("/", 1)[0],
                "y": y,
                "cost": cost,
                "free": cost is None,
                "p50": to_float(r.get("p50_ms")),
                "x": 0.0 if cost is None else cost,
            }
        )
    return pts


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="evals/ranking/results.csv")
    ap.add_argument("--out", default="evals/ranking/ranking.png")
    ap.add_argument(
        "--metric",
        default="composite",
        choices=["composite", "smoke", "edit-format", "regression"],
        help="quality axis (Y). 'smoke' separates more; the others saturate.",
    )
    ap.add_argument("--commit", default=None, help="pin to one harness_commit (substring match)")
    ap.add_argument(
        "--models",
        default=None,
        help="comma-separated allowlist (matches full id or short name); overrides --min-quality",
    )
    ap.add_argument(
        "--min-quality",
        type=float,
        default=0.3,
        help="drop models scoring below this on the chosen metric (broken/abandoned runs); 0 = keep all",
    )
    ap.add_argument("--tie-band", type=float, default=0.025, help="height of the top tie/noise band")
    ap.add_argument("--no-size", action="store_true", help="do not size points by speed")
    args = ap.parse_args()

    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.lines import Line2D
    except ImportError:
        sys.exit("matplotlib is required: pip install matplotlib")

    rows = latest_per_model(load_rows(args.csv), args.commit)
    pts = build_points(rows, args.metric)
    if not pts:
        sys.exit("no rows matched (check --csv / --commit / --metric)")

    # Filter: an explicit allowlist wins; otherwise drop sub-threshold models
    # (broken/abandoned runs that would squash the scale). Report what was cut.
    dropped: list[str] = []
    if args.models:
        wanted = {m.strip() for m in args.models.split(",") if m.strip()}
        keep = [p for p in pts if p["model"] in wanted or p["short"] in wanted]
        dropped = [p["short"] for p in pts if p not in keep]
        pts = keep
    elif args.min_quality > 0:
        keep = [p for p in pts if p["y"] >= args.min_quality]
        dropped = [f"{p['short']} ({p['y']:.0%})" for p in pts if p["y"] < args.min_quality]
        pts = keep
    if dropped:
        print(f"omitted {len(dropped)} model(s) below {args.min_quality:.0%}: {', '.join(dropped)}")
    if not pts:
        sys.exit("all models filtered out (loosen --min-quality / --models)")

    metered = [p for p in pts if not p["free"]]
    max_cost = max((p["cost"] for p in metered), default=1.0)

    # Point size by speed: fastest model is biggest. Disabled with --no-size
    # or when p50_ms is missing.
    p50s = [p["p50"] for p in pts if p["p50"]]
    fastest = min(p50s) if p50s else None

    def size_of(p: dict) -> float:
        if args.no_size or not p["p50"] or not fastest:
            return 170.0
        return 90.0 + 360.0 * (fastest / p["p50"])  # (90, 450], bigger = faster

    fig, ax = plt.subplots(figsize=(10, 6.5))

    # Tie / noise band: vertical differences inside it are not significant.
    top = max(p["y"] for p in pts)
    band_lo = top - args.tie_band
    ax.axhspan(band_lo, 1.0, color="#9e9e9e", alpha=0.18, zorder=0)
    ax.text(
        max_cost * 0.55,
        (band_lo + 1.0) / 2,
        f"tie / noise band (±{args.tie_band:.0%})",
        va="center",
        ha="center",
        fontsize=8,
        color="#555555",
        bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#cccccc", alpha=0.85),
    )

    # Divider between the free lane (x=0) and the metered region.
    if metered:
        ax.axvline(min(p["cost"] for p in metered) / 2, color="#bbbbbb", ls=":", lw=1, zorder=1)

    # Pareto frontier (up-and-left is better).
    front = pareto_frontier(pts)
    if len(front) > 1:
        ax.plot(
            [p["x"] for p in front],
            [p["y"] for p in front],
            ls="--",
            lw=1.2,
            color="#444444",
            alpha=0.6,
            zorder=2,
            label="Pareto frontier",
        )

    # Points.
    for p in pts:
        ax.scatter(
            p["x"],
            p["y"],
            s=size_of(p),
            color=FAMILY_COLORS.get(p["family"], DEFAULT_COLOR),
            edgecolor="white",
            linewidth=0.8,
            alpha=0.9,
            zorder=3,
        )

    # Labels, de-overlapped per lane with thin leader lines: free labels form a
    # column to the left of x=0 (every free point shares x), metered labels sit
    # to the right of each point.
    ys_pts = [p["y"] for p in pts]
    min_gap = max(0.013, 0.052 * (max(ys_pts) - min(ys_pts)))
    label_ys: list[float] = []
    for free_lane in (True, False):
        lane = sorted((p for p in pts if p["free"] is free_lane), key=lambda p: -p["y"])
        if not lane:
            continue
        for p, ly in zip(lane, spread_labels([p["y"] for p in lane], min_gap)):
            label_ys.append(ly)
            lx = -0.06 * max_cost if free_lane else p["x"] + 0.03 * max_cost
            ax.annotate(
                p["short"],
                xy=(p["x"], p["y"]),
                xytext=(lx, ly),
                fontsize=8,
                va="center",
                ha="right" if free_lane else "left",
                zorder=4,
                arrowprops=dict(arrowstyle="-", lw=0.5, color="#aaaaaa", shrinkA=0, shrinkB=4),
            )

    # Axes. xlim leaves room for the left label column; ylim spans points AND
    # the (possibly pushed-apart) labels.
    ax.set_xlim(-0.52 * max_cost, max_cost * 1.30)
    ys = ys_pts + label_ys
    pad = max(0.02, (max(ys) - min(ys)) * 0.12)
    ax.set_ylim(min(ys) - pad, min(1.01, max(ys) + pad))
    ax.set_xlabel("cost per full eval run (USD)   ·   left lane (x = 0) = free / unmetered")
    ax.set_ylabel(f"{args.metric}   (pass rate)")
    ax.set_title("Forja model ranking — quality vs cost (Pareto view)")
    ax.grid(True, ls="--", lw=0.4, alpha=0.4)

    # Legend: families present + the frontier line.
    handles = [
        Line2D(
            [0],
            [0],
            marker="o",
            color="w",
            markerfacecolor=FAMILY_COLORS.get(fam, DEFAULT_COLOR),
            markersize=9,
            label=fam,
        )
        for fam in dict.fromkeys(p["family"] for p in pts)
    ]
    if len(front) > 1:
        handles.append(Line2D([0], [0], ls="--", color="#444444", label="Pareto frontier"))
    ax.legend(handles=handles, title="provider", loc="lower right", fontsize=8, framealpha=0.9)

    # Caption: provenance + how to read it.
    commits = sorted({(r.get("harness_commit") or "")[:8] for r in rows if r.get("harness_commit")})
    size_note = "" if args.no_size else "   ·   point size ∝ speed (bigger = faster)"
    fig.text(
        0.5,
        0.01,
        f"harness_commit: {', '.join(commits) or 'n/a'}{size_note}"
        "   ·   differences inside the band are noise, not signal",
        ha="center",
        fontsize=7,
        color="#666666",
    )

    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(args.out, dpi=150, bbox_inches="tight")
    n_free = sum(p["free"] for p in pts)
    print(f"wrote {args.out}  ({len(pts)} models: {n_free} free, {len(metered)} metered)")


if __name__ == "__main__":
    main()
