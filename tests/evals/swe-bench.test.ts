import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computePassToPass } from '../../scripts/swe-bench-passtopass.ts';
import {
  ensureIsolatedDeps,
  gitToplevel,
  manifestHash,
  materializeSweWorkspace,
  restoreSweTests,
  sweTestPaths,
} from '../../src/evals/swe-bench/workspace.ts';
import { installSweDepsFixture } from '../helpers/swe-deps-fixture.ts';

// The reference task: a small, deterministic born-with-tests fix. At C^+testPatch the gold test
// FAILS (buggy src); with the gold src it PASSES — a real fail-to-pass.
const COMMIT = '0be3c4299';
const TEST_PATH = 'tests/tools/wait-for.test.ts';

const repoRoot: string | null = (() => {
  try {
    return gitToplevel(process.cwd());
  } catch {
    return null;
  }
})();
const REPO = repoRoot ?? '';

const commitPresent = (ref: string): boolean =>
  repoRoot !== null &&
  Bun.spawnSync({
    cmd: ['git', '-C', repoRoot, 'cat-file', '-e', `${ref}^{commit}`],
    stdout: 'ignore',
    stderr: 'ignore',
  }).success;

// Needs the commit AND its parent in history. A shallow CI clone (fetch-depth 1) has neither, so
// the whole self-SWE-bench class skips there — the corpus requires full history.
const CAN_RUN = commitPresent(COMMIT) && commitPresent(`${COMMIT}^`);

if (!CAN_RUN) {
  // Visible in CI logs so a shallow clone (which skips the history-dependent tests below) is
  // not mistaken for "the self-SWE-bench path passed" — those tests were never exercised. The
  // synthetic-repo guard tests below still run regardless of history.
  console.error(
    `[swe-bench tests] commit ${COMMIT} + parent absent (shallow clone?) — history-dependent tests SKIPPED; the e2e swe path was NOT exercised here.`,
  );
}

const gitOut = (args: string[]): Buffer =>
  Bun.spawnSync({ cmd: ['git', '-C', REPO, ...args], stdout: 'pipe', stderr: 'pipe' }).stdout;

const waitForTestPasses = (cwd: string): boolean =>
  Bun.spawnSync({ cmd: ['bun', 'test', TEST_PATH], cwd, stdout: 'ignore', stderr: 'ignore' })
    .success;

describe('swe-bench workspace (reference task 0be3c4299)', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'swe-ws-'));
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test.skipIf(!CAN_RUN)('sweTestPaths returns the tests/ files the commit touched', () => {
    expect(sweTestPaths({ commit: COMMIT, repoRoot: REPO })).toContain(TEST_PATH);
  });

  test.skipIf(!CAN_RUN)(
    'materialize → git repo at C^ (history present, fix commit absent); restore brings the oracle; fails at C^ src, passes at gold',
    () => {
      const { testPaths } = materializeSweWorkspace({ commit: COMMIT, repoRoot: REPO, cwd: work });
      expect(testPaths).toContain(TEST_PATH);
      // The workspace is a git REPO at C^ (not a bare tree) — the agent gets the full pre-fix history as
      // an engineer would; the leak surfaces are NOT stripped (the corpus is curated to pre-bench commits).
      expect(existsSync(join(work, '.git'))).toBe(true);
      const log = Bun.spawnSync({
        cmd: ['git', '-C', work, 'log', '--oneline'],
        stdout: 'pipe',
        stderr: 'ignore',
      });
      expect(log.stdout.toString().trim().split('\n').length).toBeGreaterThan(1);
      // The fix commit C is UNREACHABLE — the bundle is truncated at C^, so `git show <C>` (the gold) fails.
      const cReachable = Bun.spawnSync({
        cmd: ['git', '-C', work, 'cat-file', '-e', COMMIT],
        stdout: 'ignore',
        stderr: 'ignore',
      }).success;
      expect(cReachable).toBe(false);

      // The oracle is C's NEW assertion, which lives in C and is absent here. restore re-materializes C's
      // tests/; against the buggy C^ src that oracle FAILS.
      restoreSweTests({ commit: COMMIT, repoRoot: REPO, cwd: work, testPaths });
      expect(existsSync(join(work, TEST_PATH))).toBe(true);
      expect(waitForTestPasses(work)).toBe(false);

      // Apply the gold src (what the agent must reproduce by OUTCOME) → the oracle PASSES.
      const applied = Bun.spawnSync({
        cmd: ['git', 'apply'],
        cwd: work,
        stdin: gitOut(['diff', `${COMMIT}^`, COMMIT, '--', 'src/']),
        stdout: 'ignore',
        stderr: 'pipe',
      });
      expect(applied.success).toBe(true);
      expect(waitForTestPasses(work)).toBe(true);
    },
  );

  // Anti-cheat: node_modules must NOT symlink to repoRoot/node_modules — that made `node_modules/..`
  // a back-door to the live `.git` (`git show <C>` = the gold fix), corpus.json (the srcFiles), and
  // the changelog, defeating the bench even with the network cut.
  test.skipIf(!CAN_RUN)('node_modules does not back-door to the answer repo', () => {
    materializeSweWorkspace({ commit: COMMIT, repoRoot: REPO, cwd: work });
    expect(readlinkSync(join(work, 'node_modules')).startsWith(`${REPO}/`)).toBe(false);
    // String paths (not join, which collapses `..` lexically) so the FS follows the symlink.
    expect(existsSync(`${work}/node_modules/../.git`)).toBe(false);
    expect(existsSync(`${work}/node_modules/../evals`)).toBe(false);
    expect(existsSync(`${work}/node_modules/../docs`)).toBe(false);
  });
});

