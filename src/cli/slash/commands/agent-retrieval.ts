// /agent retrieval — operator-facing inspection of the retrieval
// pipeline (RETRIEVAL.md §10.1 + §10.2).
//
// Subcommands:
//   /agent retrieval                       summary (counts + latest)
//   /agent retrieval audit [--limit N]     tail of retrieval_trace
//   /agent retrieval replay <queryId>      full per-stage dump
//   /agent retrieval metrics [--days N]    aggregated §10.2 surface
//   /agent retrieval workflows             WORKFLOW_WEIGHTS table
//
// Reads from `retrieval_trace` populated by every `runRetrieval`
// call (slice 4.1). Forensic-only — no slash subcommand mutates
// pipeline state. Replay short-ids work like /agent policy: an
// 8-char prefix is enough when unambiguous.

import { WORKFLOW_WEIGHTS } from '../../../retrieval/ranking.ts';
import type { RetrievalTraceRow, RetrievalWorkflow } from '../../../retrieval/types.ts';
import {
  getRetrievalTrace,
  listRetrievalTracesBySession,
  listRetrievalTracesSinceMs,
} from '../../../storage/repos/retrieval-trace.ts';
import type { SlashContext, SlashResult } from '../types.ts';

// ─── helpers ──────────────────────────────────────────────────────────

const DEFAULT_AUDIT_LIMIT = 10;
const DEFAULT_METRICS_DAYS = 30;
const MAX_AUDIT_LIMIT = 100;
const MAX_METRICS_DAYS = 365;

// Hard cap on the row count `resolveTraceId` scans when matching a
// short-id prefix. Set well above `MAX_AUDIT_LIMIT` so a session
// with hundreds or low thousands of traces still resolves prefixes
// correctly without flooding memory — 10k aligns with the metrics
// helper's defensive cap (`listRetrievalTracesSinceMs`). If a
// session somehow exceeds it, the resolver flags the situation
// explicitly so the operator knows to pass the full UUID.
const PREFIX_SCAN_HARD_CAP = 10_000;

// Exported for unit testing edge cases (negative / NaN / Infinity).
// Within this module it's still consumed as `formatDurationMs` —
// no behavioral change.
export const formatDurationMs = (ms: number): string => {
  // Guard against negative / non-finite durations — timings come
  // from `monoNow()` deltas (always ≥ 0 by construction) or from
  // persisted `retrieval_trace.timings_json` (where a corrupted
  // row could in principle land a negative number). Render `?`
  // for malformed values rather than emitting `-123ms` to the
  // operator's audit, which would look like a bug in their
  // reading of the timeline instead of a flag that the data is
  // suspect.
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

// Nearest-rank percentile. Empty array → 0 (matches the
// metrics-line behavior). `p` is the percentile in [0, 1]. The
// result is the smallest sorted value such that ≥ p fraction of
// the array is ≤ it. Exported so the n=1 / p=0 / p=1 boundaries
// can be pinned by direct tests.
export const percentileOf = (arr: readonly number[], p: number): number => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
};

// Render a ratio (expected in [0, 1]) as a percentage. Out-of-range
// values render as `?` rather than e.g. `-50.0%` / `150.0%`:
// every caller's invariant should keep the ratio in [0, 1]
// (`evictionRate = skipped / ranked`, `budgetUtilization = used /
// budget`), so a value outside that range is a flag, not a number
// to display. NaN / Infinity also render as `?`. Exported for
// direct test coverage.
export const formatPercent = (ratio: number): string => {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return '?';
  return `${(ratio * 100).toFixed(1)}%`;
};

// `WORKFLOW_PAD` covers every entry in the fixed RetrievalWorkflow
// enum today (longest is `precedent_lookup` at 16). If a new
// workflow longer than 16 chars lands in the spec, bump this so
// the audit columns stay aligned.
const WORKFLOW_PAD = 16;

