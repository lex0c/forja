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
  // Defaults the harness applies when fields are absent. Mirrors
  // DEFAULT_CRITIQUE_CONFIG so the operator sees the resolved
  // values, not the partial config they typed. Keeping the
  // numbers inline (vs importing the const) avoids dragging the
  // critique module into the slash layer for one read; if the
  // defaults ever drift, the test suite catches the divergence.
  const mode = c?.mode ?? 'off';
  const threshold = c?.threshold ?? 0.7;
  const maxOverheadMs = c?.maxOverheadMs ?? 3000;
  const promptVersion = c?.promptVersion ?? 'v1';
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

    const sessionId = ctx.currentSessionId();
    if (sessionId === null) {
      lines.push('', 'recent runs: (no session yet — submit a turn first)');
      return { kind: 'ok', notes: lines };
    }

    // listCritiqueRunsBySession returns oldest-first (step ASC,
    // created_at ASC). Slicing the tail gives the most recent N;
    // we then reverse so the operator reads newest-first, matching
    // the convention in /sessions.
    const all = listCritiqueRunsBySession(ctx.db, sessionId);
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
