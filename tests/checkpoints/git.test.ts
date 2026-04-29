import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteSessionRef,
  diff,
  getHeadSha,
  isGitRepo,
  isWorkingTreeDirty,
  listSessionRefs,
  resolveRef,
  restore,
  sessionRef,
  snapshot,
} from '../../src/checkpoints/git.ts';

const runGit = async (cwd: string, args: string[], stdin?: string): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: {
      LC_ALL: 'C',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      // Identity so commits don't fail on a config-less env (CI sandboxes).
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@local',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@local',
    },
    stdin: stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (stdin !== undefined) {
    const sink = proc.stdin;
    if (sink === undefined) throw new Error('expected stdin sink');
    sink.write(stdin);
    await sink.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
  return stdout;
};

const initRepoWithCommit = async (cwd: string): Promise<void> => {
  // -b main keeps the default branch deterministic across git versions
  // that default to `master` vs `main`.
  await runGit(cwd, ['init', '-b', 'main']);
  await writeFile(join(cwd, 'seed.txt'), 'seed\n');
  await runGit(cwd, ['add', '.']);
  await runGit(cwd, ['commit', '-m', 'seed']);
};

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'forja-git-test-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('isGitRepo', () => {
  test('true inside a git work-tree', async () => {
    await initRepoWithCommit(repo);
    expect(await isGitRepo(repo)).toBe(true);
  });

  test('false outside a git work-tree', async () => {
    expect(await isGitRepo(repo)).toBe(false);
  });
});

describe('getHeadSha', () => {
  test('returns sha when HEAD is born', async () => {
    await initRepoWithCommit(repo);
    const sha = await getHeadSha(repo);
    expect(sha).toBeString();
    expect(sha?.length).toBe(40);
  });

  test('returns null on unborn HEAD', async () => {
    await runGit(repo, ['init', '-b', 'main']);
    expect(await getHeadSha(repo)).toBeNull();
  });
});

describe('resolveRef', () => {
  test('returns null when ref is missing', async () => {
    await initRepoWithCommit(repo);
    expect(await resolveRef(repo, 'refs/agent/checkpoints/missing')).toBeNull();
  });

  test('returns sha when ref exists', async () => {
    await initRepoWithCommit(repo);
    const head = (await getHeadSha(repo)) ?? '';
    await runGit(repo, ['update-ref', sessionRef('s1'), head]);
    expect(await resolveRef(repo, sessionRef('s1'))).toBe(head);
  });
});

describe('snapshot', () => {
  test('creates a commit and updates the session ref', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'change.txt'), 'hello\n');
    const result = await snapshot({
      cwd: repo,
      sessionId: 'sess1',
      stepId: 'msg-1',
      iso: '2026-04-29T00:00:00Z',
      stepN: 1,
    });
    expect(result.sha).toBeString();
    expect(result.sha?.length).toBe(40);

    // Ref updated
    const refSha = await resolveRef(repo, sessionRef('sess1'));
    expect(refSha).toBe(result.sha);

    // Commit message has the expected shape
    const log = await runGit(repo, ['log', '-1', '--format=%s', refSha as string]);
    expect(log.trim()).toBe('forja: pre-step 1 2026-04-29T00:00:00Z');
  });

  test('captures untracked files', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'untracked.txt'), 'fresh\n');
    const result = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: '2026-01-01T00:00:00Z',
    });
    expect(result.sha).not.toBeNull();
    const ls = await runGit(repo, ['ls-tree', '-r', '--name-only', result.sha as string]);
    expect(ls).toContain('untracked.txt');
  });

  test('returns sha=null when no diff vs prior snapshot', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'a.txt'), 'one\n');
    const first = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm1',
      iso: '2026-01-01T00:00:00Z',
    });
    expect(first.sha).not.toBeNull();
    // No file change between calls.
    const second = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm2',
      iso: '2026-01-01T00:00:01Z',
    });
    expect(second.sha).toBeNull();
  });

  test('chains parents on consecutive snapshots', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'a.txt'), '1\n');
    const a = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm1',
      iso: 'iso1',
    });
    await writeFile(join(repo, 'a.txt'), '2\n');
    const b = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm2',
      iso: 'iso2',
    });
    expect(a.sha).not.toBeNull();
    expect(b.sha).not.toBeNull();
    // b's parent should be a's sha (chain).
    const parent = (await runGit(repo, ['rev-parse', `${b.sha as string}^`])).trim();
    expect(parent).toBe(a.sha as string);
  });

  test('does not modify HEAD or the user index', async () => {
    await initRepoWithCommit(repo);
    const headBefore = (await getHeadSha(repo)) ?? '';
    await writeFile(join(repo, 'staged.txt'), 'staged\n');
    await runGit(repo, ['add', 'staged.txt']);
    // Take the snapshot, then verify the staged file is still in the
    // user's index and HEAD didn't move.
    await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    const headAfter = (await getHeadSha(repo)) ?? '';
    expect(headAfter).toBe(headBefore);
    // `git diff --cached --name-only` reflects what's staged in the
    // user's real index; staged.txt should still be there.
    const cached = await runGit(repo, ['diff', '--cached', '--name-only']);
    expect(cached).toContain('staged.txt');
  });

  test('works in unborn repo', async () => {
    await runGit(repo, ['init', '-b', 'main']);
    await writeFile(join(repo, 'first.txt'), 'first\n');
    const result = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    expect(result.sha).not.toBeNull();
    const ls = await runGit(repo, ['ls-tree', '-r', '--name-only', result.sha as string]);
    expect(ls).toContain('first.txt');
    // First commit has no parent.
    const parents = await runGit(repo, ['rev-list', '--parents', '-n', '1', result.sha as string]);
    // Format: "<sha>" alone, no parent shas.
    expect(parents.trim().split(' ')).toHaveLength(1);
  });
});