const formatTraceSummaryLine = (row: RetrievalTraceRow, nowMs: number): string => {
  const idShort = row.id.slice(0, 8);
  const ageMs = nowMs - row.createdAt;
  const ageStr =
    ageMs < 60_000
      ? `${Math.floor(ageMs / 1000)}s ago`
      : ageMs < 3_600_000
        ? `${Math.floor(ageMs / 60_000)}m ago`
        : `${Math.floor(ageMs / 3_600_000)}h ago`;
  const queryPreview = row.queryText.length > 50 ? `${row.queryText.slice(0, 47)}…` : row.queryText;
  const included = row.contextSlot.included.length;
  const skipped = row.contextSlot.skipped.length;
  const totalMs =
    row.timings.searchMs + row.timings.expandMs + row.timings.rankMs + row.timings.compressMs;
  return `  ${idShort} · ${row.workflow.padEnd(WORKFLOW_PAD)} · ${ageStr.padEnd(8)} · included=${included} skipped=${skipped} · ${formatDurationMs(totalMs)} · "${queryPreview}"`;
};

// Resolve a (potentially short-id) prefix to a single trace row.
// Mirrors the /agent policy resolvePolicyId pattern: full-uuid hit
// shortcut, then prefix scan over the session's traces, refuse on
// ambiguity.
const resolveTraceId = (
  ctx: SlashContext,
  prefix: string,
): { kind: 'ok'; row: RetrievalTraceRow } | { kind: 'error'; message: string } => {
  if (prefix.length === 0) {
    return { kind: 'error', message: '/agent retrieval replay: missing query id' };
  }
  // Full UUID fast path.
  if (prefix.length === 36) {
    const row = getRetrievalTrace(ctx.db, prefix);
    if (row === null) {
      return {
        kind: 'error',
        message: `/agent retrieval replay: trace ${prefix} not found`,
      };
    }
    return { kind: 'ok', row };
  }
  // Prefix scan over the full session history (capped at
  // PREFIX_SCAN_HARD_CAP). Previously this used MAX_AUDIT_LIMIT
  // (100) — sessions with more than 100 traces would silently miss
  // any prefix whose match lived beyond the freshest 100, leaving
  // the operator with a misleading "no match" instead of a hint to
  // pass the full UUID. `listRetrievalTracesSinceMs(..., cutoff=0)`
  // scoops the whole history up to the cap and returns `capReached`
  // so we can honestly tell the operator when their session is so
  // large that even the larger cap doesn't reach the whole tail.
  const sessionId = ctx.currentSessionId();
  if (sessionId === null) {
    return {
      kind: 'error',
      message: '/agent retrieval replay: no active session — pass the full 36-char id',
    };
  }
  const {
    rows: traces,
    capReached,
    hardCap,
  } = listRetrievalTracesSinceMs(ctx.db, sessionId, 0, PREFIX_SCAN_HARD_CAP);
  const matches = traces.filter((t) => t.id.startsWith(prefix));
  if (matches.length === 0) {
    if (capReached) {
      // Session exceeds the prefix-scan cap; older traces may
      // still match. Surface the cap explicitly so the operator
      // doesn't conclude "wrong prefix" when the actual answer is
      // "right prefix, beyond the scan window".
      return {
        kind: 'error',
        message: `/agent retrieval replay: no trace id matches prefix '${prefix}' in the freshest ${hardCap} traces of this session; older traces may exist — pass the full 36-char id to look beyond`,
      };
    }
    return {
      kind: 'error',
      message: `/agent retrieval replay: no trace id matches prefix '${prefix}'`,
    };
  }
  if (matches.length > 1) {
    const ids = matches
      .slice(0, 5)
      .map((m) => m.id.slice(0, 8))
      .join(', ');
    return {
      kind: 'error',
      message: `/agent retrieval replay: prefix '${prefix}' is ambiguous — matches ${matches.length} traces (${ids}…); lengthen the prefix`,
    };
  }
  return { kind: 'ok', row: matches[0] as RetrievalTraceRow };
};

// ─── /agent retrieval (summary) ───────────────────────────────────────

