// `agent --code-index <verb>` handler. Independent of bootstrap
// (no provider, no permissions, no tool registry — only DB +
// tree-sitter + FS) so operators can index, inspect, or rebuild
// without an API key. Mirrors the structure of `worktrees.ts`.
//
// Subcommands:
//   scan                — initial / incremental full scan against
//                         the resolved project root (cwd's git
//                         toplevel, or realpath(cwd) when not a
//                         git repo)
//   status              — print IndexStatus for the project's DB
//                         (no scan side effect)
//   rebuild [--clean]   — equivalent to `scan` (idempotent), with
//                         `--clean` deleting the on-disk DB first
//                         so migrations re-run from zero. Useful
//                         when schema regressions corrupted state
//                         or `[code_index]` config changed.
//                         `--since <commit>` is deferred (needs
//                         a git-diff-aware walker pass).

import { unlinkSync } from 'node:fs';
import { CodeIndex } from '../code-index/index.ts';
import { defaultCodeIndexPath } from '../code-index/paths.ts';
import { resolveProjectRoot } from '../code-index/project-root.ts';
import type { ScanResult } from '../code-index/scanner/pipeline.ts';
import type { IndexStatus } from '../code-index/types.ts';
import type { DB } from '../storage/db.ts';

export interface CodeIndexCliInput {
  verb: 'scan' | 'status' | 'rebuild';
  positionals: string[];
  json: boolean;
  cwd: string;
  // Test-only seam. Bypasses both project-root resolution and
  // disk-backed DB path. When supplied, the handler scans
  // against `cwd` directly and writes to the in-memory DB.
  dbOverride?: DB;
  // Test-only seam. Overrides env vars for path resolution
  // (XDG_DATA_HOME, HOME). Production passes process.env.
  env?: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
}

const VALID_VERBS = ['scan', 'status', 'rebuild'] as const;

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const formatTimestamp = (ms: number | null): string => {
  if (ms === null) return 'never';
  return new Date(ms).toISOString();
};

const writeStatusJson = (status: IndexStatus, out: (s: string) => void): void => {
  out(
    `${JSON.stringify({
      schema_version: status.schemaVersion,
      files_indexed: status.filesIndexed,
      files_failed: status.filesFailed,
      db_size_bytes: status.dbSizeBytes,
      last_full_scan_at: status.lastFullScanAt,
    })}\n`,
  );
};

const writeStatusTable = (status: IndexStatus, out: (s: string) => void): void => {
  const rows: [string, string][] = [
    ['schema_version', String(status.schemaVersion)],
    ['files_indexed', String(status.filesIndexed)],
    ['files_failed', String(status.filesFailed)],
    ['db_size_bytes', formatBytes(status.dbSizeBytes)],
    ['last_full_scan', formatTimestamp(status.lastFullScanAt)],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) {
    out(`${k.padEnd(w)}  ${v}\n`);
  }
};

const writeScanJson = (result: ScanResult, durationMs: number, out: (s: string) => void): void => {
  out(
    `${JSON.stringify({
      files_scanned: result.filesScanned,
      symbols_inserted: result.symbolsInserted,
      imports_inserted: result.importsInserted,
      references_inserted: result.referencesInserted,
      imports_resolved: result.importsResolved,
      references_resolved: result.referencesResolved,
      partials: result.partials,
      errors: result.errors.length,
      duration_ms: durationMs,
    })}\n`,
  );
  // Emit each error as its own NDJSON line so streaming
  // consumers can correlate per-file failures.
  for (const e of result.errors) {
    out(`${JSON.stringify({ error: { path: e.path, message: e.error } })}\n`);
  }
};

const writeScanTable = (
  result: ScanResult,
  durationMs: number,
  out: (s: string) => void,
  err: (s: string) => void,
): void => {
  out(
    `Scanned ${result.filesScanned} files in ${durationMs} ms — ` +
      `${result.symbolsInserted} symbols, ` +
      `${result.importsInserted} imports (${result.importsResolved} resolved), ` +
      `${result.referencesInserted} refs (${result.referencesResolved} resolved), ` +
      `${result.partials} partial, ${result.errors.length} failed.\n`,
  );
  // Per-file errors go to stderr so a `--json`-equivalent
  // human session keeps stdout focused on the summary; the
  // operator still sees what went wrong.
  for (const e of result.errors) {
    err(`  failed: ${e.path}: ${e.error}\n`);
  }
};

export const runCodeIndexCli = async (input: CodeIndexCliInput): Promise<number> => {
  const { verb, positionals, json, cwd, dbOverride, env, out, err } = input;

  // Initial guard: invalid verb is a parser bug (args.ts already
  // narrows to VALID_VERBS), but we re-check defensively so a
  // programmatic caller bypassing parseArgs gets a clear error
  // rather than crashing inside the dispatch.
  if (!VALID_VERBS.includes(verb)) {
    err(`code-index: unknown verb '${verb}'. Use one of ${VALID_VERBS.join('|')}\n`);
    return 2;
  }

  const projectRoot = dbOverride !== undefined ? cwd : resolveProjectRoot(cwd);

  // For `rebuild --clean`, drop the DB file BEFORE init so
  // migrations re-run from zero. Skip when dbOverride is in play
  // (test path; caller manages lifetime). ENOENT is treated as
  // success — the file may not exist (first --clean ever, or
  // another process raced us) and `rebuild --clean` is meant
  // to be idempotent.
  if (verb === 'rebuild' && positionals.includes('--clean') && dbOverride === undefined) {
    const dbPath = defaultCodeIndexPath(projectRoot, env);
    try {
      unlinkSync(dbPath);
    } catch (e) {
      const code =
        e !== null && typeof e === 'object' && 'code' in e
          ? (e as { code: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        err(
          `code-index: failed to delete '${dbPath}': ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return 1;
      }
    }
  }

  // Single CodeIndex instance for the whole verb. `init` opens
  // the DB and runs migrations idempotently.
  const idx = await CodeIndex.init({
    projectRoot,
    ...(dbOverride !== undefined ? { dbOverride } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  try {
    if (verb === 'status') {
      const status = idx.status();
      if (json) writeStatusJson(status, out);
      else writeStatusTable(status, out);
      return 0;
    }

    // scan / rebuild — same code path, distinguished only by
    // the prior `--clean` step above.
    const startedAt = Date.now();
    const result = await idx.scan({ respectGitignore: true });
    const durationMs = Date.now() - startedAt;

    if (json) writeScanJson(result, durationMs, out);
    else writeScanTable(result, durationMs, out, err);

    // Non-zero exit on any file failure so CI / scripts see the
    // signal. Partials are warnings, not failures.
    return result.errors.length > 0 ? 1 : 0;
  } finally {
    idx.close();
  }
};
