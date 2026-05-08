// /critique — operator-side introspection for the self-critique
// pass (AGENTIC_CLI.md §5.4, ORCHESTRATION.md §6).
//
// Two outputs:
//   1. Current configuration snapshot — mode / threshold /
//      maxOverheadMs / promptVersion / critique provider id when
//      different from executor. Lets the operator confirm "is the
//      gate even on?" without leaving the REPL.
//   2. Recent critique runs for the current session — one row per
//      gate firing, plus an aggregate by audit code so the
//      operator can scan "of N gates this session, how many fired,
//      how many were ignored, how many led to redo/abort". Pulls
//      from `critique_runs` (migration 031).
//
// Args:
//   /critique             — show config + last 10 runs (default)
//   /critique <N>         — show config + last N runs
//   /critique config      — show only the config snapshot
//
// Scoped to the most recent session id the REPL has tracked. When
// no turn has run yet (fresh REPL boot, no `currentSessionId`),
// surfaces a clear "no session yet" hint instead of an empty list.

import {
  DEFAULT_CRITIQUE_CONFIG,
  DEFAULT_CRITIQUE_PROMPT_VERSION,
} from '../../../critique/index.ts';
import { type CritiqueRun, listCritiqueRunsBySession } from '../../../storage/index.ts';
import { formatCost } from '../format.ts';
import type { SlashCommand } from '../types.ts';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

const renderConfigBlock = (
  baseConfig: Pick<
    Parameters<SlashCommand['exec']>[1]['baseConfig'],
    'critique' | 'critiqueProvider' | 'provider'
  >,
): string[] => {
  const c = baseConfig.critique;
  // Read fallbacks from `DEFAULT_CRITIQUE_CONFIG` so a future
  // change to the default mode / threshold / overhead doesn't
  // silently drift this display from what the harness actually
  // applies. The harness merges `Partial<CritiqueConfig>` with
  // the same defaults at loop time, so what the operator sees
  // here equals what the gate enforces — no second source of
  // truth.
  const mode = c?.mode ?? DEFAULT_CRITIQUE_CONFIG.mode;
  const threshold = c?.threshold ?? DEFAULT_CRITIQUE_CONFIG.threshold;
  const maxOverheadMs = c?.maxOverheadMs ?? DEFAULT_CRITIQUE_CONFIG.maxOverheadMs;
  // promptVersion fallback chain: operator config →
  // DEFAULT_CRITIQUE_CONFIG.promptVersion (currently undefined,
  // see types.ts) → DEFAULT_CRITIQUE_PROMPT_VERSION. The last
  // step is what the engine actually resolves to at runtime
  // (engine.ts: `options.promptVersion ?? DEFAULT_CRITIQUE_PROMPT_VERSION`),
  // so this command MUST mirror that or it lies to operators
  // about which prompt is active. The previous hardcoded 'v1'
  // fallback drifted the moment V2 became default.
  const promptVersion =
    c?.promptVersion ?? DEFAULT_CRITIQUE_CONFIG.promptVersion ?? DEFAULT_CRITIQUE_PROMPT_VERSION;
  const lines: string[] = [
    'critique config:',
    `  mode:             ${mode}`,
    `  threshold:        ${threshold.toFixed(2)}`,
    `  max_overhead_ms:  ${maxOverheadMs}`,
    `  prompt_version:   ${promptVersion}`,
  ];
  // Show critique provider only when distinct from executor — the
  // common case is fallback (`critiqueProvider ?? config.provider`
  // at the loop layer), and printing the same id twice is noise.
  // When the operator has explicitly set `critique.model` in TOML
  // they paid attention; the line confirms it landed.
  if (
    baseConfig.critiqueProvider !== undefined &&
    baseConfig.critiqueProvider.id !== baseConfig.provider.id
  ) {
    lines.push(`  critic provider:  ${baseConfig.critiqueProvider.id}`);
  } else {
    lines.push(`  critic provider:  (executor: ${baseConfig.provider.id})`);
  }
  return lines;
};

// Compact one-line summary of a single run. Matches the columnar
// shape of /sessions so the operator's eye reads them as the same
// family.
const formatRun = (r: CritiqueRun): string => {
  const writes = r.toolPlanWrites ? '[writes]' : '[text]  ';
  const issues = r.filteredCount > 0 ? `${r.filteredCount}/${r.rawCount}` : `${r.rawCount}`;
  // Decision is interesting only when the modal opened — for
  // no_modal we pad the column with the strategy instead so the
  // columnar layout doesn't gain a blank slot.
  const decision = r.decision === 'no_modal' ? `(${r.strategy})` : r.decision;
  const reason = r.reason !== null ? ` — ${r.reason}` : '';
  return `  step ${String(r.stepN).padEnd(3)} · ${writes} · ${r.code.padEnd(26)} · ${decision.padEnd(8)} · issues ${issues} · ${formatCost(r.costUsd)}${reason}`;
};

