import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchName,
  cleanupWorktree,
  createWorktree,
  defaultWorktreeRoot,
  slugify,
} from '../../src/subagents/worktree.ts';

// Each test runs in an isolated parent repo + an isolated worktree
// root so concurrent tests don't collide on git refs and the user's
// real $XDG_CACHE_HOME stays untouched.

let parentRepo: string;
let worktreeRoot: string;

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const proc = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
};

const initParentRepo = async (path: string): Promise<void> => {
  mkdirSync(path, { recursive: true });
  // -b main makes the test stable across git's main-branch default
  // change (~2.30); without -b an older git would land on `master`
  // and our branchName() assertions become brittle.
  await runGit(path, ['init', '-b', 'main']);
  // Identity required for `git commit`.
  await runGit(path, ['config', 'user.email', 'test@example.com']);
  await runGit(path, ['config', 'user.name', 'Test']);
  // Initial commit so HEAD is born and `git worktree add -b ...`
  // can branch from it. Without this, git refuses to create a
  // worktree off an unborn HEAD.
  writeFileSync(join(path, 'README.md'), '# parent\n');
  await runGit(path, ['add', '.']);
  await runGit(path, ['commit', '-m', 'init']);
};

beforeEach(async () => {
  parentRepo = mkdtempSync(join(tmpdir(), 'forja-wt-parent-'));
  worktreeRoot = mkdtempSync(join(tmpdir(), 'forja-wt-root-'));
  await initParentRepo(parentRepo);
});