const handleSummary = (ctx: SlashContext): SlashResult => {
  const sessionId = ctx.currentSessionId();
  if (sessionId === null) {
    return {
      kind: 'ok',
      notes: [
        'retrieval trace empty (no active session)',
        'subcommands: audit · replay · metrics · workflows',
      ],
    };
  }
  const traces = listRetrievalTracesBySession(ctx.db, sessionId, MAX_AUDIT_LIMIT);
  if (traces.length === 0) {
    return {
      kind: 'ok',
      notes: [
        'no retrieval traces in this session yet',
        'subcommands: audit · replay · metrics · workflows',
      ],
    };
  }
  const byWorkflow = new Map<string, number>();
  for (const t of traces) {
    byWorkflow.set(t.workflow, (byWorkflow.get(t.workflow) ?? 0) + 1);
  }
  const wfSummary = [...byWorkflow.entries()].map(([wf, n]) => `${wf}=${n}`).join(' ');
  return {
    kind: 'ok',
    notes: [
      `retrieval traces in this session: ${traces.length} (last ${MAX_AUDIT_LIMIT})`,
      `  by workflow: ${wfSummary}`,
      'subcommands: audit · replay · metrics · workflows',
    ],
  };
};

// ─── /agent retrieval audit ────────────────────────────────────────────

const handleAudit = (ctx: SlashContext, args: string[]): SlashResult => {
  let limit = DEFAULT_AUDIT_LIMIT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return { kind: 'error', message: '/agent retrieval audit: --limit needs a value' };
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_AUDIT_LIMIT) {
        return {
          kind: 'error',
          message: `/agent retrieval audit: --limit must be an integer in [1, ${MAX_AUDIT_LIMIT}] (got ${JSON.stringify(raw)})`,
        };
      }
      limit = parsed;
      i += 1;
      continue;
    }
    return {
      kind: 'error',
      message: `/agent retrieval audit: unknown flag '${args[i]}' (try --limit N)`,
    };
  }
  const sessionId = ctx.currentSessionId();
  if (sessionId === null) {
    return {
      kind: 'error',
      message: '/agent retrieval audit: no active session — start a turn first',
    };
  }
  const traces = listRetrievalTracesBySession(ctx.db, sessionId, limit);
  if (traces.length === 0) {
    return { kind: 'ok', notes: ['no retrieval traces in this session yet'] };
  }
  const nowMs = ctx.now();
  return {
    kind: 'ok',
    notes: [
      `retrieval traces — last ${traces.length} (newest first):`,
      ...traces.map((t) => formatTraceSummaryLine(t, nowMs)),
      '  use /agent retrieval replay <id> for the full per-stage dump',
    ],
  };
};

// ─── /agent retrieval replay ───────────────────────────────────────────

