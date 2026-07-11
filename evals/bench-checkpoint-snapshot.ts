#!/usr/bin/env bun
// Benchmark for the checkpoint snapshot path against
// CHECKPOINTS.md §5 criterion 7: p95 < 500ms in a repo of 10k files.
//
// Usage:
//   bun run evals/bench-checkpoint-snapshot.ts [--files N] [--iters N]
//
// Defaults: 10000 files, 100 iterations. Creates a synthetic repo under
// /tmp, populates it with N small files, seeds an initial commit, then
// loops N iterations of (touch one file → snapshot → measure). Each
// iteration mutates exactly one file so the snapshot has real work to
// do (skip-on-noop would otherwise short-circuit and return null,
// invalidating the measurement).
//
// Exit code 0 when p95 stays under the SLO; 1 otherwise. Stdout
// reports p50 / p95 / p99 / max in ms so a CI gate can grep.
//
// Cost: $0 — pure local subprocess benchmark, no API.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot } from '../src/checkpoints/git.ts';

interface Args {
  files: number;
  iters: number;
  sloP95Ms: number;
}

const parseArgs = (argv: readonly string[]): Args => {
  const out: Args = { files: 10_000, iters: 100, sloP95Ms: 500 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--files' && next !== undefined) {
      out.files = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--iters' && next !== undefined) {
      out.iters = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--slo-p95-ms' && next !== undefined) {
      out.sloP95Ms = Number.parseInt(next, 10);
      i++;
    }
  }
  return out;
};

const runGit = async (cwd: string, args: string[]): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: {
      LC_ALL: 'C',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@local',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@local',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${exitCode}: ${stderr}`);
  }
};

const populateRepo = async (cwd: string, fileCount: number): Promise<void> => {
  // Spread files across a shallow tree so we don't trip filesystem
  // per-directory entry limits (ext4 ~10M, but OS-level tools — ls,
  // bash globs — get unwieldy past a few thousand). 100 dirs × N
  // files keeps each directory well below pathological depth.
  const dirsPerLevel = 100;
  const filesPerDir = Math.ceil(fileCount / dirsPerLevel);
  let written = 0;
  for (let d = 0; d < dirsPerLevel && written < fileCount; d++) {
    const dirPath = join(cwd, `d${d.toString().padStart(3, '0')}`);
    await mkdir(dirPath, { recursive: true });
    for (let f = 0; f < filesPerDir && written < fileCount; f++) {
      // Small contents — the bench measures git's traversal cost,
      // not blob hashing of large files. ~24 bytes per file × 10k
      // ≈ 240KB total content, dominated by directory walking.
      await writeFile(join(dirPath, `f${f.toString().padStart(4, '0')}.txt`), `seed ${d}/${f}\n`);
      written++;
    }
  }
};

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  // Nearest-rank — simpler than linear interpolation and adequate
  // for SLO checks (we want "p95 of observed", not a continuous
  // distribution estimate).
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  console.log(`bench: files=${args.files} iters=${args.iters} slo_p95_ms=${args.sloP95Ms}`);

  const repo = await mkdtemp(join(tmpdir(), 'forja-bench-ckpt-'));
  try {
    console.log(`bench: setup repo at ${repo}`);
    const setupStart = Date.now();
    await runGit(repo, ['init', '-b', 'main']);
    await populateRepo(repo, args.files);
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'seed']);
    console.log(`bench: setup done in ${Date.now() - setupStart}ms`);

    const sessionId = 'bench-session';
    const timingsMs: number[] = [];
    // Warm-up: first invocation pays page-cache + JIT costs that
    // skew the p95 if we count it. One discarded round is enough
    // to get the dirty pages of /tmp/.git into RAM.
    await snapshot({
      cwd: repo,
      sessionId,
      stepId: 'warmup',
      iso: new Date().toISOString(),
    });

    for (let i = 0; i < args.iters; i++) {
      // Mutate one file per iteration so write-tree has real work.
      // Touching the same file each iteration also exercises the
      // common case (incremental edit), not the rare full-tree
      // change.
      await writeFile(join(repo, 'd000', 'f0000.txt'), `bench iter ${i} ${Date.now()}\n`);
      const start = Bun.nanoseconds();
      const result = await snapshot({
        cwd: repo,
        sessionId,
        stepId: `iter-${i}`,
        iso: new Date().toISOString(),
        stepN: i,
      });
      const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
      // sha=null would mean the snapshot skipped (working tree
      // matched parent). With per-iteration mutation that should
      // never happen; if it does, the measurement is meaningless.
      if (result.sha === null) {
        console.error(`bench: iter ${i} returned null sha — skip-on-noop fired unexpectedly`);
        return 1;
      }
      timingsMs.push(elapsedMs);
    }

    const sorted = [...timingsMs].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    const max = sorted[sorted.length - 1] ?? 0;
    const min = sorted[0] ?? 0;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;

    console.log('');
    console.log('Snapshot timing (ms):');
    console.log(`  min:  ${min.toFixed(2)}`);
    console.log(`  p50:  ${p50.toFixed(2)}`);
    console.log(`  mean: ${mean.toFixed(2)}`);
    console.log(`  p95:  ${p95.toFixed(2)}`);
    console.log(`  p99:  ${p99.toFixed(2)}`);
    console.log(`  max:  ${max.toFixed(2)}`);

    if (p95 > args.sloP95Ms) {
      console.error(
        `\nFAIL: p95 ${p95.toFixed(2)}ms exceeds SLO of ${args.sloP95Ms}ms (CHECKPOINTS §2.8)`,
      );
      return 1;
    }
    console.log(`\nPASS: p95 ${p95.toFixed(2)}ms <= SLO ${args.sloP95Ms}ms`);
    return 0;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
};

const exitCode = await main();
process.exit(exitCode);