afterEach(() => {
  // Best-effort cleanup. A test that left a worktree on disk
  // doesn't fail teardown — the next test's tmpdir ensures
  // isolation regardless.
  try {
    rmSync(parentRepo, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    rmSync(worktreeRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('slugify', () => {
  test('lowercases and kebabs free-form text', () => {
    expect(slugify('Refactor Auth Middleware')).toBe('refactor-auth-middleware');
  });

  test('collapses runs of non-alphanumerics into single dashes', () => {
    expect(slugify('foo!!  bar??  baz')).toBe('foo-bar-baz');
  });

  test('trims leading and trailing dashes', () => {
    expect(slugify('---foo---')).toBe('foo');
  });

  test('truncates to 40 chars and trims trailing dash from cut', () => {
    // 50 alpha + dashes — the cut at MAX_SLUG_CHARS lands
    // mid-token; the helper drops the resulting trailing dash so
    // the slug never ends in `-`.
    const s = slugify('a-bcdefghij-bcdefghij-bcdefghij-bcdefghij-bcdefghij');
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });

  test("falls back to 'task' when input sanitizes to empty", () => {
    expect(slugify('')).toBe('task');
    expect(slugify('!!!')).toBe('task');
    expect(slugify('   ')).toBe('task');
  });
});

describe('branchName', () => {
  test('combines slug and 8-char id suffix', () => {
    const name = branchName('11111111-2222-3333-4444-555555555555', 'do thing');
    expect(name).toBe('agent/do-thing-11111111');
  });

  test('falls back to task slug for empty prompts', () => {
    const name = branchName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '');
    expect(name).toBe('agent/task-aaaaaaaa');
  });
});

describe('defaultWorktreeRoot', () => {
  test('honors XDG_CACHE_HOME when set', () => {
    const root = defaultWorktreeRoot({ XDG_CACHE_HOME: '/x/cache', HOME: '/h' });
    expect(root).toBe('/x/cache/agent/worktrees');
  });

  test('falls back to ~/.cache when XDG_CACHE_HOME is empty', () => {
    const root = defaultWorktreeRoot({ HOME: '/h' });
    expect(root).toBe('/h/.cache/agent/worktrees');
  });

  test('treats explicitly empty XDG_CACHE_HOME as unset', () => {
    // Empty string is a common shell oddity; XDG spec treats it as
    // "not set" — we honor that to avoid landing under '/agent/...'.
    const root = defaultWorktreeRoot({ XDG_CACHE_HOME: '', HOME: '/h' });
    expect(root).toBe('/h/.cache/agent/worktrees');
  });
});

describe('createWorktree', () => {
  test('creates a fresh worktree under rootDir with the expected branch', async () => {
    const handle = await createWorktree({
      sessionId: '11111111-2222-3333-4444-555555555555',
      prompt: 'refactor auth',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    expect(handle.path).toBe(join(worktreeRoot, '11111111-2222-3333-4444-555555555555'));
    expect(handle.branch).toBe('agent/refactor-auth-11111111');
    expect(existsSync(handle.path)).toBe(true);
    // The README from the initial commit must be present in the
    // worktree — confirms `git worktree add` checked out a real tree.
    expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
    // Branch is registered with the parent repo's refs.
    const branches = await runGit(parentRepo, ['branch', '--list', handle.branch]);
    expect(branches).toContain(handle.branch);
  });

  test('refuses when the target path already exists (orphan defense)', async () => {
    const sessionId = '22222222-3333-4444-5555-666666666666';
    const orphanPath = join(worktreeRoot, sessionId);
    mkdirSync(orphanPath, { recursive: true });
    await expect(
      createWorktree({
        sessionId,
        prompt: 'x',
        parentCwd: parentRepo,
        rootDir: worktreeRoot,
      }),
    ).rejects.toThrow(/already exists/);
  });

  test('refuses when the parent directory is not a git repository', async () => {
    const notGit = mkdtempSync(join(tmpdir(), 'forja-wt-notgit-'));
    try {
      await expect(
        createWorktree({
          sessionId: '33333333-4444-5555-6666-777777777777',
          prompt: 'x',
          parentCwd: notGit,
          rootDir: worktreeRoot,
        }),
      ).rejects.toThrow(/git worktree/);
    } finally {
      rmSync(notGit, { recursive: true, force: true });
    }
  });

  test('rejects worktree whose HEAD has a symlink escaping the boundary', async () => {
    // Commit a symlink that points outside the parent repo
    // (and therefore outside any worktree branched off it).
    // After `git worktree add`, the symlink is checked out
    // intact in the worktree path — the validator must catch
    // it BEFORE the run starts and roll back the worktree.
    const outside = mkdtempSync(join(tmpdir(), 'forja-outside-'));
    try {
      writeFileSync(join(outside, 'host-secret.txt'), 'host data');
      symlinkSync(join(outside, 'host-secret.txt'), join(parentRepo, 'leak'));
      await runGit(parentRepo, ['add', 'leak']);
      await runGit(parentRepo, ['commit', '-m', 'add malicious symlink']);

      let threw = false;
      try {
        await createWorktree({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          prompt: 'symlink test',
          parentCwd: parentRepo,
          rootDir: worktreeRoot,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Critical regression: the worktree dir was rolled back,
      // so the cache root is empty. Without rollback, an
      // operator running `agent worktree gc` would see a stale
      // entry that the run never produced.
      expect(readdirSync(worktreeRoot)).toEqual([]);
      // Branch was deleted (the rollback path runs `branch -D`).
      // We don't know the exact branch name (slug+suffix), but
      // listing the parent's branches must show only `main`.
      const branches = await runGit(parentRepo, ['branch', '--list']);
      expect(branches.trim()).toBe('* main');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('worktree appears clean to git after deny-list deletions (regression: skip-worktree)', async () => {
    // Without the skip-worktree marking, deleting tracked
    // files (`.env`, `cert.pem`) leaves ` D <file>` lines in
    // `git status --porcelain`. cleanupWorktree treats any
    // non-empty status as dirty → preserves the worktree
    // forever. Every subagent run on a repo with a committed
    // `.env` would leak a leftover worktree + agent branch.
    //
    // With the fix, the validator's deletions are masked via
    // `git update-index --skip-worktree`, so status reports a
    // clean tree, cleanup removes the worktree, and the audit
    // row records `cleaned`.
    writeFileSync(join(parentRepo, '.env'), 'API_KEY=topsecret\n');
    writeFileSync(join(parentRepo, 'cert.pem'), '----BEGIN----\n');
    mkdirSync(join(parentRepo, '.ssh'));
    writeFileSync(join(parentRepo, '.ssh/id_rsa'), 'private');
    writeFileSync(join(parentRepo, '.ssh/known_hosts'), 'host');
    await runGit(parentRepo, ['add', '-A']);
    await runGit(parentRepo, ['commit', '-m', 'add sensitive files']);

    const handle = await createWorktree({
      sessionId: 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',
      prompt: 'clean cycle test',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });

    // git status --porcelain in the worktree must be empty —
    // deny-listed deletions are hidden by --skip-worktree.
    const status = await runGit(handle.path, ['status', '--porcelain']);
    expect(status).toBe('');

    // Sanity: the deletions actually happened on disk.
    expect(existsSync(join(handle.path, '.env'))).toBe(false);
    expect(existsSync(join(handle.path, 'cert.pem'))).toBe(false);
    expect(existsSync(join(handle.path, '.ssh'))).toBe(false);

    // Cleanup with no child changes → must classify clean.
    const cleanup = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(cleanup.dirty).toBe(false);
    expect(cleanup.removed).toBe(true);
    expect(cleanup.preserved).toBe(false);
    expect(existsSync(handle.path)).toBe(false);
    // Branch deleted too — no orphan agent/* branch left.
    const branches = await runGit(parentRepo, ['branch', '--list', handle.branch]);
    expect(branches.trim()).toBe('');
  });

  test('deny-listed symlink is removed AND masked via skip-worktree (no leftover dirty status)', async () => {
    // End-to-end coverage for the symlink-name bypass + the
    // skip-worktree masking: a `.env -> secrets.txt` committed
    // to the parent gets its symlink entry removed by the
    // validator, and the resulting tracked-symlink deletion is
    // masked from `git status --porcelain`. Without either
    // piece, the worktree would either leak the secret to the
    // child (no name check) or be permanently dirty (no
    // skip-worktree).
    writeFileSync(join(parentRepo, 'secrets.txt'), 'API_KEY=topsecret');
    // Relative target — git stores the symlink string verbatim.
    // An absolute path here would still point at the parent repo
    // when checked out into the worktree, escaping the boundary
    // (a different bug, caught by pass 1). Relative `secrets.txt`
    // resolves inside whichever working tree the symlink lands in.
    symlinkSync('secrets.txt', join(parentRepo, '.env'));
    await runGit(parentRepo, ['add', '-A']);
    await runGit(parentRepo, ['commit', '-m', 'add symlink bypass attempt']);

    const handle = await createWorktree({
      sessionId: 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc',
      prompt: 'symlink bypass cycle',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    // `.env` symlink is gone; `secrets.txt` survives.
    expect(existsSync(join(handle.path, '.env'))).toBe(false);
    expect(existsSync(join(handle.path, 'secrets.txt'))).toBe(true);
    // status is clean — the tracked symlink deletion was
    // skip-worktree'd.
    const status = await runGit(handle.path, ['status', '--porcelain']);
    expect(status).toBe('');

    const cleanup = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(cleanup.removed).toBe(true);
    expect(cleanup.preserved).toBe(false);
  });

  test('child re-creating a masked path is detected as dirty (regression: skip-worktree mutation hiding)', async () => {
    // Skip-worktree silences `git status` for the masked path
    // entirely — including re-writes. A child that recreates
    // `.env` (with new content, or even as a dangling symlink)
    // would otherwise vanish from the cleanup view: status
    // empty, classify clean, remove worktree, lose the write.
    //
    // cleanupWorktree's lstat sweep over `handle.maskedPaths`
    // catches this BEFORE running status. Detected → preserve
    // worktree + branch, operator can inspect.
    writeFileSync(join(parentRepo, '.env'), 'ORIGINAL=1');
    await runGit(parentRepo, ['add', '.env']);
    await runGit(parentRepo, ['commit', '-m', 'add env']);

    const handle = await createWorktree({
      sessionId: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd',
      prompt: 'rewrite test',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    expect(handle.maskedPaths).toContain('.env');
    expect(existsSync(join(handle.path, '.env'))).toBe(false);

    // Simulate the child re-creating `.env` with new content.
    // Without the lstat sweep this write is invisible to
    // `git status --porcelain` (skip-worktree set on `.env`).
    writeFileSync(join(handle.path, '.env'), 'CHILD_INJECTED=1\n');
    // Sanity: skip-worktree really does hide the change from git.
    const status = await runGit(handle.path, ['status', '--porcelain']);
    expect(status).toBe('');

    // The lstat sweep MUST classify this as dirty regardless.
    const cleanup = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(cleanup.dirty).toBe(true);
    expect(cleanup.preserved).toBe(true);
    expect(cleanup.removed).toBe(false);
    // Child's content survives on disk for operator inspection.
    expect(readFileSync(join(handle.path, '.env'), 'utf8')).toBe('CHILD_INJECTED=1\n');
  });

  test('child re-creating a masked path as a dangling symlink is also detected', async () => {
    // existsSync follows symlinks and returns false for
    // broken targets — a child crafting a dangling symlink
    // at a masked path could escape the dirty check if the
    // sweep used existsSync. lstatSync sees the symlink
    // entry regardless of target validity.
    writeFileSync(join(parentRepo, '.env'), 'ORIGINAL=1');
    await runGit(parentRepo, ['add', '.env']);
    await runGit(parentRepo, ['commit', '-m', 'add env']);

    const handle = await createWorktree({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-000011112222',
      prompt: 'dangling rewrite',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    // Create a dangling symlink at the masked location.
    symlinkSync('does-not-exist', join(handle.path, '.env'));

    const cleanup = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(cleanup.dirty).toBe(true);
    expect(cleanup.preserved).toBe(true);
  });

  test('child re-creating a masked DIRECTORY is detected', async () => {
    // Sensitive directories (`.ssh/`) get removed wholesale;
    // a child rebuilding `.ssh/` (any contents) must be flagged.
    mkdirSync(join(parentRepo, '.ssh'));
    writeFileSync(join(parentRepo, '.ssh/id_rsa'), 'private');
    await runGit(parentRepo, ['add', '-A']);
    await runGit(parentRepo, ['commit', '-m', 'add ssh']);

    const handle = await createWorktree({
      sessionId: 'bbbbbbbb-cccc-dddd-eeee-000033334444',
      prompt: 'rewrite ssh',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    expect(existsSync(join(handle.path, '.ssh'))).toBe(false);

    // Child rebuilds the dir with new content.
    mkdirSync(join(handle.path, '.ssh'));
    writeFileSync(join(handle.path, '.ssh/key_planted_by_child'), 'malicious');

    const cleanup = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(cleanup.dirty).toBe(true);
    expect(cleanup.preserved).toBe(true);
  });

  test('child writes are still visible to git after skip-worktree masking (no false negative)', async () => {
    // Defense-in-depth on the skip-worktree fix: masking the
    // validator's deletions must NOT also mask genuine child
    // writes elsewhere in the tree. A child writing
    // `output.txt` after the validator deleted `.env` should
    // still trip the dirty check at cleanup time so the
    // worktree is preserved with the child's work.
    writeFileSync(join(parentRepo, '.env'), 'SECRET');
    await runGit(parentRepo, ['add', '.env']);
    await runGit(parentRepo, ['commit', '-m', 'add env']);

    const handle = await createWorktree({
      sessionId: 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb',
      prompt: 'child writes',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    // Simulate child writing output.
    writeFileSync(join(handle.path, 'output.txt'), 'child wrote this\n');

    const cleanup = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(cleanup.dirty).toBe(true);
    expect(cleanup.preserved).toBe(true);
    expect(cleanup.removed).toBe(false);
    expect(readFileSync(join(handle.path, 'output.txt'), 'utf8')).toBe('child wrote this\n');
  });

  test('strips deny-listed files from the worktree before returning', async () => {
    // Commit a `.env` and a `*.pem` to the parent repo. After
    // `git worktree add` they appear in the worktree's
    // checkout; the validator must remove them so the child's
    // filesystem view never has the secrets, even via direct
    // path access. Non-sensitive files survive untouched.
    writeFileSync(join(parentRepo, '.env'), 'API_KEY=topsecret\n');
    writeFileSync(join(parentRepo, 'cert.pem'), '----BEGIN----\n');
    writeFileSync(join(parentRepo, 'safe.txt'), 'public\n');
    await runGit(parentRepo, ['add', '-A']);
    await runGit(parentRepo, ['commit', '-m', 'add sensitive files']);

    const handle = await createWorktree({
      sessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      prompt: 'strip test',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });

    // Sensitive files gone from the worktree.
    expect(existsSync(join(handle.path, '.env'))).toBe(false);
    expect(existsSync(join(handle.path, 'cert.pem'))).toBe(false);
    // Non-sensitive file remains.
    expect(existsSync(join(handle.path, 'safe.txt'))).toBe(true);
    expect(readFileSync(join(handle.path, 'safe.txt'), 'utf8')).toBe('public\n');
    // Parent repo is untouched — the validator only mutates
    // the worktree, never the source.
    expect(existsSync(join(parentRepo, '.env'))).toBe(true);
    expect(existsSync(join(parentRepo, 'cert.pem'))).toBe(true);
  });

  test('chmods the worktree root to 0700 even when pre-created looser', () => {
    // Pre-create the root with an open mode; the helper must
    // tighten it back to 0700 so worktrees never sit under a
    // group/other-readable cache.
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o755 });
    // We don't even need to call createWorktree — defaultWorktreeRoot
    // is the consumer that triggers chmod, and it runs lazily on
    // create. So we exercise via a real create call:
    return createWorktree({
      sessionId: '44444444-5555-6666-7777-888888888888',
      prompt: 'p',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    }).then(() => {
      const mode = statSync(worktreeRoot).mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });
});

describe('cleanupWorktree', () => {
  test('clean tree → removes the worktree and the agent branch', async () => {
    const handle = await createWorktree({
      sessionId: '55555555-6666-7777-8888-999999999999',
      prompt: 'no changes',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    const result = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(result.dirty).toBe(false);
    expect(result.removed).toBe(true);
    expect(result.preserved).toBe(false);
    expect(existsSync(handle.path)).toBe(false);
    // Branch was deleted: `git branch --list <name>` returns empty.
    const branches = await runGit(parentRepo, ['branch', '--list', handle.branch]);
    expect(branches.trim()).toBe('');
  });

  test('dirty tree (untracked file) → preserves worktree and branch', async () => {
    const handle = await createWorktree({
      sessionId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      prompt: 'wrote stuff',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    writeFileSync(join(handle.path, 'new-file.txt'), 'subagent wrote this\n');
    const result = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(result.dirty).toBe(true);
    expect(result.preserved).toBe(true);
    expect(result.removed).toBe(false);
    expect(existsSync(handle.path)).toBe(true);
    expect(readFileSync(join(handle.path, 'new-file.txt'), 'utf8')).toBe('subagent wrote this\n');
    // Branch survives so the parent can inspect / merge it later.
    const branches = await runGit(parentRepo, ['branch', '--list', handle.branch]);
    expect(branches).toContain(handle.branch);
  });

  test('dirty tree (modified tracked file) → preserves', async () => {
    const handle = await createWorktree({
      sessionId: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
      prompt: 'edit readme',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    writeFileSync(join(handle.path, 'README.md'), '# changed\n');
    const result = await cleanupWorktree({ handle, parentCwd: parentRepo });
    expect(result.dirty).toBe(true);
    expect(result.preserved).toBe(true);
    expect(existsSync(handle.path)).toBe(true);
  });

  test('orphan path inside cache root after preserve is enumerable', async () => {
    // Forensic sanity check: a preserved worktree must remain
    // discoverable by listing the cache root. 4.2d's gc command
    // depends on this — it walks the root and reconciles against
    // `git worktree list`.
    const handle = await createWorktree({
      sessionId: '88888888-9999-aaaa-bbbb-cccccccccccc',
      prompt: 'leave dirty',
      parentCwd: parentRepo,
      rootDir: worktreeRoot,
    });
    writeFileSync(join(handle.path, 'leftover.txt'), 'x');
    await cleanupWorktree({ handle, parentCwd: parentRepo });
    const entries = readdirSync(worktreeRoot);
    expect(entries).toContain('88888888-9999-aaaa-bbbb-cccccccccccc');
  });
});
