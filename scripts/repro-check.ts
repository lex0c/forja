// Reproducible-build verification (SECURITY_GUIDELINE.md §7.2,
// PERFORMANCE.md §18.5 line 633).
//
// "Mesmo source ⇒ mesmo binário" is the guarantee. Bun compiles AOT
// and is mostly deterministic, but the embedded loader can pick up
// build-time timestamps in some Bun versions. We pin
// SOURCE_DATE_EPOCH to a known value so any embedded clock reads the
// same on both runs.
//
// Verb:
//   bun run scripts/repro-check.ts [--target=<id>...]
//
// Strategy: build the same target twice into different directories,
// compare SHA256. If they match, reproducibility holds for that run
// of the toolchain. If they diverge, the diff is captured to
// `dist/repro/<id>.diff` for forensics.
//
// This is a CI gate, not a local development helper — it doubles
// build time. The local `build:release` script does NOT call this.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './checksums.ts';
import { assetName, type BuildTarget, findTarget, TARGETS } from './targets.ts';

const SOURCE_DATE_EPOCH = '1700000000'; // 2023-11-14T22:13:20Z, fixed.

interface BuildOnce {
  outDir: string;
  hash: string;
}

const buildOnce = (target: BuildTarget, outDir: string): BuildOnce => {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const args = [
    'build',
    'src/cli/index.ts',
    '--compile',
    `--target=${target.bunTarget}`,
    `--outfile=${join(outDir, assetName(target))}`,
    '--minify',
  ];
  const result = spawnSync('bun', args, {
    stdio: 'inherit',
    env: { ...process.env, SOURCE_DATE_EPOCH },
  });
  if (result.status !== 0) {
    throw new Error(`build failed for ${target.id} (exit ${result.status})`);
  }
  const hash = sha256File(join(outDir, assetName(target)));
  return { outDir, hash };
};

export interface ReproRow {
  target: BuildTarget;
  hashA: string;
  hashB: string;
  reproducible: boolean;
}

export const checkTargets = (targets: readonly BuildTarget[], reproDir: string): ReproRow[] => {
  if (!existsSync(reproDir)) mkdirSync(reproDir, { recursive: true });
  const rows: ReproRow[] = [];
  for (const t of targets) {
    const a = buildOnce(t, join(reproDir, `${t.id}-a`));
    const b = buildOnce(t, join(reproDir, `${t.id}-b`));
    const reproducible = a.hash === b.hash;
    rows.push({ target: t, hashA: a.hash, hashB: b.hash, reproducible });
    if (!reproducible) {
      // Persist a small marker so a CI failure leaves something
      // forensically useful instead of just two reproduced trees
      // that get cleaned up. Full byte-diff is too large to keep
      // (50 MiB binaries); the hashes + paths are enough to
      // reproduce locally.
      writeFileSync(
        join(reproDir, `${t.id}.diff`),
        `target=${t.id}\nhashA=${a.hash}\nhashB=${b.hash}\noutA=${a.outDir}\noutB=${b.outDir}\n`,
      );
    }
  }
  return rows;
};

const parseTargets = (argv: readonly string[]): BuildTarget[] => {
  const ids: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--target=')) ids.push(a.slice('--target='.length));
  }
  if (ids.length === 0) return [...TARGETS];
  const out: BuildTarget[] = [];
  for (const id of ids) {
    const t = findTarget(id);
    if (t === undefined) {
      process.stderr.write(`unknown target: ${id}\n`);
      process.exit(2);
    }
    out.push(t);
  }
  return out;
};

const main = (): void => {
  const targets = parseTargets(process.argv.slice(2));
  const reproDir = join('dist', 'repro');
  const rows = checkTargets(targets, reproDir);
  for (const r of rows) {
    const tag = r.reproducible ? 'OK   ' : 'FAIL ';
    process.stdout.write(`${tag} ${r.target.id.padEnd(14)} ${r.hashA.slice(0, 16)}…\n`);
  }
  const anyFailed = rows.some((r) => !r.reproducible);
  if (anyFailed) {
    process.stderr.write('reproducibility check failed; see dist/repro/<id>.diff\n');
    process.exit(1);
  }
  // Happy path: reclaim the ~1 GiB of duplicate binaries the double
  // build left under dist/repro/. On failure we keep them so the
  // operator can inspect the diff sentinel + the two trees.
  if (existsSync(reproDir)) rmSync(reproDir, { recursive: true, force: true });
};

if (import.meta.main) main();