// --- workspace guards on a SYNTHETIC repo (no dependency on the running checkout's history, so
//     these run even on a shallow CI clone — they cover the loud-failure guards the module
//     advertises) ---

describe('swe-bench workspace guards (synthetic repo)', () => {
  // Synthetic repos have no package.json → ensureIsolatedDeps can't build a store; supply a pre-built
  // empty one (CI has no warm ~/.cache/forja-swe-deps). See tests/helpers/swe-deps-fixture.ts.
  installSweDepsFixture();
  const temps: string[] = [];
  // Build a throwaway git repo from a list of commit snapshots ({ relpath: content }).
  const makeRepo = (snapshots: Array<Record<string, string>>): { repo: string; head: string } => {
    const repo = mkdtempSync(join(tmpdir(), 'swe-synth-'));
    temps.push(repo);
    const run = (args: string[]): void => {
      const r = Bun.spawnSync({
        cmd: ['git', '-C', repo, ...args],
        stdout: 'ignore',
        stderr: 'pipe',
      });
      if (!r.success) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    };
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', 'x@x']);
    run(['config', 'user.name', 'x']);
    snapshots.forEach((files, i) => {
      for (const [p, body] of Object.entries(files)) {
        const abs = join(repo, p);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body);
      }
      run(['add', '.']);
      run(['commit', '-qm', `c${i}`]);
    });
    const head = Bun.spawnSync({ cmd: ['git', '-C', repo, 'rev-parse', 'HEAD'], stdout: 'pipe' })
      .stdout.toString()
      .trim();
    return { repo, head };
  };
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  });

  test('sweTestPaths returns the tests/ files a fix commit touched', () => {
    const { repo, head } = makeRepo([
      { 'src/a.ts': 'export const a = 2;\n' },
      { 'src/a.ts': 'export const a = 1;\n', 'tests/a.test.ts': '// oracle\n' },
    ]);
    expect(sweTestPaths({ commit: head, repoRoot: repo })).toEqual(['tests/a.test.ts']);
  });

  test('sweTestPaths throws when the commit touches no tests/ (not a born-with-tests fix)', () => {
    const { repo, head } = makeRepo([
      { 'src/a.ts': 'export const a = 2;\n' },
      { 'src/a.ts': 'export const a = 1;\n' }, // src-only — no oracle
    ]);
    expect(() => sweTestPaths({ commit: head, repoRoot: repo })).toThrow(/touches no tests/);
  });

  test('ensureIsolatedDeps resolves node_modules outside the answer repo', () => {
    // The deps store is built once OUTSIDE repoRoot, so the workspace's node_modules symlink can't be
    // traversed (`node_modules/..`) back to the answer repo's .git/corpus/changelog — the back-door
    // the old symlink-straight-to-repoRoot/node_modules opened (git show <C> = the gold fix).
    const store = mkdtempSync(join(tmpdir(), 'swe-deps-'));
    temps.push(store);
    mkdirSync(join(store, 'node_modules'), { recursive: true }); // pretend the once-built store exists
    const { repo } = makeRepo([
      { 'src/a.ts': 'export const a = 2;\n' },
      { 'src/a.ts': 'export const a = 1;\n', 'tests/a.test.ts': '// oracle\n' },
    ]);
    process.env.FORJA_SWE_DEPS_DIR = store;
    try {
      const nm = ensureIsolatedDeps(repo);
      expect(nm).toBe(join(store, 'node_modules'));
      expect(nm.startsWith(repo)).toBe(false);
      expect(existsSync(join(nm, '..', '.git'))).toBe(false);
    } finally {
      delete process.env.FORJA_SWE_DEPS_DIR;
    }
  });

  test('manifestHash changes when the manifest changes — the stale-store rebuild trigger', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swe-mf-'));
    temps.push(repo);
    writeFileSync(join(repo, 'package.json'), '{"name":"a","version":"0.0.0"}\n');
    const base = manifestHash(repo);
    expect(manifestHash(repo)).toBe(base); // deterministic for identical content

    // A dependency update — package.json OR bun.lock changing — yields a different hash, so
    // ensureIsolatedDeps rebuilds the store instead of reusing a stale dependency graph.
    writeFileSync(join(repo, 'package.json'), '{"name":"b","version":"0.0.0"}\n');
    const afterPkg = manifestHash(repo);
    expect(afterPkg).not.toBe(base);

    writeFileSync(join(repo, 'bun.lock'), '{ "lockfileVersion": 1 }\n');
    expect(manifestHash(repo)).not.toBe(afterPkg); // bun.lock is part of the key too
  });

  test('gitToplevel throws outside a git repo', () => {
    const nongit = mkdtempSync(join(tmpdir(), 'swe-nongit-'));
    temps.push(nongit);
    expect(() => gitToplevel(nongit)).toThrow(/git toplevel/);
  });

  // Anti-cheat gate #8: restoreSweTests reverts the whole test surface, not just the commit's
  // own test files — a model can't hijack the verifier via an edited shared helper OR an added
  // bunfig.toml preload (a config absent at C must be DELETED, not just left).
  test('restoreSweTests reverts edited test helpers AND deletes a model-added runner config', () => {
    const { repo, head } = makeRepo([
      { 'src/a.ts': 'export const a = 2;\n' },
      {
        'src/a.ts': 'export const a = 1;\n',
        'tests/a.test.ts': '// canonical oracle\n',
        'tests/helper.ts': '// canonical helper\n',
      },
    ]);
    const cwd = mkdtempSync(join(tmpdir(), 'swe-restore8-'));
    temps.push(cwd);
    // Simulate a cheating agent's workspace: oracle + helper tampered, plus an ADDED bunfig
    // preload (the repo has no bunfig.toml at C, so the restore must delete it).
    mkdirSync(join(cwd, 'tests'), { recursive: true });
    writeFileSync(join(cwd, 'tests/a.test.ts'), '// TAMPERED to always pass\n');
    writeFileSync(join(cwd, 'tests/helper.ts'), '// TAMPERED helper\n');
    writeFileSync(join(cwd, 'tests/extra.ts'), '// model-ADDED helper (not at C)\n');
    writeFileSync(join(cwd, 'bunfig.toml'), '[test]\npreload = "./cheat.ts"\n');
    writeFileSync(join(cwd, '.env'), 'CHEAT=1\n');

    restoreSweTests({ commit: head, repoRoot: repo, cwd, testPaths: ['tests/a.test.ts'] });

    expect(readFileSync(join(cwd, 'tests/a.test.ts'), 'utf8')).toBe('// canonical oracle\n');
    expect(readFileSync(join(cwd, 'tests/helper.ts'), 'utf8')).toBe('// canonical helper\n');
    expect(existsSync(join(cwd, 'tests/extra.ts'))).toBe(false); // model-ADDED test file → gone (rm -rf tests/)
    expect(existsSync(join(cwd, 'bunfig.toml'))).toBe(false); // added config → deleted
    expect(existsSync(join(cwd, '.env'))).toBe(false); // bun auto-loads .env → added .env deleted
  });

  // Anti-cheat gate #9: computePassToPass mines sibling tests that pass at the FIXED state, so the
  // model's fix must keep them green — keeps the ones that pass, drops a sibling that fails.
  test('computePassToPass keeps siblings passing at C and drops a failing one', () => {
    const mk = (name: string, expected: number): string =>
      `import { test, expect } from 'bun:test';\nimport { x } from '../src/x.ts';\ntest('${name}', () => expect(x()).toBe(${expected}));\n`;
    const { repo, head } = makeRepo([
      { 'src/x.ts': 'export const x = () => 2;\n' }, // buggy parent
      {
        'src/x.ts': 'export const x = () => 1;\n', // gold fix
        'tests/x.test.ts': mk('oracle', 1),
        'tests/sib-ok.test.ts': mk('ok', 1), // passes at C → kept
        'tests/sib-bad.test.ts': mk('bad', 999), // fails at C → dropped
      },
    ]);
    mkdirSync(join(repo, 'node_modules'), { recursive: true }); // materialize guard (bun:test is builtin)
    const p2p = computePassToPass({
      task: {
        id: head.slice(0, 9),
        commit: head,
        subject: '',
        kind: 'bug',
        testFiles: ['tests/x.test.ts'],
        srcFiles: ['src/x.ts'],
        tier: 1,
      },
      repoRoot: repo,
    });
    expect(p2p).toEqual(['tests/sib-ok.test.ts']);
  });
});
