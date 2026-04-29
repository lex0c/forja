import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESTORE_SAVED_REF_PREFIX,
  deleteSessionRef,
  diff,
  getHeadSha,
  isGitRepo,
  isWorkingTreeDirty,
  listRestoreSavedRefs,
  listSessionRefs,
  parseRestoreSavedTimestamp,
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

  test('post-restore index matches HEAD, not the checkpoint tree', async () => {
    await initRepoWithCommit(repo);
    // Snapshot 1: working tree = HEAD + a new file. The checkpoint's
    // tree thus diverges from HEAD by one untracked file.
    await writeFile(join(repo, 'extra.txt'), 'extra\n');
    const ckpt = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    // Restore — afterward, working tree should match the ckpt (extra.txt
    // present), but the index should match HEAD (extra.txt absent from
    // the index). `git status` would show extra.txt as untracked, not as
    // a "staged change".
    await restore(repo, ckpt.sha as string);
    const status = await runGit(repo, ['status', '--porcelain']);
    // Untracked files are prefixed with `??`. Staged changes would be
    // `A ` / `M ` / `D `. Either form is fine for this test as long
    // as no `staged` letter shows up.
    const lines = status.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      // First column = staged status. The fix collapses it to ' '
      // (whitespace) for our reverted untracked file.
      const staged = line[0];
      expect(staged).toBe('?');
    }
  });

  test('handles dirty working tree on unborn HEAD without git stash', async () => {
    // git stash push refuses on unborn HEAD ("You do not have the
    // initial commit yet"). snapshot() supports unborn repos, so
    // restore() must too — otherwise --undo on a freshly init'd
    // repo with dirty working tree hard-fails before read-tree.
    //
    // Data-loss case the preservation ref protects against: an
    // untracked working-tree file with the SAME NAME as something
    // in the checkpoint gets overwritten by read-tree --reset -u.
    // Without preservation, the user's version is gone for good.
    await runGit(repo, ['init', '-b', 'main']);
    // Checkpoint has a.txt = "v1".
    await writeFile(join(repo, 'a.txt'), 'v1\n');
    const ckpt = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    expect(ckpt.sha).not.toBeNull();
    // User edits a.txt to "v2" (untracked because unborn HEAD).
    // read-tree --reset -u would overwrite this with the
    // checkpoint's "v1" content; preservation must capture "v2".
    await writeFile(join(repo, 'a.txt'), 'v2\n');

    const result = await restore(repo, ckpt.sha as string);
    expect(result.stashed).toBe(true);
    expect(result.stashRef).toBeDefined();
    expect(result.stashRef).toMatch(/^refs\/agent\/restore-saved\//);
    expect(result.stashKind).toBe('agent-ref');

    // Working tree now has the checkpoint version.
    const aText = await Bun.file(join(repo, 'a.txt')).text();
    expect(aText).toBe('v1\n');
    // Preservation ref's tree contains the user's "v2" version,
    // recoverable via `git read-tree --reset -u <ref>` or
    // `git checkout <ref> -- .`.
    const savedContent = await runGit(repo, ['show', `${result.stashRef as string}:a.txt`]);
    expect(savedContent).toBe('v2\n');
  });

  test('skips preservation on unborn HEAD when working tree is clean', async () => {
    await runGit(repo, ['init', '-b', 'main']);
    await writeFile(join(repo, 'a.txt'), 'state\n');
    const ckpt = await snapshot({
      cwd: repo,
      sessionId: 's',
      stepId: 'm',
      iso: 'iso',
    });
    // Take a fresh snapshot capturing the same working tree, then
    // restore — working tree is unchanged vs the checkpoint, so
    // isWorkingTreeDirty's `git status --porcelain` should be empty
    // (the file is in the checkpoint commit's tree, but git considers
    // it untracked from the unborn-HEAD index's perspective). We
    // accept the simpler invariant: if porcelain is empty, no
    // preservation; if non-empty, preserve. The test covers the
    // "porcelain empty" case explicitly by removing the only
    // untracked file before restore.
    await rm(join(repo, 'a.txt'));
    const result = await restore(repo, ckpt.sha as string);
    expect(result.stashed).toBe(false);
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('state\n');
  });

  test('throws on a non-existent commit before stashing', async () => {
    await initRepoWithCommit(repo);
    await writeFile(join(repo, 'dirty.txt'), 'work-in-progress\n');
    // Use a sha that's syntactically valid but unreachable. The
    // probe in restore() should reject before push-stashing.
    await expect(restore(repo, '0000000000000000000000000000000000000000')).rejects.toThrow();
    // The dirty file must still be in the working tree — proving we
    // did not stash before failing.
    const text = await Bun.file(join(repo, 'dirty.txt')).text();
    expect(text).toBe('work-in-progress\n');
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

describe('parseRestoreSavedTimestamp', () => {
  test('parses the timestamp prefix', () => {
    expect(parseRestoreSavedTimestamp(`${RESTORE_SAVED_REF_PREFIX}1700000000000-deadbeef`)).toBe(
      1_700_000_000_000,
    );
  });

  test('handles refs without a uuid suffix (forward-compat with older format)', () => {
    expect(parseRestoreSavedTimestamp(`${RESTORE_SAVED_REF_PREFIX}1700000000000`)).toBe(
      1_700_000_000_000,
    );
  });

  test('returns null for refs outside the namespace', () => {
    expect(parseRestoreSavedTimestamp('refs/heads/main')).toBeNull();
    expect(parseRestoreSavedTimestamp('refs/agent/checkpoints/foo')).toBeNull();
  });

  test('returns null for non-numeric prefixes', () => {
    expect(parseRestoreSavedTimestamp(`${RESTORE_SAVED_REF_PREFIX}manual-tag`)).toBeNull();
    expect(parseRestoreSavedTimestamp(`${RESTORE_SAVED_REF_PREFIX}-uuid`)).toBeNull();
  });

  test('returns null for non-positive timestamps', () => {
    expect(parseRestoreSavedTimestamp(`${RESTORE_SAVED_REF_PREFIX}0-uuid`)).toBeNull();
    expect(parseRestoreSavedTimestamp(`${RESTORE_SAVED_REF_PREFIX}-1-uuid`)).toBeNull();
  });
});

describe('listRestoreSavedRefs', () => {
  test('returns parsed timestamps for refs in the namespace', async () => {
    await initRepoWithCommit(repo);
    const head = (await getHeadSha(repo)) ?? '';
    const ts1 = 1_700_000_000_000;
    const ts2 = 1_700_000_001_000;
    await runGit(repo, ['update-ref', `${RESTORE_SAVED_REF_PREFIX}${ts1}-aaaaaaaa`, head]);
    await runGit(repo, ['update-ref', `${RESTORE_SAVED_REF_PREFIX}${ts2}-bbbbbbbb`, head]);

    const refs = await listRestoreSavedRefs(repo);
    expect(refs).toHaveLength(2);
    const sorted = [...refs].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
    expect(sorted[0]?.timestampMs).toBe(ts1);
    expect(sorted[1]?.timestampMs).toBe(ts2);
  });

  test('emits null timestamp for refs that do not match the format', async () => {
    await initRepoWithCommit(repo);
    const head = (await getHeadSha(repo)) ?? '';
    await runGit(repo, ['update-ref', `${RESTORE_SAVED_REF_PREFIX}manual-tag`, head]);

    const refs = await listRestoreSavedRefs(repo);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.timestampMs).toBeNull();
  });
});

describe('restore-saved ref name uniqueness', () => {
  test('two restores in the same ms produce distinct refs', async () => {
    // The L2 fix appends a UUID slice so back-to-back restores in
    // the same millisecond don't collide on update-ref.
    await initRepoWithCommit(repo);
    // Force unborn HEAD by re-init'ing in a fresh dir.
    const fresh = await mkdtemp(join(tmpdir(), 'forja-uniq-'));
    try {
      await runGit(fresh, ['init', '-b', 'main']);
      // Snapshot a no-op tree so we have a commit to restore against.
      await writeFile(join(fresh, 'a.txt'), 'v1\n');
      const ckpt = await snapshot({
        cwd: fresh,
        sessionId: 's',
        stepId: 'm',
        iso: 'iso',
      });
      // First dirty restore: writes a different version of a.txt
      // (collides with the checkpoint name → gets preserved).
      await writeFile(join(fresh, 'a.txt'), 'v2\n');
      const r1 = await restore(fresh, ckpt.sha as string);
      // Second dirty restore: re-dirty and restore again immediately.
      await writeFile(join(fresh, 'a.txt'), 'v3\n');
      const r2 = await restore(fresh, ckpt.sha as string);

      expect(r1.stashRef).toBeDefined();
      expect(r2.stashRef).toBeDefined();
      expect(r1.stashRef).not.toBe(r2.stashRef);

      // Both refs still resolve — neither was clobbered.
      expect(await resolveRef(fresh, r1.stashRef as string)).not.toBeNull();
      expect(await resolveRef(fresh, r2.stashRef as string)).not.toBeNull();
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
