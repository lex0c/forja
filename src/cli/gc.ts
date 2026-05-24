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

import { lstatSync } from 'node:fs';
import { loadRetentionConfig } from '../audit/config-loader.ts';
// Table constants from the zero-imports module so the import
// graph stays narrow even if a future call site imports cli/gc.ts
// eagerly. Runtime symbols (runGc, types) stay on audit/gc.ts.
import { GC_TABLES, type GcTable } from '../audit/gc-tables.ts';
import type { GcReport, TableReport } from '../audit/gc.ts';
import { runGc } from '../audit/gc.ts';
import { resolveRepoRoot } from '../memory/paths.ts';
import type { DB } from '../storage/index.ts';
import {
  closeDb,
  countPendingMigrations,
  defaultDbPath,
  migrate,
  openDb,
} from '../storage/index.ts';

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

// Build the suggested `agent gc --force` command, preserving the
// caller's `--table=X` filters. Operator who runs
// `agent gc --table=memory_events` (scoped dry-run) should see the
// suggested command echo the same scope — otherwise copy-pasting
// the suggestion sweeps every table, deleting data outside the
// inspected scope. Operator safety > brevity.
const buildForceCommand = (tables: ReadonlyArray<string>): string => {
  if (tables.length === 0) return 'agent gc --force';
  const flags = tables.map((t) => `--table=${t}`).join(' ');
  return `agent gc --force ${flags}`;
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
  forceCommand: string,
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
  out('\nTables:\n');
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
  out(`\nTo execute:\n  ${forceCommand}\n`);
};

