// `agent gc` CLI handler. Spec: AGENTIC_CLI.md §2.1.3.
//
// Operator-facing surface for the retention sweeps defined in
// AUDIT.md §1.2. Resolves the [audit.retention] config, opens
// the global DB, hands off to `audit/gc.ts:runGc`, renders.
//
// Two-phase like `agent purge`: bare invocation is dry-run, --force
// executes. Differences from purge:
//   - No init-marker / no symlink defense — gc operates on the
//     global DB, not on a project FS tree.
//   - No --no-audit escape hatch — gc IS the audit hygiene; there
//     is no "audit row" to skip.
//   - Cross-project by design (the cutoffs are age-based).

import { loadRetentionConfig } from '../audit/config-loader.ts';
import type { GcReport, Phase1Table, TableReport } from '../audit/gc.ts';
import { PHASE_1_TABLES, runGc } from '../audit/gc.ts';
import type { DB } from '../storage/index.ts';
import { countPendingMigrations, defaultDbPath, migrate, openDb } from '../storage/index.ts';

export interface RunGcCliOptions {
  cwd: string;
  force: boolean;
  json: boolean;
  // Empty array = all Phase 1 tables (default). Non-empty restricts.
  // The parser already validated each value against the Phase 1
  // set; we trust that here.
  tables: string[];
  out: (s: string) => void;
  err: (s: string) => void;
  // Test seam — override global DB path. Production uses
  // defaultDbPath().
  dbPath?: string;
  // Test seam — fixed comparison point for "is this row past
  // retention?". Production uses Date.now() once at the top of
  // runGcCli (a single value covers all per-table sweeps to keep
  // dry-run output reproducible against the same DB state).
  now?: () => number;
}

const formatAge = (cutoffMs: number, nowMs: number): string => {
  const diffMs = nowMs - cutoffMs;
  if (diffMs <= 0) return 'now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const formatCutoffIso = (cutoffMs: number): string => {
  // Operator-facing date string. ISO is universally parseable; we
  // drop subsecond precision because cutoffs are derived from
  // day-count math anyway.
  try {
    return new Date(cutoffMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return String(cutoffMs);
  }
};

const renderHumanDryRun = (
  report: GcReport,
  configSources: { user: string | null; project: string | null },
  out: (s: string) => void,
): void => {
  out('forja gc — DRY RUN (nothing will be modified)\n\n');
  if (configSources.project !== null) {
    out(`Config source: ${configSources.project} (project overrides user + defaults)\n`);
  } else if (configSources.user !== null) {
    out(`Config source: ${configSources.user} (user overrides defaults)\n`);
  } else {
    out('Config source: defaults (no user or project config.toml found)\n');
  }
  out('\nTables (Phase 1):\n');
  if (report.tables.length === 0) {
    out('  (no tables selected)\n');
  } else {
    for (const t of report.tables) {
      const cutoffLabel =
        t.table === 'recap_cache'
          ? 'TTL via expires_at'
          : `older than ${formatCutoffIso(t.cutoffMs)}`;
      const wouldDelete = t.deletedCount;
      const total = t.beforeCount;
      out(
        `  ${t.table.padEnd(18)} ${String(total).padStart(7)} rows total  ${String(wouldDelete).padStart(7)} would delete  (${cutoffLabel})\n`,
      );
    }
  }
  if (report.errors.length > 0) {
    out('\nErrors (these tables would be skipped during --force):\n');
    for (const e of report.errors) {
      out(`  ${e.table.padEnd(18)} ${e.reason}\n`);
    }
  }
  out('\nTo execute:\n  agent gc --force\n');
};

const renderHumanForce = (report: GcReport, out: (s: string) => void): void => {
  out('forja gc — done\n\n');
  out('Tables (Phase 1):\n');
  if (report.tables.length === 0) {
    out('  (no tables selected)\n');
  } else {
    for (const t of report.tables) {
      const remaining = t.beforeCount - t.deletedCount;
      out(
        `  ${t.table.padEnd(18)} ${String(t.deletedCount).padStart(7)} deleted  (${String(remaining).padStart(7)} remaining; cutoff ${formatAge(t.cutoffMs, report.nowMs)})\n`,
      );
    }
  }
  if (report.errors.length > 0) {
    out('\nErrors:\n');
    for (const e of report.errors) {
      out(`  ${e.table.padEnd(18)} ${e.reason}\n`);
    }
  }
};

const serializeReport = (
  report: GcReport,
  configSources: { user: string | null; project: string | null },
  command: string | null,
): object => ({
  mode: report.mode,
  nowMs: report.nowMs,
  config: report.config,
  configSources,
  tables: report.tables,
  errors: report.errors,
  ...(command !== null ? { command } : {}),
});

export const runGcCli = async (options: RunGcCliOptions): Promise<number> => {
  const { cwd, force, json, tables, out, err } = options;
  const dbPath = options.dbPath ?? defaultDbPath();
  const nowFn = options.now ?? Date.now;

  // Load config first so a misconfig surfaces before we open the
  // DB. Warnings (typos, bad values) go to stderr but don't block
  // execution — operator gets the diagnostic AND the sweep
  // proceeds with defaults for the bad keys.
  const loaded = loadRetentionConfig({ cwd });
  for (const w of loaded.warnings) {
    err(`forja gc: ${w}\n`);
  }

  // Translate the parser's string[] into the typed enum the
  // orchestrator expects. We trust the parser already filtered to
  // known names; this cast is the boundary translation.
  const tablesFilter: ReadonlyArray<Phase1Table> | undefined =
    tables.length === 0
      ? undefined
      : tables.filter((t): t is Phase1Table => (PHASE_1_TABLES as readonly string[]).includes(t));

  let db: DB | null = null;
  try {
    try {
      db = openDb(dbPath);
      // Schema mutation is gated by `--force`. Dry-run MUST NOT
      // alter the DB; if migrations are pending, we warn loudly
      // and proceed using the current schema. The next `--force`
      // (or any bootstrap that calls migrate) will apply them.
      if (force) {
        migrate(db);
      } else {
        const pending = countPendingMigrations(db);
        if (pending > 0) {
          err(
            `forja gc: ${pending} migration(s) pending; dry-run uses current schema (run \`agent gc --force\` or any command that bootstraps the DB to apply)\n`,
          );
        }
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      err(`forja gc: cannot open DB at ${dbPath}: ${reason}\n`);
      return 1;
    }

    const report = runGc({
      db,
      config: loaded.config,
      nowMs: nowFn(),
      dryRun: !force,
      ...(tablesFilter !== undefined ? { tables: tablesFilter } : {}),
    });

    if (json) {
      const cmd = force ? null : 'agent gc --force';
      out(`${JSON.stringify(serializeReport(report, loaded.sources, cmd))}\n`);
    } else if (force) {
      renderHumanForce(report, out);
    } else {
      renderHumanDryRun(report, loaded.sources, out);
    }

    // Errors are per-table best-effort; surface as non-zero exit
    // so cron jobs detect the failure even when the other tables
    // swept fine.
    return report.errors.length > 0 ? 2 : 0;
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // ignore — sweep already committed
      }
    }
  }
};

// Re-exports for tests pinning behavior at module boundary.
export type { TableReport };
