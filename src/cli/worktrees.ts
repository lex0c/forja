// `agent --worktrees <verb>` handler. Independent of bootstrap
// (no provider, no permissions, no tool registry — only DB +
// git in cwd) so inspecting/garbage-collecting worktrees doesn't
// require an API key. Mirrors the structure of
// `runCheckpointsCli`.
//
// Subcommands:
//   list                — table / NDJSON of every classified entry
//   gc [--dry-run] [--force]
//                       — apply the gc plan; --dry-run renders
//                         the plan only; --force lifts the
//                         skip on dirty preserved + orphans

import { type DB, closeDb, defaultDbPath, migrate, openDb } from '../storage/index.ts';
import {
  type WorktreeGcEntry,
  type WorktreeGcPlan,
  applyGcPlan,
  buildGcPlan,
} from '../subagents/worktree-gc.ts';

export interface WorktreesCliInput {
  verb: 'list' | 'gc';
  positionals: string[];
  json: boolean;
  // gc-specific flags. The parser doesn't need to know about
  // them; we treat them as positional tokens (`--dry-run`,
  // `--force`) and the handler splits.
  cwd: string;
  dbPath?: string;
  dbOverride?: DB;
  // Output sinks. `out` carries the user-visible result;
  // `err` carries diagnostic and warning lines. Mirrors the
  // stdout/stderr split spec §2.6 mandates.
  out: (s: string) => void;
  err: (s: string) => void;
}

const VALID_VERBS = ['list', 'gc'] as const;

const renderEntry = (entry: WorktreeGcEntry): Record<string, unknown> => ({
  kind: entry.kind,
  path: entry.path,
  branch: entry.branch,
  session_id: entry.sessionId,
  reason: entry.reason,
});

const writeListJson = (plan: WorktreeGcPlan, out: (s: string) => void): void => {
  for (const entry of plan.entries) out(`${JSON.stringify(renderEntry(entry))}\n`);
};

const writeListTable = (plan: WorktreeGcPlan, out: (s: string) => void): void => {
  if (plan.entries.length === 0) {
    out('no worktrees found.\n');
    return;
  }
  // Operator-readable: kind | path | branch | session id. Path
  // and branch fit even on narrow terminals (cache root +
  // session UUID + agent/<slug>-<id> stay under ~120 chars).
  const header = ['kind', 'path', 'branch', 'session'].join('  ');
  out(`${header}\n`);
  for (const entry of plan.entries) {
    const session = entry.sessionId ?? '-';
    const branch = entry.branch ?? '-';
    out(`${entry.kind}  ${entry.path}  ${branch}  ${session}\n`);
  }
  out(`\ncache root: ${plan.cacheRoot}\n`);
};

export const runWorktreesCli = async (input: WorktreesCliInput): Promise<number> => {
  const { verb, positionals, json, cwd, out, err } = input;

  if (!VALID_VERBS.includes(verb)) {
    err(`forja: unknown --worktrees subcommand: ${verb}. Use one of ${VALID_VERBS.join('|')}\n`);
    return 1;
  }

  // DB open (or the test override). Migrations run defensively
  // — gc may be the first command an operator runs after
  // upgrading, before any session writes.
  const db = input.dbOverride ?? openDb(input.dbPath ?? defaultDbPath());
  try {
    if (input.dbOverride === undefined) migrate(db);

    if (verb === 'list') {
      // `list` takes no positionals. The parser's verb-aware
      // allowlist already stops collection on any non-allowed
      // flag-shaped token, but a stray bare word ("agent
      // --worktrees list xyz") would still come through. Reject
      // loud so the operator sees the typo.
      if (positionals.length > 0) {
        err(`forja: --worktrees list takes no positionals; got: ${positionals.join(' ')}\n`);
        return 1;
      }
      const plan = await buildGcPlan({ db, parentCwd: cwd });
      // Surface non-fatal anomalies to stderr regardless of
      // output mode. Spec §2.6: stdout is pure, stderr is for
      // logs — including these on stdout would corrupt NDJSON.
      for (const w of plan.warnings) err(`forja: ${w}\n`);
      if (json) {
        writeListJson(plan, out);
        // Final NDJSON summary object so consumers parsing the
        // stream get an explicit end-of-output signal. Symmetric
        // with `gc` and `gc --dry-run` json paths.
        out(`${JSON.stringify({ count: plan.entries.length, cache_root: plan.cacheRoot })}\n`);
      } else {
        writeListTable(plan, out);
      }
      return 0;
    }

    // gc
    const dryRun = positionals.includes('--dry-run');
    const force = positionals.includes('--force');
    // Reject unknown gc flags — operator typo should fail fast,
    // not silently no-op. The subcommand parser swept all
    // tokens after `gc` into positionals, so anything that's
    // not --dry-run or --force is an error.
    for (const token of positionals) {
      if (token !== '--dry-run' && token !== '--force') {
        err(`forja: unknown --worktrees gc flag: ${token}. Recognized: --dry-run, --force\n`);
        return 1;
      }
    }

    const plan = await buildGcPlan({ db, parentCwd: cwd });
    // Same warning surface as the list path — stderr regardless
    // of mode so NDJSON stays valid.
    for (const w of plan.warnings) err(`forja: ${w}\n`);
    if (dryRun) {
      // Same shape as `list` — operator can compare what gc
      // WOULD do against current state. The trailing summary
      // line MUST honor the json/table split: in --json mode
      // we emit a final NDJSON object, never plain text. Spec
      // §2.6 + CLAUDE.md "stdout is pure, stderr is for logs"
      // — a single non-JSON line breaks every machine consumer
      // that parses stdout as NDJSON.
      if (json) {
        writeListJson(plan, out);
        out(`${JSON.stringify({ dry_run: true, considered: plan.entries.length })}\n`);
      } else {
        writeListTable(plan, out);
        out(
          `\ndry-run summary: ${plan.entries.length} entr${plan.entries.length === 1 ? 'y' : 'ies'} considered\n`,
        );
      }
      return 0;
    }

    const summary = await applyGcPlan({ db, parentCwd: cwd, plan, force });
    if (json) {
      for (const o of summary.outcomes) {
        out(`${JSON.stringify(o)}\n`);
      }
      out(
        `${JSON.stringify({ removed: summary.removedCount, skipped: summary.skippedCount, failed: summary.failedCount, reconciled: summary.reconciledCount })}\n`,
      );
    } else {
      for (const o of summary.outcomes) {
        out(`${o.action}: ${o.path} — ${o.detail}\n`);
      }
      out(
        `\n${summary.removedCount} removed, ${summary.reconciledCount} reconciled, ${summary.skippedCount} skipped, ${summary.failedCount} failed\n`,
      );
    }
    return summary.failedCount > 0 ? 1 : 0;
  } catch (e) {
    err(`forja: --worktrees ${verb} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    if (input.dbOverride === undefined) {
      try {
        closeDb(db);
      } catch {
        // ignore
      }
    }
  }
};
