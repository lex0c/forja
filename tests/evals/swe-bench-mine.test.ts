import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Task,
  candidateCommits,
  kindOf,
  preserveCuration,
  tierOf,
  validateFailToPass,
} from '../../scripts/swe-bench-mine.ts';

// All tests build a throwaway git repo (no dependency on the running checkout's history → they run
// on a shallow CI clone too). bun:test is a builtin, so a synthetic oracle needs no real deps; an
// EMPTY node_modules/ in the working tree satisfies materializeSweWorkspace's guard + symlink.

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const makeRepo = (snapshots: Array<Record<string, string>>): { repo: string; head: string } => {
  const repo = mkdtempSync(join(tmpdir(), 'swe-mine-synth-'));
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

const ORACLE = `import { test, expect } from 'bun:test';\nimport { answer } from '../src/answer.ts';\ntest('answer is 1', () => {\n  expect(answer()).toBe(1);\n});\n`;

describe('candidateCommits', () => {
  test('keeps only commits touching BOTH src/** and tests/** (and skips the root)', () => {
    const { repo } = makeRepo([
      { 'src/a.ts': 'export const a = 0;\n' }, // c0: root (no parent) → skipped
      { 'src/a.ts': 'export const a = 1;\n', 'tests/a.test.ts': '// t\n' }, // c1: src+tests → candidate
      { 'docs/x.md': '# d\n' }, // c2: docs-only → no
      { 'tests/b.test.ts': '// t2\n' }, // c3: tests-only → no
      { 'src/c.ts': 'export const c = 1;\n' }, // c4: src-only → no
    ]);
    const cands = candidateCommits({ repoRoot: repo, since: '50 years ago' });
    expect(cands.map((c) => c.subject)).toEqual(['c1']);
    expect(cands[0]?.srcFiles).toEqual(['src/a.ts']);
    expect(cands[0]?.testFiles).toEqual(['tests/a.test.ts']);
    expect(cands[0]?.srcLines).toBeGreaterThan(0);
  });

  test('respects the limit', () => {
    const { repo } = makeRepo([
      { 'src/a.ts': 'a\n' },
      { 'src/a.ts': 'b\n', 'tests/a.test.ts': '// t\n' },
      { 'src/a.ts': 'c\n', 'tests/a.test.ts': '// t2\n' },
    ]);
    expect(candidateCommits({ repoRoot: repo, since: '50 years ago', limit: 1 })).toHaveLength(1);
  });
});

describe('tierOf', () => {
  test('1 = single small src file', () => {
    expect(tierOf({ srcFiles: ['a.ts'], srcLines: 10 })).toBe(1);
  });
  test('2 = one big file or up to 3 files', () => {
    expect(tierOf({ srcFiles: ['a.ts'], srcLines: 50 })).toBe(2); // 1 file but > 30 lines
    expect(tierOf({ srcFiles: ['a.ts', 'b.ts', 'c.ts'], srcLines: 200 })).toBe(2);
  });
  test('3 = more than 3 files', () => {
    expect(tierOf({ srcFiles: ['a', 'b', 'c', 'd'], srcLines: 5 })).toBe(3);
  });
});

describe('kindOf', () => {
  test('feat* → feature', () => {
    expect(kindOf('feat(tools): refuse binary files in read_file')).toBe('feature');
    expect(kindOf('feat: add a thing')).toBe('feature');
  });
  test('fix / sec / non-conventional → bug', () => {
    expect(kindOf('fix(permissions): empty-string fs path treated as omitted')).toBe('bug');
    expect(kindOf('sec(sandbox): close the cp-to-tmp bypass')).toBe('bug');
    expect(kindOf('refactor(harness): extract the loop')).toBe('bug');
    expect(kindOf('Merge pull request #1 from x/y')).toBe('bug');
  });
});

describe('preserveCuration', () => {
  const mk = (commit: string, passToPass?: string[]): Task => ({
    id: commit.slice(0, 3),
    commit,
    subject: 'fix: x',
    kind: 'bug',
    testFiles: [],
    srcFiles: [],
    tier: 1,
    ...(passToPass ? { passToPass } : {}),
  });

  test('carries curated passToPass onto a re-mined task by commit; new tasks stay bare', () => {
    const fresh = [mk('aaaaaa'), mk('bbbbbb')];
    const prior = JSON.stringify([
      { commit: 'aaaaaa', passToPass: ['tests/sibling.test.ts'] }, // survives → carried
      { commit: 'zzzzzz', passToPass: ['tests/gone.test.ts'] }, // dropped commit → ignored
    ]);
    const merged = preserveCuration(fresh, prior);
    expect(merged[0]?.passToPass).toEqual(['tests/sibling.test.ts']);
    expect(merged[1]?.passToPass).toBeUndefined();
  });

  test('absent or unreadable prior corpus → returns the fresh mine unchanged', () => {
    const fresh = [mk('aaaaaa', ['tests/a.test.ts'])];
    expect(preserveCuration(fresh, undefined)).toEqual(fresh);
    expect(preserveCuration(fresh, '{ not json')).toEqual(fresh);
  });
});

describe('validateFailToPass', () => {
  test('ok:true on a synthetic fail-to-pass (oracle fails at parent, passes with gold src)', () => {
    const { repo, head } = makeRepo([
      // parent: buggy src, no oracle yet
      { 'src/answer.ts': 'export const answer = (): number => 2;\n' },
      // C: add the oracle + fix the src so it goes fail → pass
      {
        'src/answer.ts': 'export const answer = (): number => 1;\n',
        'tests/answer.test.ts': ORACLE,
      },
    ]);
    mkdirSync(join(repo, 'node_modules'), { recursive: true }); // empty, uncommitted → guard passes
    expect(
      validateFailToPass({ commit: head, repoRoot: repo, testFiles: ['tests/answer.test.ts'] }),
    ).toEqual({ ok: true });
  });

  test('ok:false when the oracle already passes at the parent (not a real fix)', () => {
    const { repo, head } = makeRepo([
      // parent: correct src AND the oracle already present + passing
      {
        'src/answer.ts': 'export const answer = (): number => 1;\n',
        'tests/answer.test.ts': ORACLE,
      },
      // C: touches src + tests but the oracle passed before too (refactor + a redundant assertion)
      {
        'src/answer.ts': 'export const answer = (): number => 1; // refactor\n',
        'tests/answer.test.ts': `${ORACLE}test('still 1', () => {\n  expect(answer()).toBe(1);\n});\n`,
      },
    ]);
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const v = validateFailToPass({
      commit: head,
      repoRoot: repo,
      testFiles: ['tests/answer.test.ts'],
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('passes at parent');
  });
});
