// self-SWE-bench corpus miner (docs/TODO.md "capability signal via self-SWE-bench from git
// history", Phase 2). Forja's "born with tests" rule means every fix commit ships a src/** change
// + a tests/** change, so the git history IS a ready-made task corpus. This scans a recent window
// for such commits, VALIDATES each is a real fail-to-pass (the gold test FAILS at the parent +
// test patch, PASSES once the gold src is applied — dropping refactors / flaky / already-passing),
// tiers by diff size, and emits a frozen corpus. Mining is OFFLINE validation against trusted
// historical commits, so the verifier here is NOT sandboxed (that gate is for running untrusted
// models — see the corpus runner).
//
// Run: `bun run scripts/swe-bench-mine.ts ['<since>'] [--limit N]` → writes evals/swe-bench/corpus.json.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitToplevel, materializeSweWorkspace } from '../src/evals/swe-bench/workspace.ts';

export interface Candidate {
  sha: string;
  subject: string;
  srcFiles: string[];
  testFiles: string[];
  srcLines: number;
}

export interface Task {
  id: string;
  commit: string;
  subject: string;
  kind: 'bug' | 'feature';
  testFiles: string[];
  srcFiles: string[];
  tier: 1 | 2 | 3;
  // Computed by `swe-bench-passtopass.ts` (the anti-cheat #9 sibling tests that pass at the fixed
  // state C), NOT by this miner. Absent on a fresh mine; preserved across re-mines by
  // `preservePassToPass` so a mine-only re-run doesn't drop it.
  passToPass?: string[];
}

export interface Dropped {
  sha: string;
  subject: string;
  reason: string;
}