interface RunAggregate {
  byCode: Map<string, number>;
  totalCost: number;
  count: number;
}

const aggregate = (runs: readonly CritiqueRun[]): RunAggregate => {
  const byCode = new Map<string, number>();
  let totalCost = 0;
  for (const r of runs) {
    byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
    totalCost += r.costUsd;
  }
  return { byCode, totalCost, count: runs.length };
};

const renderAggregate = (agg: RunAggregate): string[] => {
  if (agg.count === 0) return [];
  const codeSummary = [...agg.byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code}:${n}`)
    .join(' · ');
  return [
    `aggregate (${agg.count} runs · ${formatCost(agg.totalCost)} total):`,
    `  ${codeSummary}`,
  ];
};

export const critiqueCommand: SlashCommand = {
  name: 'critique',
  description: 'show self-critique config + recent runs for this session',
  exec: async (args, ctx) => {
    // Sub-mode: `/critique config` — config-only output. Useful in
    // a long-running REPL where the runs would scroll past the
    // useful info. Strict match (lowercase, no aliases) — we add
    // sub-commands later only if there's demand.
    if (args.length === 1 && args[0] === 'config') {
      return { kind: 'ok', notes: renderConfigBlock(ctx.baseConfig) };
    }

    // Default + numeric limit form. Mirrors /sessions's strict
    // integer match — `Number.parseInt` would silently accept
    // partially-numeric strings ('10foo' → 10) and the operator
    // would see an unexpected row count without realizing they
    // typo'd. Aliasing /sessions's pattern keeps the UX uniform.
    let limit = DEFAULT_LIMIT;
    if (args.length === 1 && args[0] !== undefined && args[0] !== 'config') {
      const raw = args[0];
      if (!/^\d+$/.test(raw)) {
        return {
          kind: 'error',
          message: `/critique: invalid limit '${raw}' (must be a positive integer)`,
        };
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          kind: 'error',
          message: `/critique: invalid limit '${raw}' (must be a positive integer)`,
        };
      }
      // Cap at MAX_LIMIT so a `/critique 99999999` doesn't blow
      // out scrollback. Operator who needs more rows queries
      // `critique_runs` directly.
      limit = Math.min(parsed, MAX_LIMIT);
    } else if (args.length > 1) {
      return {
        kind: 'error',
        message: '/critique: takes at most one argument (a limit, or "config")',
      };
    }

    const lines: string[] = [...renderConfigBlock(ctx.baseConfig)];

    // Aggregate across every session this REPL has tracked since
    // boot — including playbook subagent sessions whose child
    // harness wrote critique rows into the same DB. Without this,
    // `/critique` would show only the most recent turn's runs and
    // miss everything before, which is surprising in a REPL where
    // each turn is a separate session.
    const sessionIds = ctx.replSessionIds();
    if (sessionIds.length === 0) {
      lines.push('', 'recent runs: (no session yet — submit a turn first)');
      return { kind: 'ok', notes: lines };
    }

    // Per-session lookup → flat list, then globally sorted by
    // `createdAt`. Walking sessionIds in REPL-add order is NOT a
    // valid global timeline when sessions interleave: a foreground
    // turn in session A can spawn a playbook child B and then
    // continue producing more critique rows in A AFTER B's rows
    // landed. With a per-session-then-concat order, A's later rows
    // would sit before B's earlier rows in the flat list, and the
    // tail-slice (`all.slice(-limit)`) would silently omit the
    // genuinely most recent rows while keeping older ones from a
    // session that happened to be added later. The global sort
    // makes the tail-slice match the actual chronology regardless
    // of how sessionIds got registered.
    //
    // Tiebreak chain (createdAt → sessionId → stepN → id) handles
    // ms-collision cases — a single REPL turn can fire several
    // critiques inside the same wall-clock millisecond, especially
    // under mocked clocks in tests. Within a session-group at the
    // same ms, `stepN` preserves the step order
    // listCritiqueRunsBySession produced (`ORDER BY step_n ASC,
    // created_at ASC`); without that explicit tier, sorting by
    // `createdAt` alone could reverse a step run because UUIDs
    // are random. The final `id` fallback keeps the order
    // deterministic for the (essentially impossible) case where
    // two rows share session, step, and ms.
    const all: CritiqueRun[] = [];
    for (const id of sessionIds) {
      all.push(...listCritiqueRunsBySession(ctx.db, id));
    }
    all.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
      if (a.stepN !== b.stepN) return a.stepN - b.stepN;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    const recent = all.slice(-limit).reverse();
    lines.push('', `recent runs (${recent.length} of ${all.length}):`);
    if (recent.length === 0) {
      lines.push('  (no runs yet — gate is off, or no step matched the mode predicate)');
    } else {
      for (const r of recent) {
        lines.push(formatRun(r));
      }
      lines.push('', ...renderAggregate(aggregate(all)));
    }
    return { kind: 'ok', notes: lines };
  },
};