const handleReplay = (ctx: SlashContext, args: string[]): SlashResult => {
  if (args.length === 0) {
    return {
      kind: 'error',
      message: '/agent retrieval replay: missing query id (use /agent retrieval audit to find one)',
    };
  }
  if (args.length > 1) {
    return {
      kind: 'error',
      message: `/agent retrieval replay: too many args (got ${args.length}, expected 1 id)`,
    };
  }
  const resolved = resolveTraceId(ctx, args[0] as string);
  if (resolved.kind === 'error') return resolved;
  const t = resolved.row;
  const totalMs = t.timings.searchMs + t.timings.expandMs + t.timings.rankMs + t.timings.compressMs;
  const lines: string[] = [
    `trace ${t.id}`,
    `  workflow=${t.workflow}  query_type=${t.queryType}  budget=${t.budgetTokens}t`,
    `  query: "${t.queryText}"`,
    '',
    `timings: total=${formatDurationMs(totalMs)}  (search=${formatDurationMs(t.timings.searchMs)}  expand=${formatDurationMs(t.timings.expandMs)}  rank=${formatDurationMs(t.timings.rankMs)}  compress=${formatDurationMs(t.timings.compressMs)})`,
    '',
    `candidates_raw (${t.candidatesRaw.length}):`,
  ];
  for (const c of t.candidatesRaw.slice(0, 20)) {
    lines.push(
      `  ${c.view}/${c.nodeId.slice(0, 40)} · score=${c.bootstrapScore.toFixed(3)} · ${c.reason}`,
    );
  }
  if (t.candidatesRaw.length > 20) {
    lines.push(`  … (${t.candidatesRaw.length - 20} more raw candidates omitted)`);
  }
  lines.push('', `candidates_ranked (${t.candidatesRanked.length}):`);
  for (const r of t.candidatesRanked.slice(0, 20)) {
    const sig = r.signals;
    lines.push(
      `  ${r.view}/${r.nodeId.slice(0, 40)} · final=${r.finalScore.toFixed(3)} · str=${sig.structural.toFixed(2)} lex=${sig.lexical.toFixed(2)} sem=${sig.semantic.toFixed(2)} tmp=${sig.temporal.toFixed(2)} use=${sig.usage.toFixed(2)} goal=${sig.goalAlignment.toFixed(2)}`,
    );
  }
  if (t.candidatesRanked.length > 20) {
    lines.push(`  … (${t.candidatesRanked.length - 20} more ranked candidates omitted)`);
  }
  lines.push('', `context_slot included (${t.contextSlot.included.length}):`);
  for (const e of t.contextSlot.included) {
    lines.push(`  ${e.view}/${e.nodeId.slice(0, 40)} · level=${e.level} · cost=${e.costTokens}t`);
  }
  if (t.contextSlot.skipped.length > 0) {
    lines.push('', `skipped (${t.contextSlot.skipped.length}):`);
    for (const s of t.contextSlot.skipped) {
      const wouldCost = s.wouldCostTokens === null ? 'n/a' : `${s.wouldCostTokens}t`;
      lines.push(`  ${s.view}/${s.nodeId.slice(0, 40)} · would_cost=${wouldCost} · ${s.reason}`);
    }
  }
  return { kind: 'ok', notes: lines };
};

// ─── /agent retrieval metrics ─────────────────────────────────────────

const handleMetrics = (ctx: SlashContext, args: string[]): SlashResult => {
  let days = DEFAULT_METRICS_DAYS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') {
      const raw = args[i + 1];
      if (raw === undefined) {
        return { kind: 'error', message: '/agent retrieval metrics: --days needs a value' };
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_METRICS_DAYS) {
        return {
          kind: 'error',
          message: `/agent retrieval metrics: --days must be an integer in [1, ${MAX_METRICS_DAYS}] (got ${JSON.stringify(raw)})`,
        };
      }
      days = parsed;
      i += 1;
      continue;
    }
    return {
      kind: 'error',
      message: `/agent retrieval metrics: unknown flag '${args[i]}' (try --days N)`,
    };
  }
  const sessionId = ctx.currentSessionId();
  if (sessionId === null) {
    return {
      kind: 'error',
      message: '/agent retrieval metrics: no active session — start a turn first',
    };
  }
  // Pull every trace within the requested window via SQL-side
  // filtering. The previous implementation used
  // `listRetrievalTracesBySession(..., MAX_AUDIT_LIMIT)` and
  // filtered in memory — that silently truncated to the freshest
  // 100 traces whenever a session had more than 100 hits in the
  // window, biasing every aggregate toward the end of the period
  // without telling the operator. `listRetrievalTracesSinceMs`
  // still imposes a (much larger) hard cap as defense against
  // pathological sessions; we surface that cap as an explicit
  // warning line when it bites instead of pretending the truncated
  // sample represents the full window. Per-session is what the
  // operator wants 99% of the time; cross-session metrics need a
  // different surface.
  // Use `ctx.now` (not Date.now) so test fixtures with pinned
  // clocks behave deterministically — same pattern /memory
  // metrics uses.
  const cutoffMs = ctx.now() - days * 24 * 60 * 60 * 1000;
  const {
    rows: traces,
    capReached,
    hardCap,
  } = listRetrievalTracesSinceMs(ctx.db, sessionId, cutoffMs);
  if (traces.length === 0) {
    return {
      kind: 'ok',
      notes: [`no retrieval traces in the last ${days}d for this session`],
    };
  }
  return {
    kind: 'ok',
    notes: buildMetricsLines({ traces, capReached, hardCap, days, nowMs: ctx.now() }),
  };
};