// Run git against repoRoot capturing stdout; throw on failure.
const git = (repoRoot: string, args: string[]): string => {
  const r = Bun.spawnSync({
    cmd: ['git', '-C', repoRoot, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!r.success) {
    throw new Error(
      `swe-bench-mine: 'git ${args.join(' ')}' failed (exit ${r.exitCode}): ${r.stderr.toString().trim()}`,
    );
  }
  return r.stdout.toString();
};

// Whether `<sha>` has a parent (a root commit can't be a task — nothing to diff against).
const hasParent = (repoRoot: string, sha: string): boolean =>
  Bun.spawnSync({
    cmd: ['git', '-C', repoRoot, 'rev-parse', '--verify', '-q', `${sha}^`],
    stdout: 'ignore',
    stderr: 'ignore',
  }).success;

// Files under `prefix` touched by `<sha>^..<sha>` (NUL-safe → non-ASCII names survive).
const filesTouched = (repoRoot: string, sha: string, prefix: string): string[] =>
  git(repoRoot, ['diff', '--name-only', '-z', `${sha}^`, sha, '--', prefix])
    .split('\0')
    .filter((p) => p.length > 0);

// Added + deleted lines under `prefix` in `<sha>^..<sha>` (binary files contribute 0).
const linesChanged = (repoRoot: string, sha: string, prefix: string): number => {
  let total = 0;
  for (const line of git(repoRoot, ['diff', '--numstat', `${sha}^`, sha, '--', prefix]).split(
    '\n',
  )) {
    if (line.length === 0) continue;
    const [add, del] = line.split('\t');
    const a = Number.parseInt(add ?? '', 10);
    const d = Number.parseInt(del ?? '', 10);
    if (Number.isFinite(a)) total += a;
    if (Number.isFinite(d)) total += d;
  }
  return total;
};

// Commits in the window that touch BOTH src/** and tests/** — the born-with-tests fix shape.
export const candidateCommits = ({
  repoRoot,
  since,
  limit,
}: { repoRoot: string; since: string; limit?: number }): Candidate[] => {
  // `%x00` is a NUL byte: `<sha>\0<subject>\0` per commit (git appends a newline between commits),
  // so a subject can't be confused for a sha even with odd characters.
  const tokens = git(repoRoot, [
    'log',
    '--no-merges',
    `--since=${since}`,
    '--format=%H%x00%s%x00',
  ]).split('\0');
  const out: Candidate[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const sha = tokens[i]?.trim(); // trim strips the inter-commit newline glued onto the next sha
    const subject = tokens[i + 1] ?? '';
    if (sha === undefined || sha.length === 0 || !hasParent(repoRoot, sha)) continue;
    const srcFiles = filesTouched(repoRoot, sha, 'src/');
    const testFiles = filesTouched(repoRoot, sha, 'tests/');
    if (srcFiles.length === 0 || testFiles.length === 0) continue;
    out.push({ sha, subject, srcFiles, testFiles, srcLines: linesChanged(repoRoot, sha, 'src/') });
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
};

// Difficulty tier from the src diff size: 1 trivial, 2 multi-location, 3 multi-file. A capability
// score reported per-tier reflects a CEILING, not a uniform pass-rate (docs/TODO.md).
export const tierOf = ({
  srcFiles,
  srcLines,
}: { srcFiles: string[]; srcLines: number }): 1 | 2 | 3 => {
  if (srcFiles.length <= 1 && srcLines <= 30) return 1;
  if (srcFiles.length <= 3) return 2;
  return 3;
};

// bug/feature label from the conventional-commit type: `feat*` is a feature, everything else (fix,
// sec, refactor, …) a bug. The corpus carries this for per-kind capability comparison
// (swe-bench-run.ts logs + the results CSV key off `t.kind`); curation can override an edge case.
export const kindOf = (subject: string): 'bug' | 'feature' =>
  subject.startsWith('feat') ? 'feature' : 'bug';

const runBunTest = (cwd: string, testFiles: string[]): boolean =>
  Bun.spawnSync({ cmd: ['bun', 'test', ...testFiles], cwd, stdout: 'ignore', stderr: 'ignore' })
    .success;

// The corpus-trust filter: materialize the parent + test patch (the oracle must FAIL), then apply
// the gold src (the oracle must PASS). Only a genuine FAIL→PASS is a usable task — refactors, flaky
// tests, dep-drift, and tests that already passed are dropped with a concrete reason.
export const validateFailToPass = ({
  commit,
  repoRoot,
  testFiles,
}: { commit: string; repoRoot: string; testFiles: string[] }): { ok: boolean; reason?: string } => {
  const cwd = mkdtempSync(join(tmpdir(), 'swe-mine-'));
  try {
    materializeSweWorkspace({ commit, repoRoot, cwd });
    if (runBunTest(cwd, testFiles)) {
      return { ok: false, reason: 'test passes at parent (not a fail-to-pass)' };
    }
    const goldSrc = Bun.spawnSync({
      cmd: ['git', '-C', repoRoot, 'diff', `${commit}^`, commit, '--', 'src/'],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (!goldSrc.success) {
      return {
        ok: false,
        reason: `git diff (gold src) failed: ${goldSrc.stderr.toString().trim()}`,
      };
    }
    const applied = Bun.spawnSync({
      cmd: ['git', 'apply'],
      cwd,
      stdin: goldSrc.stdout,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    if (!applied.success) {
      return {
        ok: false,
        reason: `gold src patch did not apply: ${applied.stderr.toString().trim()}`,
      };
    }
    if (!runBunTest(cwd, testFiles)) {
      return {
        ok: false,
        reason: 'test still fails with gold src (dep drift / flaky / non-deterministic)',
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

// Scan → validate → split into the frozen corpus + the dropped log (with reasons).
export const mineCorpus = ({
  repoRoot,
  since,
  limit,
}: { repoRoot: string; since: string; limit?: number }): { valid: Task[]; dropped: Dropped[] } => {
  const valid: Task[] = [];
  const dropped: Dropped[] = [];
  for (const c of candidateCommits({
    repoRoot,
    since,
    ...(limit !== undefined ? { limit } : {}),
  })) {
    const v = validateFailToPass({ commit: c.sha, repoRoot, testFiles: c.testFiles });
    if (v.ok) {
      valid.push({
        id: c.sha.slice(0, 9),
        commit: c.sha,
        subject: c.subject,
        kind: kindOf(c.subject),
        testFiles: c.testFiles,
        srcFiles: c.srcFiles,
        tier: tierOf(c),
      });
    } else {
      dropped.push({ sha: c.sha, subject: c.subject, reason: v.reason ?? 'unknown' });
    }
  }
  return { valid, dropped };
};

// Carry `passToPass` forward from the existing corpus onto a freshly-mined list, matched by full
// commit SHA. Re-mining regenerates the mechanical fields (id/subject/kind/tier/files), but
// `passToPass` (anti-cheat #9) is COMPUTED by a separate script — `swe-bench-passtopass.ts`, which
// vets the sibling tests that pass at the fixed state C — not by this miner. Without carrying it
// forward, a mine-only re-run would silently wipe the #9 gate; the authoritative refresh is re-running
// passtopass. A surviving task keeps its set; a new task stays bare; a dropped commit is not carried.
// Unreadable/absent prior → emit the fresh mine untouched.
export const preservePassToPass = (
  tasks: Task[],
  existingCorpusJson: string | undefined,
): Task[] => {
  if (existingCorpusJson === undefined) return tasks;
  let prior: unknown;
  try {
    prior = JSON.parse(existingCorpusJson);
  } catch {
    return tasks;
  }
  if (!Array.isArray(prior)) return tasks;
  const byCommit = new Map<string, string[]>();
  for (const t of prior as Array<{ commit?: unknown; passToPass?: unknown }>) {
    if (typeof t?.commit === 'string' && Array.isArray(t.passToPass) && t.passToPass.length > 0) {
      byCommit.set(t.commit, t.passToPass as string[]);
    }
  }
  return tasks.map((t) => {
    const carried = byCommit.get(t.commit);
    return carried ? { ...t, passToPass: carried } : t;
  });
};

if (import.meta.main) {
  const repoRoot = gitToplevel(process.cwd());
  const argv = process.argv.slice(2);
  let since = '3 months ago';
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      limit = Number.parseInt(argv[++i] ?? '', 10);
    } else {
      since = argv[i] ?? since;
    }
  }
  process.stderr.write(
    `swe-bench-mine: scanning '${since}'${limit ? ` (limit ${limit})` : ''}...\n`,
  );
  const { valid, dropped } = mineCorpus({
    repoRoot,
    since,
    ...(limit !== undefined ? { limit } : {}),
  });
  const tiers = { 1: 0, 2: 0, 3: 0 };
  for (const t of valid) tiers[t.tier]++;
  const sorted = [...valid].sort((a, b) => a.id.localeCompare(b.id));
  const corpusDir = join(repoRoot, 'evals', 'swe-bench');
  mkdirSync(corpusDir, { recursive: true });
  const corpusPath = join(corpusDir, 'corpus.json');
  // Carry passToPass (computed by swe-bench-passtopass.ts) forward from the prior corpus so a
  // mine-only re-run doesn't wipe the #9 gate; re-run passtopass to refresh it.
  const merged = preservePassToPass(
    sorted,
    existsSync(corpusPath) ? readFileSync(corpusPath, 'utf8') : undefined,
  );
  const carried = merged.filter((t) => t.passToPass !== undefined).length;
  writeFileSync(corpusPath, `${JSON.stringify(merged, null, 2)}\n`);
  process.stderr.write('\n=== swe-bench corpus ===\n');
  process.stderr.write(
    `candidates: ${valid.length + dropped.length}, valid: ${valid.length}, dropped: ${dropped.length}\n`,
  );
  process.stderr.write(`tiers: 1=${tiers[1]} 2=${tiers[2]} 3=${tiers[3]}\n`);
  for (const d of dropped) {
    process.stderr.write(`  DROP ${d.sha.slice(0, 9)} ${d.subject.slice(0, 50)} — ${d.reason}\n`);
  }
  process.stderr.write(
    `wrote ${merged.length} task(s) (${carried} with passToPass carried over; re-run swe-bench-passtopass.ts to refresh) → evals/swe-bench/corpus.json\n`,
  );
}
