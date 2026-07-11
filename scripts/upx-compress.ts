// UPX compress wrapper (PERFORMANCE.md §18.3).
//
// Runs `upx --best` over each binary in `dist/` (or a target subset)
// and captures the size delta. The spec quotes -40% size / +30 ms
// startup as the trade-off; the `--compress` flag is opt-in for
// release artifacts where transfer cost dominates startup latency
// (CDN / brew tap publishes). Default release ships uncompressed.
//
// UPX does not yet support darwin-arm64 binaries; we skip those
// targets with a notice rather than failing. macOS x64 is also
// limited (recent UPX versions support it, older skip).
//
// CLI:
//   bun run scripts/upx-compress.ts [--target=<id>...] [--dist=<path>]

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assetName, type BuildTarget, findTarget, TARGETS } from './targets.ts';

// Minimal spawn-result shape consumed by this script. We only need
// `status`; using the full SpawnSyncReturns<Buffer> would force test
// fakes to construct a Buffer payload they never read.
interface SpawnResult {
  status: number | null;
}

// Targets where UPX is currently broken / refuses to compress. The
// macOS arm64 case is the primary blocker (UPX 4.x emits "macho/arm
// not supported"); macOS x64 works on recent UPX but we keep an
// allow-list rather than try-and-skip so the gate is predictable.
const UPX_UNSUPPORTED: readonly string[] = ['darwin-arm64'];

export interface CompressRow {
  target: BuildTarget;
  bytesBefore: number;
  bytesAfter: number;
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
}

export interface CompressOptions {
  distDir: string;
  ids: readonly string[];
  spawn?: (cmd: string, args: readonly string[]) => SpawnResult;
}

const defaultSpawn = (cmd: string, args: readonly string[]): SpawnResult => {
  const r = spawnSync(cmd, [...args]);
  return { status: r.status };
};

// Resolve a list of target ids; throw on unknown so a typoed
// `--target=lnux-x64` doesn't silently produce a zero-row "successful"
// compression run.
export const resolveIds = (ids: readonly string[]): BuildTarget[] => {
  if (ids.length === 0) return [...TARGETS];
  const out: BuildTarget[] = [];
  for (const id of ids) {
    const t = findTarget(id);
    if (t === undefined) throw new Error(`unknown target: ${id}`);
    out.push(t);
  }
  return out;
};

export const runCompress = (opts: CompressOptions): CompressRow[] => {
  const subset = resolveIds(opts.ids);
  const rows: CompressRow[] = [];
  const spawn = opts.spawn ?? defaultSpawn;
  for (const t of subset) {
    const path = join(opts.distDir, assetName(t));
    if (!existsSync(path)) {
      rows.push({
        target: t,
        bytesBefore: 0,
        bytesAfter: 0,
        status: 'skipped',
        reason: 'asset missing',
      });
      continue;
    }
    if (UPX_UNSUPPORTED.includes(t.id)) {
      rows.push({
        target: t,
        bytesBefore: statSync(path).size,
        bytesAfter: statSync(path).size,
        status: 'skipped',
        reason: 'UPX does not support this target',
      });
      continue;
    }
    const before = statSync(path).size;
    const r = spawn('upx', ['--best', '--quiet', path]);
    if (r.status !== 0) {
      rows.push({
        target: t,
        bytesBefore: before,
        bytesAfter: before,
        status: 'failed',
        reason: `upx exited ${r.status}`,
      });
      continue;
    }
    const after = statSync(path).size;
    rows.push({ target: t, bytesBefore: before, bytesAfter: after, status: 'ok' });
  }
  return rows;
};

const fmtMiB = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MiB`;

export const formatRow = (r: CompressRow): string => {
  if (r.status === 'skipped') {
    return `SKIP ${r.target.id.padEnd(14)} ${r.reason ?? ''}`;
  }
  if (r.status === 'failed') {
    return `FAIL ${r.target.id.padEnd(14)} ${r.reason ?? ''}`;
  }
  const pct =
    r.bytesBefore === 0 ? 0 : Math.round(((r.bytesBefore - r.bytesAfter) / r.bytesBefore) * 100);
  return `OK   ${r.target.id.padEnd(14)} ${fmtMiB(r.bytesBefore)} → ${fmtMiB(r.bytesAfter)}  (-${pct}%)`;
};

const parseArgs = (argv: readonly string[]): CompressOptions => {
  let distDir = 'dist';
  const ids: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--target=')) ids.push(a.slice('--target='.length));
    else if (a.startsWith('--dist=')) distDir = a.slice('--dist='.length);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bun run scripts/upx-compress.ts [--target=<id>...] [--dist=<path>]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return { distDir, ids };
};

const main = (): void => {
  const opts = parseArgs(process.argv.slice(2));
  let rows: CompressRow[];
  try {
    rows = runCompress(opts);
  } catch (e) {
    // resolveIds throws on unknown --target; convert to exit-2 so
    // release tooling surfaces the typo before downstream steps.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  for (const r of rows) process.stdout.write(`${formatRow(r)}\n`);
  if (rows.some((r) => r.status === 'failed')) process.exit(1);
};

if (import.meta.main) main();
