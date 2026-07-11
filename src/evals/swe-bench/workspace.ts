// self-SWE-bench workspace materialization (docs/BENCHMARK.md). Turns a fix commit `C` into a runnable
// task workspace:
//
//   1. Clone a git BUNDLE of `C^`'s history into the workspace — the agent gets the full pre-fix repo
//      (history, blame, BACKLOG, existing tests) the way an engineer sees it before the fix. The bundle
//      is truncated at `C^`, so `C` and everything after it are unreachable: `git show C` fails. The
//      anti-cheat is ABSENCE-of-the-answer, NOT absence-of-`.git` — the agent CAN `git log` the pre-fix
//      history, which is legitimate context.
//   2. point `node_modules` at an ISOLATED deps store OUTSIDE the answer repo (ensureIsolatedDeps), so a
//      model can't walk `node_modules/..` back into the repo's `.git` / corpus / changelog to recover the
//      gold.
//
// The agent gets a curated TICKET, not the oracle test — C's `tests/**` is WITHHELD at materialize time;
// the `src/**` of `C^..C` is the GOLD patch, deliberately NOT applied (reproducing its OUTCOME, not its
// diff, is the task). After the agent runs, `restoreSweTests` materializes the canonical `tests/**` from
// `C` so the oracle exists ONLY at verify time — a model that edited/deleted a test in C^ can't cheat the
// verifier. All git work shells out to the host `git`; failures throw loudly (a silent miss would make a
// task look like a model failure).

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
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
}: {
  commit: string;
  repoRoot: string;
}): string[] => {
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

// A node_modules store OUTSIDE the answer repo. The workspace's node_modules used to symlink
// straight to `repoRoot/node_modules`, so a model could read `node_modules/../.git` (`git show <C>`
// = the gold fix), `node_modules/../evals/swe-bench/corpus.json` (the task's srcFiles), or the
// changelog — defeating the anti-cheat even with the network cut. Pointing node_modules at an
// isolated store (built once from the repo's manifest + lockfile, offline from the warm global bun
// cache) means `node_modules/..` reaches only the store (package.json/bun.lock/node_modules).
// The REAL user home (userInfo, not $HOME) so the store is stable across eval cases that override
// HOME to a temp dir — they reuse the once-built deps instead of triggering an offline bun install.
// $FORJA_SWE_DEPS_DIR overrides the location (tests point it at a fixture store; CI can pin it).
const isolatedDepsDir = (): string =>
  process.env.FORJA_SWE_DEPS_DIR ?? join(userInfo().homedir, '.cache', 'forja-swe-deps');

// A content hash of the repo's package.json + bun.lock — the store's cache key. When a dependency
// update changes either file the hash changes and the store is rebuilt (see ensureIsolatedDeps), so a
// workspace never symlinks a stale dependency graph. Empty (no manifest) for a synthetic test repo.
export const manifestHash = (repoRoot: string): string => {
  const h = createHash('sha256');
  for (const f of ['package.json', 'bun.lock']) {
    const src = join(repoRoot, f);
    if (existsSync(src)) h.update(readFileSync(src));
  }
  return h.digest('hex');
};

export const ensureIsolatedDeps = (repoRoot: string): string => {
  const root = isolatedDepsDir();
  const nm = join(root, 'node_modules');
  const hashFile = join(root, '.manifest-hash');
  const want = manifestHash(repoRoot);
  if (existsSync(nm)) {
    // No manifest in the repo (a synthetic test workspace) → nothing can go stale; reuse the store.
    // Otherwise reuse ONLY if it was built from the SAME package.json + bun.lock. A changed manifest
    // (dep update) or a store predating this check (no recorded hash) is STALE → rebuild, so the old
    // "reuse unconditionally" behaviour (stale deps until the cache was deleted by hand) can't recur.
    if (!existsSync(join(repoRoot, 'package.json'))) return nm;
    if (existsSync(hashFile) && readFileSync(hashFile, 'utf8') === want) return nm;
  }
  rmSync(root, { recursive: true, force: true }); // wipe a stale/partial store before rebuilding
  mkdirSync(root, { recursive: true });
  for (const f of ['package.json', 'bun.lock']) {
    const src = join(repoRoot, f);
    if (existsSync(src)) copyFileSync(src, join(root, f));
  }
  // Reproduce the repo's deps from its lockfile, offline (the repo already installed → the global
  // bun cache is warm). The store holds ONLY the manifest + lockfile + node_modules — no repo.
  const r = Bun.spawnSync({
    cmd: ['bun', 'install', '--frozen-lockfile'],
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (!r.success || !existsSync(nm)) {
    throw new Error(
      `swe-bench: could not build isolated deps at ${root} (bun install --frozen-lockfile): ${r.stderr.toString().trim()}`,
    );
  }
  writeFileSync(hashFile, want); // record the manifest this store was built from
  return nm;
};

// Materialize the task workspace as a git repo truncated at the parent C^ (full pre-fix project context
// via the real history, the fix commit C and everything after it absent) + node_modules symlink.
// Returns the test paths so the caller can scope the verifier and the post-run restore.
export const materializeSweWorkspace = ({
  commit,
  repoRoot,
  cwd,
}: SweWorkspaceSpec): { testPaths: string[] } => {
  const testPaths = sweTestPaths({ commit, repoRoot });

  // 1. Materialize the workspace as a git repo TRUNCATED at the parent C^. A bundle of C^'s history (C
  //    and everything after it are unreachable from C^, so they are absent from the bundle — `git show
  //    <C>` fails, the fix is genuinely gone) is cloned into cwd. The agent gets the FULL pre-existing
  //    project at C^ — its history, blame, BACKLOG, every file — exactly as an engineer sees the repo
  //    before the fix; that is legitimate context, not the answer. The oracle (C's NEW test assertion)
  //    lives in C and is naturally absent (the C^ test file is its pre-fix form); the verifier gets the
  //    real oracle from restoreSweTests. The corpus is curated to commits that PREDATE this bench
  //    (evals/swe-bench, created 2026-06-22), so evals/swe-bench is never in C^'s tree — no
  //    self-referential answer-key leak. A throwaway TAG (NOT a branch) names C^ so the bundle is
  //    non-empty + clonable: it lives OUTSIDE refs/heads so it can't clobber a developer's branch. It is
  //    named with the PARENT SHA (C^), NEVER the gold commit C — the clone RETAINS the tag in the
  //    workspace's .git, so a C-named tag would let `git tag` there reveal C, the withheld fix commit's
  //    SHA (an answer-key identifier that could contaminate via model memorization or any future egress
  //    path, even though the commit object itself is absent). C^ is the workspace's own HEAD, already
  //    known to the agent, so its SHA in the name leaks nothing. The tag is deleted from the real repo
  //    right after the bundle, and from the workspace clone right after checkout (it was only the clone
  //    handle).
  const parentSha = git(repoRoot, ['rev-parse', `${commit}^`])
    .toString()
    .trim();
  const tag = `swe-bench-bundle-${parentSha}`;
  const bundle = `${cwd}.bundle`;
  git(repoRoot, ['tag', '-f', tag, parentSha]);
  try {
    git(repoRoot, ['bundle', 'create', bundle, `refs/tags/${tag}`]);
  } finally {
    git(repoRoot, ['tag', '-d', tag]);
  }
  git(repoRoot, ['clone', '--quiet', '--branch', tag, bundle, cwd]);
  rmSync(bundle, { force: true });
  git(cwd, ['tag', '-d', tag]); // the tag was only the clone handle — drop it so the workspace keeps no ref
  git(cwd, ['remote', 'remove', 'origin']); // drop the dangling pointer to the (now deleted) bundle

  // 3. symlink node_modules to the ISOLATED deps store, NOT repoRoot/node_modules — an absolute
  //    symlink to the repo's node_modules made `node_modules/..` a back-door to the live `.git`
  //    (`git show <C>` = the gold fix), corpus.json (the srcFiles), and the changelog, defeating
  //    the anti-cheat even with the network cut. The store's parent holds only deps.
  const target = ensureIsolatedDeps(repoRoot);
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
}: {
  commit: string;
  repoRoot: string;
  cwd: string;
  testPaths: string[];
}): void => {
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
