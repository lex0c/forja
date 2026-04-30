import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
