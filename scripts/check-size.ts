// Size gate from PERFORMANCE.md §18.2.
//
// Three tiers per target:
//   - bytes <= sizeMax       : ok        (silent pass)
//   - sizeMax < bytes <= block: warn     (release proceeds; logged to stderr)
//   - bytes > block          : block    (exit 1, release MUST NOT ship)
//
// Pure logic in `classify*` so tests don't need filesystem fixtures.
// IO lives in `runCheck`.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildTarget, SIZE_BLOCK_RATIO, TARGETS, assetName } from './targets.ts';

export type Verdict = 'ok' | 'warn' | 'block';

export interface SizeRow {
  target: BuildTarget;
  bytes: number;
  verdict: Verdict;
}

const MIB = 1024 * 1024;

export const classifyBytes = (bytes: number, sizeMaxMiB: number): Verdict => {
  const max = sizeMaxMiB * MIB;
  // Strict-less-than for the warn boundary so a binary that hits
  // the budget exactly is OK; the spec phrases the warn tier as
  // "hit do target" — equality counts as hit, not over.
  if (bytes < max) return 'ok';
  if (bytes <= max * SIZE_BLOCK_RATIO) return 'warn';
  return 'block';
};

export const classify = (target: BuildTarget, bytes: number): SizeRow => ({
  target,
  bytes,
  verdict: classifyBytes(bytes, target.sizeMaxMiB),
});

const fmtMiB = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

export const formatRow = (row: SizeRow): string => {
  const tag = row.verdict === 'ok' ? 'OK   ' : row.verdict === 'warn' ? 'WARN ' : 'BLOCK';
  const budget = `${row.target.sizeMaxMiB} MiB`;
  return `${tag} ${row.target.id.padEnd(14)} ${fmtMiB(row.bytes).padStart(10)}  (budget ${budget})`;
};

export interface CheckOptions {
  // Directory holding the cross-platform binaries; defaults to `dist/`.
  distDir?: string;
  // If true, missing binaries are skipped without erroring. Default
  // false: the gate is meant to run after a full matrix build, so a
  // missing target is itself a failure. The local one-target case
  // calls `runCheck({ ids: ['linux-x64'] })` instead.
  allowMissing?: boolean;
  // Restrict the check to a subset of target ids. Empty / undefined
  // means all targets.
  ids?: readonly string[];
}

export interface CheckResult {
  rows: SizeRow[];
  missing: string[];
  exitCode: 0 | 1;
}

export const runCheck = (opts: CheckOptions = {}): CheckResult => {
  const distDir = opts.distDir ?? 'dist';
  const ids = opts.ids;
  const subset = ids && ids.length > 0 ? TARGETS.filter((t) => ids.includes(t.id)) : TARGETS;
  const rows: SizeRow[] = [];
  const missing: string[] = [];
  for (const t of subset) {
    const path = join(distDir, assetName(t));
    let bytes: number;
    try {
      bytes = statSync(path).size;
    } catch {
      if (opts.allowMissing) continue;
      missing.push(path);
      continue;
    }
    rows.push(classify(t, bytes));
  }
  const blocked = rows.some((r) => r.verdict === 'block');
  const hasMissing = missing.length > 0;
  return { rows, missing, exitCode: blocked || hasMissing ? 1 : 0 };
};

const main = (): void => {
  const result = runCheck();
  for (const row of result.rows) {
    const stream = row.verdict === 'ok' ? process.stdout : process.stderr;
    stream.write(`${formatRow(row)}\n`);
  }
  for (const m of result.missing) {
    process.stderr.write(`MISSING ${m}\n`);
  }
  process.exit(result.exitCode);
};

if (import.meta.main) main();
