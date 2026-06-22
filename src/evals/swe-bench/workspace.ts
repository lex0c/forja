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

import { existsSync, lstatSync, symlinkSync } from 'node:fs';
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

// Restore the canonical test files from `C`, discarding any agent edits to them. Robust against
// the model deleting OR rewriting the oracle: archive-from-commit re-materializes the exact test
// content regardless of the workspace's current state (re-applying the patch would break when
// the test is a modify, not an add). Call AFTER the agent runs, BEFORE the verifier.
export const restoreSweTests = ({
  commit,
  repoRoot,
  cwd,
  testPaths,
}: { commit: string; repoRoot: string; cwd: string; testPaths: string[] }): void => {
  // testPaths is the UNION of paths the commit touched, so a RENAME or DELETE leaves a path
  // absent at C — `git archive C -- <stale>` would fail and abort the whole restore. Restore
  // only the paths present at C (the oracle the verifier runs IS present at C).
  const present = testPaths.filter((p) => existsAtRef(repoRoot, commit, p));
  if (present.length === 0) {
    throw new Error(
      `swe-bench: none of the commit's test paths exist at ${commit} — cannot restore the oracle`,
    );
  }
  extractArchive(repoRoot, commit, cwd, present, `restore tests from ${commit}`);
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
