// self-SWE-bench workspace materialization (docs/TODO.md "capability signal via self-SWE-bench
// from git history"). Turns a fix commit `C` into a runnable task workspace:
//
//   1. `git archive C^` → the parent (buggy) tree, extracted with NO `.git` — anti-cheat, so
//      the agent can't `git log`/`git show` the original fix out of the workspace.
//   2. apply the `tests/**` portion of `C^..C` → the gold test exists and FAILS.
//   3. symlink `node_modules` from the repo (no per-task reinstall).
//
// The `src/**` portion of `C^..C` is the GOLD patch — deliberately NOT applied; reproducing it
// (by outcome, not by diff) is the agent's task. After the agent runs, `restoreSweTests`
// re-extracts the canonical test files from `C` so a model that edited/deleted the oracle can't
// cheat the verifier. All git work shells out to the host `git`; failures throw loudly (a
// silent miss would make a task look like a model failure).

import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface SweWorkspaceSpec {
  // The fix commit `C` (any git-resolvable ref).
  commit: string;
  // Repo to archive/diff against.
  repoRoot: string;
  // Destination workspace directory (already created).
  cwd: string;
}

// Run a git subcommand against `repoRoot`, capturing stdout. Throws on non-zero exit.
const git = (repoRoot: string, args: string[]): Buffer => {
  const r = Bun.spawnSync({
    cmd: ['git', '-C', repoRoot, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!r.success) {
    throw new Error(
      `swe-bench: 'git ${args.join(' ')}' failed in ${repoRoot} (exit ${r.exitCode}): ${r.stderr.toString().trim()}`,
    );
  }
  return r.stdout;
};

// Whether `<path>` exists in the tree of `<ref>` (so `git archive <ref> -- <path>` won't fail).
const existsAtRef = (repoRoot: string, ref: string, path: string): boolean =>
  Bun.spawnSync({
    cmd: ['git', '-C', repoRoot, 'cat-file', '-e', `${ref}:${path}`],
    stdout: 'ignore',
    stderr: 'ignore',
  }).success;

// The `tests/**` files touched by `<commit>^..<commit>` — the failing oracle for the task.
export const sweTestPaths = ({
  commit,
  repoRoot,
}: { commit: string; repoRoot: string }): string[] => {
  // `-z` → NUL-separated, UNquoted paths: robust to non-ASCII names. Without it core.quotepath
  // octal-escapes + double-quotes them, and that literal then fails `git archive -- <path>`.
  const out = git(repoRoot, [
    'diff',
    '--name-only',
    '-z',
    `${commit}^`,
    commit,
    '--',
    'tests/',
  ]).toString();
  const paths = out.split('\0').filter((p) => p.length > 0);
  if (paths.length === 0) {
    throw new Error(
      `swe-bench: commit ${commit} touches no tests/ files — not a born-with-tests fix, can't use as a task`,
    );
  }
  return paths;
};

// Pipe a git-produced patch/archive stream into a consumer command run with `cwd`. Bun has no
// in-process pipe for spawnSync, so we materialize the producer's stdout and feed it as the
// consumer's stdin — fine for the small patches/archives a single commit produces.
const pipeInto = (producer: Buffer, consumer: string[], cwd: string, label: string): void => {
  const r = Bun.spawnSync({
    cmd: consumer,
    cwd,
    stdin: producer,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!r.success) {
    throw new Error(
      `swe-bench: ${label} failed in ${cwd} (exit ${r.exitCode}): ${r.stderr.toString().trim()}`,
    );
  }
};

// Extract `git archive <ref> [-- <paths>]` into `cwd` (overwriting existing files).
const extractArchive = (
  repoRoot: string,
  ref: string,
  cwd: string,
  paths: string[],
  label: string,
): void => {
  const archive = git(repoRoot, ['archive', ref, ...(paths.length > 0 ? ['--', ...paths] : [])]);
  pipeInto(archive, ['tar', '-x', '-C', cwd], cwd, label);
};

// Materialize the task workspace: parent tree (no .git) + failing test patch + node_modules.
// Returns the test paths so the caller can scope the verifier and the post-run restore.
export const materializeSweWorkspace = ({
  commit,
  repoRoot,
  cwd,
}: SweWorkspaceSpec): { testPaths: string[] } => {
  const testPaths = sweTestPaths({ commit, repoRoot });

  // 1. parent (buggy) tree, no .git.
  extractArchive(repoRoot, `${commit}^`, cwd, [], `git archive ${commit}^`);

  // 1b. Strip the LEAK SURFACE from the workspace. `git archive` ships the whole tree, including
  //     docs/BACKLOG.md (a verbose per-fix changelog the model can read locally to glean approach)
  //     and evals/swe-bench/ (corpus.json carries each task's subject + srcFiles — the fix spec).
  //     The agent must work from the failing test alone, so these never reach it. (docs/spec + the
  //     rest stay — they're the codebase's own docs, not a fix changelog/answer key.)
  for (const leak of ['docs/BACKLOG.md', 'docs/TODO.md', 'evals/swe-bench']) {
    rmSync(join(cwd, leak), { recursive: true, force: true });
  }

  // 2. apply the tests/** patch so the gold test exists and fails. `git apply` runs with the
  //    workspace as cwd; it does not need the workspace to be a git repo.
  const testPatch = git(repoRoot, ['diff', `${commit}^`, commit, '--', 'tests/']);
  pipeInto(testPatch, ['git', 'apply'], cwd, `apply test patch for ${commit}`);

  // 3. symlink node_modules (don't reinstall per task). Assert the target exists first — a
  //    dangling link surfaces as opaque module-resolution errors in the verifier, not a clear
  //    "install deps".
  const target = join(repoRoot, 'node_modules');
  if (!existsSync(target)) {
    throw new Error(
      `swe-bench: ${target} does not exist — run \`bun install\` in the repo before materializing a task`,
    );
  }
  const nm = join(cwd, 'node_modules');
  // lstatSync (not existsSync) so an EXISTING link — even a dangling one — is detected;
  // existsSync follows the link and would miss a dangling one, then symlinkSync throws EEXIST.
  let nmExists = true;
  try {
    lstatSync(nm);
  } catch {
    nmExists = false;
  }
  if (!nmExists) symlinkSync(target, nm);

  return { testPaths };
};

// Config the test runner reads — a model can hijack the verifier through any of these without
// touching a test FILE, so they're part of the restored surface (anti-cheat gate #8). `.env*` is
// included because bun AUTO-LOADS .env / .env.test / .env.local from cwd at `bun test` startup, so
// a model-written `.env` (the repo tracks none) would inject env the oracle reads.
const TEST_RUNNER_CONFIG = [
  'bunfig.toml',
  'tsconfig.json',
  'package.json',
  'bun.lock',
  '.env',
  '.env.test',
  '.env.local',
] as const;

// Restore the canonical TEST SURFACE from `C` — the whole `tests/` tree plus the test-runner
// config — discarding any agent edits, so the verifier runs the gold oracle and only the model's
// `src/` changes can make it pass. Restoring only the commit's own test files (the naive version)
// left the model free to cheat via a shared test helper the oracle imports, a `bunfig.toml`
// `[test].preload`, a `tsconfig.json` path remap, or `package.json` — none of which the commit
// touched. archive-from-commit re-materializes exact content over whatever the model wrote (and is
// robust to the oracle being a modify/rename/delete, where re-applying the patch would break).
// Call AFTER the agent runs, BEFORE the verifier.
export const restoreSweTests = ({
  commit,
  repoRoot,
  cwd,
  testPaths,
}: { commit: string; repoRoot: string; cwd: string; testPaths: string[] }): void => {
  // Fail loudly if the oracle itself is gone at C (a degenerate task) — nothing to verify against.
  if (!testPaths.some((p) => existsAtRef(repoRoot, commit, p))) {
    throw new Error(`swe-bench: none of the oracle test paths exist at ${commit} — cannot restore`);
  }
  // For each config file: restore C's version if it existed at C, else DELETE it (the model ADDED
  // it — e.g. a `bunfig.toml` preload in a repo that has none — and `git archive` can't delete).
  const presentAtC: string[] = [];
  for (const f of TEST_RUNNER_CONFIG) {
    if (existsAtRef(repoRoot, commit, f)) presentAtC.push(f);
    else rmSync(join(cwd, f), { force: true });
  }
  // rm the whole tests/ tree FIRST so a model-ADDED file under tests/ doesn't survive — `tar -x`
  // overwrites + adds but never DELETES, so without this the restored tests/ ⊇ C (not == C). After
  // the rm, the archive re-materializes tests/ exactly as it is at C; the config present at C is
  // overwritten back to canonical (config absent at C was already deleted above).
  rmSync(join(cwd, 'tests'), { recursive: true, force: true });
  extractArchive(
    repoRoot,
    commit,
    cwd,
    ['tests/', ...presentAtC],
    `restore test surface from ${commit}`,
  );
};

// The git toplevel of `from` — the default `repoRoot` when a swe case omits it (the corpus is
// the running checkout's own history).
export const gitToplevel = (from: string): string => {
  const r = Bun.spawnSync({
    cmd: ['git', '-C', from, 'rev-parse', '--show-toplevel'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!r.success) {
    throw new Error(
      `swe-bench: cannot resolve git toplevel from ${from} (exit ${r.exitCode}): ${r.stderr.toString().trim()}`,
    );
  }
  return r.stdout.toString().trim();
};