export interface BuildMetricsLinesInput {
  traces: readonly RetrievalTraceRow[];
  capReached: boolean;
  hardCap: number;
  days: number;
  nowMs: number;
}

// Pure render of the §10.2 metrics surface. Extracted from
// `handleMetrics` so the `capReached` warning path can be tested
// directly with a synthetic trace fixture — exercising the slash
// end-to-end would require seeding 10k+ rows. `nowMs` is passed
// explicitly (not via callback) so the function is a pure projection
// of its arguments.
export const buildMetricsLines = (input: BuildMetricsLinesInput): string[] => {
  const { traces, capReached, hardCap, days, nowMs } = input;

  // §10.2 metrics surface:
  //   - budget utilization (mean across calls)
  //   - eviction rate (% ranked candidates that got skipped)
  //   - diversity (entropy of view distribution in slots)
  //   - latency p50 / p95 per stage
  const utilizations: number[] = [];
  let totalRanked = 0;
  let totalSkipped = 0;
  const viewCounts = new Map<string, number>();
  const searchMs: number[] = [];
  const expandMs: number[] = [];
  const rankMs: number[] = [];
  const compressMs: number[] = [];
  for (const t of traces) {
    const used = t.contextSlot.included.reduce((sum, e) => sum + e.costTokens, 0);
    utilizations.push(t.budgetTokens > 0 ? used / t.budgetTokens : 0);
    totalRanked += t.candidatesRanked.length;
    totalSkipped += t.contextSlot.skipped.length;
    for (const e of t.contextSlot.included) {
      viewCounts.set(e.view, (viewCounts.get(e.view) ?? 0) + 1);
    }
    searchMs.push(t.timings.searchMs);
    expandMs.push(t.timings.expandMs);
    rankMs.push(t.timings.rankMs);
    compressMs.push(t.timings.compressMs);
  }
  const mean = (arr: number[]): number =>
    arr.length === 0 ? 0 : arr.reduce((s, n) => s + n, 0) / arr.length;
  const percentile = percentileOf;
  // Shannon entropy of view distribution. Higher = more diverse;
  // 0 = single view monopolizes. Normalized to [0, 1] by log(N)
  // where N is the number of views present (max possible entropy
  // for that view count).
  const totalInclusions = [...viewCounts.values()].reduce((s, n) => s + n, 0);
  let entropy = 0;
  // viewCounts is populated via `set(view, (get(view) ?? 0) + 1)`
  // — every entry is therefore ≥ 1. No `count === 0` guard needed
  // (previously present as defensive dead code, removed for clarity).
  for (const count of viewCounts.values()) {
    const p = count / totalInclusions;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = viewCounts.size > 1 ? Math.log2(viewCounts.size) : 1;
  const diversityNorm = maxEntropy > 0 ? entropy / maxEntropy : 0;
  const evictionRate = totalRanked === 0 ? 0 : totalSkipped / totalRanked;

  // `days` is always an integer (parsed via Number.parseInt in
  // handleMetrics). The previous render used `days.toFixed(1)`,
  // which always emitted a trailing `.0` (e.g. `30.0d`) — useless
  // visual noise for an integer field. Render plain. The
  // `effectiveDays` value below stays decimal because it comes
  // from a ms → days division and is genuinely non-integer.
  const lines: string[] = [`retrieval metrics — last ${days}d (${traces.length} traces)`];
  if (capReached) {
    // Honest cap disclosure. We hit the safety cap, so the window
    // we actually aggregated over is narrower than `days` days —
    // the OLDER end of the requested window is excluded. The
    // operator needs to know this to interpret the numbers; we
    // surface it as a `warning:` line and identify what the cap
    // is so they can either narrow `--days` or treat the numbers
    // as a freshest-N-traces sample.
    const oldestKeptMs = traces[traces.length - 1]?.createdAt;
    const effectiveDays =
      oldestKeptMs !== undefined ? (nowMs - oldestKeptMs) / (24 * 60 * 60 * 1000) : days;
    lines.push(
      `  warning: sample capped at ${hardCap} traces (oldest kept ≈ ${effectiveDays.toFixed(1)}d ago); metrics reflect the freshest ${hardCap} only — older traces in the requested ${days}d window are excluded`,
    );
  }
  lines.push(
    '',
    `budget_utilization_mean: ${formatPercent(mean(utilizations))}`,
    `eviction_rate: ${formatPercent(evictionRate)} (${totalSkipped}/${totalRanked} ranked → skipped)`,
    `diversity (view-entropy, normalized): ${diversityNorm.toFixed(3)}`,
    '',
    'latency by stage (p50 / p95):',
    `  search:   p50=${formatDurationMs(percentile(searchMs, 0.5))}  p95=${formatDurationMs(percentile(searchMs, 0.95))}`,
    `  expand:   p50=${formatDurationMs(percentile(expandMs, 0.5))}  p95=${formatDurationMs(percentile(expandMs, 0.95))}`,
    `  rank:     p50=${formatDurationMs(percentile(rankMs, 0.5))}  p95=${formatDurationMs(percentile(rankMs, 0.95))}`,
    `  compress: p50=${formatDurationMs(percentile(compressMs, 0.5))}  p95=${formatDurationMs(percentile(compressMs, 0.95))}`,
  );
  if (viewCounts.size > 0) {
    lines.push('', 'view distribution (slot inclusions):');
    for (const [v, n] of viewCounts.entries()) {
      lines.push(`  ${v}: ${n} (${formatPercent(n / totalInclusions)})`);
    }
  }
  return lines;
};

// ─── /agent retrieval workflows ────────────────────────────────────────

const handleWorkflows = (): SlashResult => {
  const lines: string[] = [
    'workflow weights (RETRIEVAL §5.2 — drives ranking signal fusion):',
    '  workflow         · structural · lexical · semantic · temporal · usage · goal',
  ];
  const workflows = Object.keys(WORKFLOW_WEIGHTS) as RetrievalWorkflow[];
  for (const wf of workflows) {
    const w = WORKFLOW_WEIGHTS[wf];
    lines.push(
      `  ${wf.padEnd(WORKFLOW_PAD)} · ${w.structural.toFixed(2).padStart(10)} · ${w.lexical.toFixed(2).padStart(7)} · ${w.semantic.toFixed(2).padStart(8)} · ${w.temporal.toFixed(2).padStart(8)} · ${w.usage.toFixed(2).padStart(5)} · ${w.goalAlignment.toFixed(2).padStart(4)}`,
    );
  }
  lines.push(
    '',
    'each row sums to 1.0 (module-load guard refuses any drift).',
    'v1 ships: structural by path-length; lexical via BM25; temporal exp-decay by view',
    '          (session 1h, memory 30d, workspace none). semantic/usage/goal=0 in v1.',
  );
  return { kind: 'ok', notes: lines };
};

// ─── router ────────────────────────────────────────────────────────────

export const handleRetrievalSub = (ctx: SlashContext, args: string[]): SlashResult => {
  const sub = args[0];
  if (sub === undefined) return handleSummary(ctx);
  switch (sub) {
    case 'audit':
      return handleAudit(ctx, args.slice(1));
    case 'replay':
      return handleReplay(ctx, args.slice(1));
    case 'metrics':
      return handleMetrics(ctx, args.slice(1));
    case 'workflows':
      return handleWorkflows();
    default:
      return {
        kind: 'error',
        message: `/agent retrieval: unknown subcommand '${sub}' (try: audit, replay, metrics, workflows)`,
      };
  }
};
