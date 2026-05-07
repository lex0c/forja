import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeGitContext } from '../../src/cli/git-context.ts';

// End-to-end probe tests against real `git` invocations in a
// tmpdir. Bun.spawnSync calls the system `git`; tests skip when
// git is unavailable rather than mock it (the value of testing
// against the real binary is exactly to catch flag-version drift
// across git releases).

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forja-git-ctx-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const initRepo = (cwd: string): boolean => {
  const r = Bun.spawnSync({
    cmd: ['git', 'init', '--initial-branch=main', cwd],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (r.exitCode !== 0) return false;
  // Identity needs to be set for `git commit` to succeed in CI
  // environments without a global config. Set it locally so the
  // test stays self-contained.
  Bun.spawnSync({
    cmd: ['git', '-C', cwd, 'config', 'user.email', 'test@example.com'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  Bun.spawnSync({
    cmd: ['git', '-C', cwd, 'config', 'user.name', 'Test'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return true;
};

const commit = (cwd: string, file: string, content: string, message: string): void => {
  writeFileSync(join(cwd, file), content);
  Bun.spawnSync({
    cmd: ['git', '-C', cwd, 'add', file],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  Bun.spawnSync({
    cmd: ['git', '-C', cwd, 'commit', '-m', message],
    stdout: 'ignore',
    stderr: 'ignore',
  });
};

describe('probeGitContext', () => {
  test('returns null for a non-git directory', () => {
    expect(probeGitContext(dir)).toBeNull();
  });

  test('returns branch + clean status + recent commits in a fresh repo', () => {
    if (!initRepo(dir)) return;
    commit(dir, 'a.txt', 'a', 'first');
    commit(dir, 'b.txt', 'b', 'second');
    const ctx = probeGitContext(dir);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.branch).toBe('main');
    expect(ctx.modified).toBe(0);
    expect(ctx.untracked).toBe(0);
    expect(ctx.recentCommits.length).toBe(2);
    // `--oneline` format: `<short_sha> <subject>`. We don't pin
    // the sha (it's hash-derived) but the subject must round-trip.
    expect(ctx.recentCommits[0]).toContain('second');
    expect(ctx.recentCommits[1]).toContain('first');
  });

  test('caps recent commits at 3 even when the repo has more', () => {
    if (!initRepo(dir)) return;
    for (let i = 1; i <= 5; i++) {
      commit(dir, `f${i}.txt`, `${i}`, `commit ${i}`);
    }
    const ctx = probeGitContext(dir);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.recentCommits.length).toBe(3);
    // Most recent first.
    expect(ctx.recentCommits[0]).toContain('commit 5');
    expect(ctx.recentCommits[2]).toContain('commit 3');
  });

  test('counts modified and untracked separately', () => {
    if (!initRepo(dir)) return;
    commit(dir, 'tracked.txt', 'original', 'baseline');
    // Modify the tracked file.
    writeFileSync(join(dir, 'tracked.txt'), 'modified');
    // Add an untracked file.
    writeFileSync(join(dir, 'new.txt'), 'untracked');
    const ctx = probeGitContext(dir);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.modified).toBe(1);
    expect(ctx.untracked).toBe(1);
  });

  test('omits ahead/behind when no upstream is configured', () => {
    if (!initRepo(dir)) return;
    commit(dir, 'a.txt', 'a', 'init');
    const ctx = probeGitContext(dir);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    // Fresh repo with no remote → no `@{u}` → ahead/behind absent.
    expect(ctx.ahead).toBeUndefined();
    expect(ctx.behind).toBeUndefined();
  });

  test('returns empty recentCommits in a repo with no commits', () => {
    if (!initRepo(dir)) return;
    const ctx = probeGitContext(dir);
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.recentCommits).toEqual([]);
  });
});