const renderHumanForce = (report: GcReport, out: (s: string) => void): void => {
  out('forja gc — done\n\n');
  out('Tables:\n');
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
  //
  // resolveRepoRoot is REQUIRED here. `loadRetentionConfig` reads
  // `<cwd>/.agent/config.toml`; passing the raw process cwd means
  // an operator running `agent gc` from `<repo>/src/` would read
  // `<repo>/src/.agent/config.toml` (which doesn't exist), silently
  // falling back to defaults and pruning rows with the wrong
  // retention window. Data-retention regression in --force mode.
  // Bootstrap already does this resolution for the harness's own
  // call site — same posture here.
  const projectConfigCwd = resolveRepoRoot(cwd);
  const loaded = loadRetentionConfig({ cwd: projectConfigCwd });
  for (const w of loaded.warnings) {
    err(`forja gc: ${w}\n`);
  }

  // Translate the parser's string[] into the typed enum the
  // orchestrator expects. We trust the parser already filtered to
  // known names; this cast is the boundary translation.
  const tablesFilter: ReadonlyArray<GcTable> | undefined =
    tables.length === 0
      ? undefined
      : tables.filter((t): t is GcTable => (GC_TABLES as readonly string[]).includes(t));

  let db: DB | null = null;
  try {
    try {
      if (force) {
        // Force path: open RW + migrate. openDb without `readonly`
        // creates the file if absent, mkdir's parent, sets WAL +
        // busy_timeout PRAGMAs (creates -shm/-wal sidecars on first
        // write), and chmod's to 0600. All mutating, but expected
        // — operator opted into mutation via --force.
        db = openDb(dbPath);
        migrate(db);
      } else {
        // Dry-run path: open in `readonly` mode. openDb with
        // `{readonly: true}` skips mkdir, skips create:true, skips
        // WAL/busy_timeout pragmas, skips chmod — pure FS-level
        // no-mutation. If the file doesn't exist, the open throws
        // (SQLite refuses RO-create); we catch + report gracefully
        // as "DB not yet created — no rows to sweep" so the dry-run
        // doesn't crash on fresh installs.
        //
        // Pre-fix bug: dry-run called openDb() without readonly,
        // which CREATED sessions.db + -shm + -wal sidecars + applied
        // PRAGMAs + chmod'd — silently mutating operator state
        // despite the "DRY RUN" header. Same shape as the purge
        // dry-run bug; fixed there + missed here.
        // Pre-check file state to distinguish three open-fail
        // shapes:
        //   - File truly absent (ENOENT) → fresh-install case.
        //     Legitimate "no rows to sweep yet"; downgrade to empty
        //     report + exit 0. Operator just installed Forja and
        //     ran `agent gc` before any session created the DB.
        //   - File present but openDb fails → real operational
        //     failure (corruption, perm denied on file,
        //     integrity_check refusal, locked by other process).
        //     Exit 1 so scripts notice.
        //   - Parent dir issues (EACCES, ENOTDIR, ELOOP) → ALSO
        //     real failure. The file might or might not exist; we
        //     can't tell because the path can't be resolved. Don't
        //     pretend it's a fresh-install just because we couldn't
        //     prove the file is there.
        //
        // Why lstatSync (not existsSync): existsSync swallows ALL
        // stat errors and returns false. So `existsSync === false`
        // covers ENOENT (file absent), EACCES (parent perm denied),
        // ENOTDIR (parent isn't a dir), ELOOP (symlink cycle),
        // ENAMETOOLONG, etc. Downgrading all of those to "fresh
        // install" silently hides real operational failures from
        // cron jobs and operators. lstatSync surfaces the error
        // code so we can discriminate ENOENT specifically.
        let trulyAbsent = false;
        let preCheckError: string | null = null;
        try {
          lstatSync(dbPath);
          // File exists. openDb failure below is a real failure.
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            trulyAbsent = true;
          } else {
            // Non-ENOENT stat error — path inaccessible OR
            // mis-configured. Treat as real failure regardless of
            // what openDb does next; the operator's storage path
            // is broken and they need to know.
            preCheckError = e instanceof Error ? e.message : String(e);
          }
        }
        if (preCheckError !== null) {
          err(`forja gc: cannot inspect DB path ${dbPath}: ${preCheckError}\n`);
          return 1;
        }
        try {
          db = openDb(dbPath, { readonly: true });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          if (!trulyAbsent) {
            // File exists but unopenable: real failure. Surface
            // with exit 1 so scripts notice. Don't render an
            // "empty report" because we DON'T know if there are
            // rows — pretending we do would mask the failure.
            err(`forja gc: DB at ${dbPath} exists but cannot be opened in dry-run: ${reason}\n`);
            return 1;
          }
          // File truly absent (ENOENT confirmed by lstat above):
          // fresh-install case. Empty report + exit 0 + helpful
          // pointer to the force command that would create it.
          const forceCommand = buildForceCommand(tables);
          err(
            `forja gc: DB not yet created at ${dbPath} (fresh install — no rows to sweep). Run \`${forceCommand}\` to create + migrate.\n`,
          );
          const emptyReport: GcReport = {
            mode: 'dry-run',
            nowMs: nowFn(),
            config: loaded.config,
            tables: [],
            errors: [],
          };
          if (json) {
            out(`${JSON.stringify(serializeReport(emptyReport, loaded.sources, forceCommand))}\n`);
          } else {
            renderHumanDryRun(emptyReport, loaded.sources, forceCommand, out);
          }
          return 0;
        }
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
      // Preserve the operator's --table=X scope in the suggested
      // command so copy-pasting the dry-run output doesn't widen
      // the sweep to all tables. Force-mode JSON omits the field
      // entirely (no follow-up to suggest).
      const cmd = force ? null : buildForceCommand(tables);
      out(`${JSON.stringify(serializeReport(report, loaded.sources, cmd))}\n`);
    } else if (force) {
      renderHumanForce(report, out);
    } else {
      renderHumanDryRun(report, loaded.sources, buildForceCommand(tables), out);
    }

    // Errors are per-table best-effort; surface as non-zero exit
    // so cron jobs detect the failure even when the other tables
    // swept fine.
    return report.errors.length > 0 ? 2 : 0;
  } finally {
    if (db !== null) {
      try {
        closeDb(db);
      } catch {
        // ignore — sweep already committed
      }
    }
  }
};

// Re-exports for tests pinning behavior at module boundary.
export type { TableReport };