describe('isWorkingTreeDirty', () => {
  test('false on clean tree', async () => {
    await initRepoWithCommit(repo);
    expect(await isWorkingTreeDirty(repo)).toBe(false);
  });

  test('true with untracked files', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'extra.txt'), 'extra');
    expect(await isWorkingTreeDirty(repo)).toBe(true);
  });

  test('true with modified tracked files', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'seed.txt'), 'seed-modified\n');
    expect(await isWorkingTreeDirty(repo)).toBe(true);
  });
});

describe('restore', () => {
  test('reverts working tree to checkpoint state without moving HEAD', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'a.txt'), 'v1\n');
    const ckpt = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    // Make a different state.
    await writeFile(join(repo, 'a.txt'), 'v2\n');
    await writeFile(join(repo, 'b.txt'), 'extra\n');

    const headBefore = (await getHeadSha(repo)) ?? '';
    const result = await restore(repo, ckpt.sha as string);
    expect(result.stashed).toBe(true);
    expect(result.stashRef).toBe('stash@{0}');
    const headAfter = (await getHeadSha(repo)) ?? '';
    expect(headAfter).toBe(headBefore);

    // a.txt back to v1, b.txt removed.
    const aContents = await Bun.file(join(repo, 'a.txt')).text();
    expect(aContents).toBe('v1\n');
    expect(await Bun.file(join(repo, 'b.txt')).exists()).toBe(false);
  });

  test('does not stash when working tree is already clean', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'c.txt'), 'state\n');
    const ckpt = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    // Commit user changes so working tree is clean before restore.
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'user-commit']);

    const result = await restore(repo, ckpt.sha as string);
    expect(result.stashed).toBe(false);
    expect(result.stashRef).toBeUndefined();
  });
});

describe('diff', () => {
  test('returns non-empty diff vs the working tree', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'd.txt'), 'state-1\n');
    const ckpt = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    await writeFile(join(repo, 'd.txt'), 'state-2\n');
    const out = await diff(repo, ckpt.sha as string);
    expect(out).toContain('d.txt');
    expect(out).toContain('state-1');
    expect(out).toContain('state-2');
  });
});

describe('listSessionRefs / deleteSessionRef', () => {
  test('list returns refs under refs/agent/checkpoints/', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'a.txt'), 'a');
    await snapshot({ cwd: repo, sessionId: 's-alpha', stepId: 'm', iso: 'iso' });
    await writeFile(join(repo, 'b.txt'), 'b');
    await snapshot({ cwd: repo, sessionId: 's-beta', stepId: 'm', iso: 'iso' });

    const refs = await listSessionRefs(repo);
    const ids = refs.map((r) => r.sessionId).sort();
    expect(ids).toEqual(['s-alpha', 's-beta']);
  });

  test('deleteSessionRef removes the ref', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'a.txt'), 'a');
    await snapshot({ cwd: repo, sessionId: 's', stepId: 'm', iso: 'iso' });
    await deleteSessionRef(repo, 's');
    expect(await resolveRef(repo, sessionRef('s'))).toBeNull();
  });

  test('deleteSessionRef on missing ref is a no-op', async () => {
    await initRepoWithCommit(repo);
    await deleteSessionRef(repo, 'never-existed'); // no throw
  });
});
