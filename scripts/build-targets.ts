// Cross-platform build orchestrator (PERFORMANCE.md §18.1, §18.5).
//
// For each target in `TARGETS`, runs `bun build --compile --minify
// --sourcemap=external --target=<bun-target> --outfile=dist/agent-<id>`.
// Sourcemaps land alongside the binary as `<asset>.map`.
//
// CLI flags:
//   --target=<id>       restrict to one target (repeatable)
//   --dist=<path>       override output dir (default: dist)
//   --entry=<path>      override entry (default: src/cli/index.ts)
//   --no-minify         disable --minify (debug builds)
//   --no-sourcemap      omit sourcemap (smaller artifact, no debug)
//
// Cross-compile note: Bun's `--target=bun-<os>-<arch>` produces a
// binary for that platform from any host. The runner only needs Bun
// itself + write access to `dist/`; no per-OS toolchain.
//
// Bun does NOT yet emit a stable, identical binary across two runs
// at the same SHA (timestamps in the embedded loader). Reproducible
// build verification (Slice D) handles that with SOURCE_DATE_EPOCH +
// retry tolerance — this orchestrator just builds.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildTarget, TARGETS, assetName, findTarget } from './targets.ts';

export interface BuildOptions {
  distDir: string;
  entry: string;
  minify: boolean;
  sourcemap: boolean;
  // Optional override of which targets to build. Empty / undefined
  // means all `TARGETS`.
  ids: readonly string[];
  // Test seam: invokes Bun. Returns the exit code; stdout/stderr go
  // to the parent process inheritedly.
  spawn?: (cmd: string, args: readonly string[]) => { status: number | null };
}

const defaultSpawn = (cmd: string, args: readonly string[]): { status: number | null } =>
  spawnSync(cmd, [...args], { stdio: 'inherit' });

export const buildArgs = (
  target: BuildTarget,
  opts: Pick<BuildOptions, 'distDir' | 'entry' | 'minify' | 'sourcemap'>,
): string[] => {
  const out = join(opts.distDir, assetName(target));
  const args = [
    'build',
    opts.entry,
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${out}`,
  ];
  if (opts.minify) args.push('--minify');
  if (opts.sourcemap) args.push('--sourcemap=external');
  return args;
};

export interface BuildResult {
  target: BuildTarget;
  status: number | null;
}

export const runBuild = (opts: BuildOptions): BuildResult[] => {
  const spawn = opts.spawn ?? defaultSpawn;
  const subset =
    opts.ids.length > 0
      ? opts.ids.map((id) => findTarget(id)).filter((t): t is BuildTarget => t !== undefined)
      : TARGETS;

  if (!existsSync(opts.distDir)) mkdirSync(opts.distDir, { recursive: true });

  const results: BuildResult[] = [];
  for (const target of subset) {
    // Wipe the prior asset so a failed build doesn't leave a stale
    // binary that the next pipeline step (size gate, checksums)
    // would treat as the current run's output.
    const out = join(opts.distDir, assetName(target));
    if (existsSync(out)) rmSync(out, { force: true });
    if (existsSync(`${out}.map`)) rmSync(`${out}.map`, { force: true });

    const args = buildArgs(target, opts);
    const { status } = spawn('bun', args);
    results.push({ target, status });
    if (status !== 0) {
      process.stderr.write(`build failed for ${target.id} (exit ${status})\n`);
    }
  }
  return results;
};

interface ParsedArgs {
  ids: string[];
  distDir: string;
  entry: string;
  minify: boolean;
  sourcemap: boolean;
}

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const out: ParsedArgs = {
    ids: [],
    distDir: 'dist',
    entry: 'src/cli/index.ts',
    minify: true,
    sourcemap: true,
  };
  for (const a of argv) {
    if (a.startsWith('--target=')) out.ids.push(a.slice('--target='.length));
    else if (a.startsWith('--dist=')) out.distDir = a.slice('--dist='.length);
    else if (a.startsWith('--entry=')) out.entry = a.slice('--entry='.length);
    else if (a === '--no-minify') out.minify = false;
    else if (a === '--no-sourcemap') out.sourcemap = false;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: bun run scripts/build-targets.ts [--target=<id>...] [--dist=<path>] [--entry=<path>] [--no-minify] [--no-sourcemap]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
};

const main = (): void => {
  const parsed = parseArgs(process.argv.slice(2));
  const results = runBuild(parsed);
  const failed = results.filter((r) => r.status !== 0);
  if (failed.length > 0) {
    process.stderr.write(`${failed.length}/${results.length} target build(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`built ${results.length} target(s) into ${parsed.distDir}\n`);
};

if (import.meta.main) main();
