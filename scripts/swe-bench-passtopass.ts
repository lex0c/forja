// self-SWE-bench PASS_TO_PASS enrichment (anti-cheat gate #9). The verifier runs the oracle test
// file, which already runs every case in that file (within-file PASS_TO_PASS, free). The remaining
// overfit vector: a model edits src so the oracle passes but BREAKS other tests (a special-case that
// works for the oracle's inputs and corrupts the function for other callers). This mines, per task,
// a small set of SIBLING test files (same dir as the oracle) that PASS at the FIXED (C) state — the
// model's fix must keep them green. The runner adds them as a second sandboxed verifier command.
//
// Offline enrichment against trusted commits. Siblings are vetted UNDER THE SAME cwd-rw sandbox the
// runner's verifier uses, so a sibling that only passes unsandboxed can't false-regress a real run.
// Run: bun run scripts/swe-bench-passtopass.ts

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  gitToplevel,
  materializeSweWorkspace,
  restoreSweTests,
} from '../src/evals/swe-bench/workspace.ts';
import { maybeWrapSandboxArgv } from '../src/permissions/sandbox-runner.ts';

interface Task {
  id: string;
  commit: string;
  subject: string;
  kind: 'bug' | 'feature';
  testFiles: string[];
  srcFiles: string[];
  tier: 1 | 2 | 3;
  passToPass?: string[];
}

// Bound the cost: scan at most this many sibling candidates, keep at most this many that pass.
const MAX_CANDIDATES = 6;
const MAX_KEEP = 3;

// Sibling `*.test.ts` in the oracle's dir(s) that PASS once the workspace is at the FIXED (C) state.
// Materialize C^ + test patch, apply the gold src (→ C source), restore the full tests/ tree (→ C
// tests, so siblings are present), then run each candidate. A passing sibling is a valid regression
// target; a flaky/env-dependent one that fails at C is dropped.
export const computePassToPass = ({
  task,
  repoRoot,
}: { task: Task; repoRoot: string }): string[] => {
  const cwd = mkdtempSync(join(tmpdir(), 'swe-p2p-'));
  try {
    materializeSweWorkspace({ commit: task.commit, repoRoot, cwd });
    // Apply the gold src so the workspace is at C (the fixed state) — siblings pass against C's src.
    const goldSrc = Bun.spawnSync({
      cmd: ['git', '-C', repoRoot, 'diff', `${task.commit}^`, task.commit, '--', 'src/'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (!goldSrc.success)
      throw new Error(`gold src diff failed: ${goldSrc.stderr.toString().trim()}`);
    const applied = Bun.spawnSync({
      cmd: ['git', 'apply'],
      cwd,
      stdin: goldSrc.stdout,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    if (!applied.success)
      throw new Error(`gold src apply failed: ${applied.stderr.toString().trim()}`);
    restoreSweTests({ commit: task.commit, repoRoot, cwd, testPaths: task.testFiles });

    const oracle = new Set(task.testFiles);
    const dirs = new Set(task.testFiles.map((p) => dirname(p)));
    const candidates: string[] = [];
    for (const d of dirs) {
      let entries: string[];
      try {
        entries = readdirSync(join(cwd, d)).sort();
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith('.test.ts')) continue;
        const rel = join(d, f);
        if (!oracle.has(rel)) candidates.push(rel);
      }
    }

    const keep: string[] = [];
    for (const c of candidates.slice(0, MAX_CANDIDATES)) {
      if (keep.length >= MAX_KEEP) break;
      // Vet the sibling EXACTLY as the runner's verifier will run it — sandboxed cwd-rw. A sibling
      // that passes unsandboxed but fails under cwd-rw (needs network, or the masked /tmp) would
      // otherwise false-regress every model run and corrupt the score.
      let ok = false;
      try {
        const argv = maybeWrapSandboxArgv({
          profile: 'cwd-rw',
          cwd,
          innerArgv: ['sh', '-c', `bun test ${c}`],
          failClosed: true,
        });
        ok = Bun.spawnSync({ cmd: argv, cwd, stdout: 'ignore', stderr: 'ignore' }).success;
      } catch {
        ok = false;
      }
      if (ok) keep.push(c);
    }
    return keep;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const repoRoot = gitToplevel(process.cwd());
  const corpusPath = join(repoRoot, 'evals', 'swe-bench', 'corpus.json');
  const corpus: Task[] = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const dist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const t of corpus) {
    let p2p: string[];
    try {
      p2p = computePassToPass({ task: t, repoRoot });
    } catch (e) {
      process.stderr.write(`  ${t.id} ERROR ${e instanceof Error ? e.message : String(e)}\n`);
      p2p = [];
    }
    // Omit the key when empty to keep the corpus lean; the runner treats absent as no regression set.
    if (p2p.length > 0) t.passToPass = p2p;
    else delete t.passToPass;
    dist[p2p.length] = (dist[p2p.length] ?? 0) + 1;
    process.stderr.write(`  ${t.id} → ${p2p.length}${p2p.length ? ` [${p2p.join(', ')}]` : ''}\n`);
  }
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  process.stderr.write(
    `\n=== passToPass siblings per task: 0=${dist[0]} 1=${dist[1]} 2=${dist[2]} 3=${dist[3]} ` +
      `(${corpus.length - (dist[0] ?? 0)}/${corpus.length} tasks got a regression set) ===\n`,
  );
}
