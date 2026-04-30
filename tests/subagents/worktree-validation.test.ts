import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorktreeValidationError,
  validateWorktreeContents,
} from '../../src/subagents/worktree-validation.ts';

// Direct tests on the walker. These don't go through git
// because the walker only cares about the filesystem state of
// the worktree path; piping through `git worktree add` would
// add latency without exercising any new code path. The
// integration with git lives in `worktree.test.ts`.
//
// The fixture pattern is: build a directory tree, hand the
// root to `validateWorktreeContents`, assert the resulting
// state.

let worktree: string;
let outside: string;

beforeEach(() => {
  // Two separate tmpdirs: `worktree` is the validation target,
  // `outside` represents anywhere on the host filesystem that
  // is NOT inside the worktree (the boundary the validator
  // protects). Using two real dirs (rather than `outside =
  // /etc`) keeps the test hermetic — no host-state dependency.
  worktree = mkdtempSync(join(tmpdir(), 'forja-wtv-'));
  outside = mkdtempSync(join(tmpdir(), 'forja-wtv-out-'));
});

afterEach(() => {
  for (const dir of [worktree, outside]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('validateWorktreeContents — symlink boundary', () => {
  test('symlink resolving to a file inside the worktree is allowed', () => {
    writeFileSync(join(worktree, 'real.txt'), 'inside');
    symlinkSync(join(worktree, 'real.txt'), join(worktree, 'link.txt'));
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.symlinksAllowed).toBe(1);
    expect(result.deniedRemoved).toEqual([]);
    // The symlink itself is preserved on disk.
    expect(existsSync(join(worktree, 'link.txt'))).toBe(true);
  });

  test('symlink with absolute target outside the worktree throws', () => {
    writeFileSync(join(outside, 'secret.txt'), 'host secret');
    symlinkSync(join(outside, 'secret.txt'), join(worktree, 'leak'));
    let err: unknown;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorktreeValidationError);
    expect((err as WorktreeValidationError).code).toBe('symlink_escapes_worktree');
    expect((err as WorktreeValidationError).path).toBe('leak');
  });

  test('symlink with `../../` target escaping the worktree throws', () => {
    // Build worktree/sub/escape -> ../../<outside-basename>
    // The realpath check resolves the relative target against
    // the symlink's location, so a `../../` chain that lands
    // outside the worktree must be caught regardless of how it
    // was authored.
    mkdirSync(join(worktree, 'sub'));
    writeFileSync(join(outside, 'sneaky'), 'data');
    symlinkSync(join(outside, 'sneaky'), join(worktree, 'sub/escape'));
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err?.code).toBe('symlink_escapes_worktree');
    expect(err?.path).toBe('sub/escape');
  });

  test('directory symlink whose target is inside the worktree is allowed', () => {
    mkdirSync(join(worktree, 'real-dir'));
    writeFileSync(join(worktree, 'real-dir/file.txt'), 'data');
    symlinkSync(join(worktree, 'real-dir'), join(worktree, 'alias-dir'));
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.symlinksAllowed).toBe(1);
  });

  test('directory symlink whose target is OUTSIDE the worktree throws', () => {
    // Critical defense: the readdir-recursive shortcut would
    // have followed this silently, walking host filesystem.
    // Our per-entry symlink detection catches it.
    mkdirSync(join(outside, 'host-dir'));
    writeFileSync(join(outside, 'host-dir/secret.txt'), 'host data');
    symlinkSync(join(outside, 'host-dir'), join(worktree, 'host'));
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err?.code).toBe('symlink_escapes_worktree');
  });

  test('broken symlink (target does not exist) throws unresolvable', () => {
    symlinkSync(join(outside, 'nonexistent'), join(worktree, 'dangling'));
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err?.code).toBe('symlink_unresolvable');
    expect(err?.path).toBe('dangling');
  });

  test('symlink in deeply nested directory is still validated', () => {
    mkdirSync(join(worktree, 'a/b/c'), { recursive: true });
    writeFileSync(join(outside, 'deep-secret'), 'data');
    symlinkSync(join(outside, 'deep-secret'), join(worktree, 'a/b/c/leak'));
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err?.code).toBe('symlink_escapes_worktree');
    expect(err?.path).toBe('a/b/c/leak');
  });
});

describe('validateWorktreeContents — deny-list filtering', () => {
  test('removes `.env` at the root', () => {
    writeFileSync(join(worktree, '.env'), 'SECRET=1');
    writeFileSync(join(worktree, 'README.md'), '# ok');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved).toEqual([{ path: '.env', pattern: '.env' }]);
    expect(existsSync(join(worktree, '.env'))).toBe(false);
    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
  });

  test('removes `.env.local`, `.env.production`', () => {
    writeFileSync(join(worktree, '.env.local'), 'A=1');
    writeFileSync(join(worktree, '.env.production'), 'B=2');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved.map((r) => r.path).sort()).toEqual([
      '.env.local',
      '.env.production',
    ]);
    expect(existsSync(join(worktree, '.env.local'))).toBe(false);
    expect(existsSync(join(worktree, '.env.production'))).toBe(false);
  });

  test('removes `*.pem` at any depth', () => {
    mkdirSync(join(worktree, 'certs'));
    writeFileSync(join(worktree, 'cert.pem'), 'cert');
    writeFileSync(join(worktree, 'certs/server.pem'), 'inner');
    writeFileSync(join(worktree, 'certs/README.md'), 'ok');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved.map((r) => r.path).sort()).toEqual([
      'cert.pem',
      'certs/server.pem',
    ]);
    expect(existsSync(join(worktree, 'certs/README.md'))).toBe(true);
  });

  test('removes `.ssh/` directory recursively (sensitive directory)', () => {
    mkdirSync(join(worktree, '.ssh'));
    writeFileSync(join(worktree, '.ssh/id_rsa'), 'private');
    writeFileSync(join(worktree, '.ssh/known_hosts'), 'host');
    mkdirSync(join(worktree, '.ssh/sub'));
    writeFileSync(join(worktree, '.ssh/sub/config'), 'cfg');
    const result = validateWorktreeContents({ worktreePath: worktree });
    // Single entry: the directory itself was removed wholesale.
    expect(result.deniedRemoved).toEqual([{ path: '.ssh', pattern: '.ssh/**' }]);
    expect(existsSync(join(worktree, '.ssh'))).toBe(false);
  });

  test('removes `.gnupg/` directory recursively', () => {
    mkdirSync(join(worktree, '.gnupg'));
    writeFileSync(join(worktree, '.gnupg/pubring.kbx'), 'data');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved).toEqual([{ path: '.gnupg', pattern: '.gnupg/**' }]);
    expect(existsSync(join(worktree, '.gnupg'))).toBe(false);
  });

  test('removes `.aws/credentials` but keeps unrelated `.aws/` files', () => {
    // `.aws/credentials` and `.aws/config` are deny-listed
    // explicitly, but the directory itself is NOT (a project
    // might legitimately ship `.aws/cli-cache/` or similar).
    // The directory probe must NOT trigger a wholesale rm.
    mkdirSync(join(worktree, '.aws'));
    writeFileSync(join(worktree, '.aws/credentials'), 'AKIA...');
    writeFileSync(join(worktree, '.aws/config'), 'region=us-east-1');
    writeFileSync(join(worktree, '.aws/region.txt'), 'ok to keep');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved.map((r) => r.path).sort()).toEqual([
      '.aws/config',
      '.aws/credentials',
    ]);
    expect(existsSync(join(worktree, '.aws'))).toBe(true);
    expect(existsSync(join(worktree, '.aws/region.txt'))).toBe(true);
  });

  test('removes `**/credentials*.json` at any depth', () => {
    mkdirSync(join(worktree, 'infra'));
    writeFileSync(join(worktree, 'credentials.json'), '{}');
    writeFileSync(join(worktree, 'infra/credentials-prod.json'), '{}');
    writeFileSync(join(worktree, 'infra/other.json'), 'ok');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved.map((r) => r.path).sort()).toEqual([
      'credentials.json',
      'infra/credentials-prod.json',
    ]);
    expect(existsSync(join(worktree, 'infra/other.json'))).toBe(true);
  });

  test('keeps non-sensitive files untouched', () => {
    writeFileSync(join(worktree, 'README.md'), '# ok');
    writeFileSync(join(worktree, 'package.json'), '{}');
    mkdirSync(join(worktree, 'src'));
    writeFileSync(join(worktree, 'src/index.ts'), 'export {};');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved).toEqual([]);
    // Spot-check files survive.
    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
    expect(existsSync(join(worktree, 'src/index.ts'))).toBe(true);
  });

  test('skips a `.git` entry (worktree gitlink) without recursing', () => {
    // Linked worktrees have `.git` as a FILE pointing at the
    // admin dir under the parent repo. The validator must
    // never read or filter it. We simulate with a directory
    // here (test fixture; the result is the same — skipped).
    mkdirSync(join(worktree, '.git'));
    writeFileSync(join(worktree, '.git/HEAD'), 'ref: refs/heads/main');
    // A `.env` inside `.git/` would normally be deny-listed,
    // but `.git` is skipped entirely so we don't even see it.
    writeFileSync(join(worktree, '.git/.env'), 'SHOULD NOT MATTER');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved).toEqual([]);
    expect(existsSync(join(worktree, '.git/.env'))).toBe(true);
  });
});

describe('validateWorktreeContents — two-pass ordering invariants', () => {
  test('symlink pointing at a deny-listed file does NOT cause spawn failure (regression on order-dependent walk)', () => {
    // Repo configuration: `.env` (real file) AND `link -> .env`
    // (symlink). Pre-fix, iteration order decided whether the
    // run failed: if `.env` was iterated first, deletion left
    // `link` dangling and the validator threw
    // `symlink_unresolvable`. Two-pass design validates ALL
    // symlinks before deleting anything; symlink resolution
    // sees `.env` intact, accepts it, then pass-2 deletes
    // `.env`. The dangling symlink is harmless because the
    // child can't resolve through it (ENOENT at read time).
    //
    // We run the test 5× with the same fixture to guard
    // against intermittent passes from a lucky iteration
    // order — readdirSync order is FS-dependent, but the
    // assertion must hold every time.
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(worktree, '.env'), 'SECRET=1');
      symlinkSync(join(worktree, '.env'), join(worktree, 'env-link'));
      const result = validateWorktreeContents({ worktreePath: worktree });
      expect(result.symlinksAllowed).toBe(1);
      expect(result.deniedRemoved).toEqual([{ path: '.env', pattern: '.env' }]);
      // `.env` deleted, symlink remains (now dangling).
      expect(existsSync(join(worktree, '.env'))).toBe(false);
      expect(existsSync(join(worktree, 'env-link'))).toBe(false); // existsSync follows symlinks
      // Reset for next iteration.
      try {
        rmSync(join(worktree, 'env-link'));
      } catch {
        // ignore — already gone if test cleared
      }
    }
  });

  test('symlink pointing at a sensitive directory does NOT cause spawn failure', () => {
    // M1 from review: `link -> .ssh/`. Pass 1 resolves the
    // symlink to `.ssh` (inside the worktree → allowed).
    // Pass 2 removes `.ssh` wholesale. The symlink dangles
    // but spawn proceeds.
    mkdirSync(join(worktree, '.ssh'));
    writeFileSync(join(worktree, '.ssh/id_rsa'), 'private');
    symlinkSync(join(worktree, '.ssh'), join(worktree, 'ssh-link'));
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.symlinksAllowed).toBe(1);
    expect(result.deniedRemoved).toEqual([{ path: '.ssh', pattern: '.ssh/**' }]);
    expect(existsSync(join(worktree, '.ssh'))).toBe(false);
    // Symlink itself remained on disk (we don't sweep
    // dangling symlinks); but readlink would still hit the
    // deleted target.
  });

  test('nested sensitive directory removed wholesale (`nested/.ssh/`)', () => {
    // M2 from review: deeper-than-root sensitive directory.
    // Pattern `.ssh/**` is normalized to also match
    // `**/.ssh/...`, so a `.ssh` committed inside a
    // subdirectory must trigger the same wholesale removal
    // as a root-level one.
    mkdirSync(join(worktree, 'a/b/.ssh'), { recursive: true });
    writeFileSync(join(worktree, 'a/b/.ssh/id_rsa'), 'private');
    writeFileSync(join(worktree, 'a/b/.ssh/known_hosts'), 'host');
    writeFileSync(join(worktree, 'a/b/keep.txt'), 'unrelated');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved).toEqual([{ path: 'a/b/.ssh', pattern: '.ssh/**' }]);
    expect(existsSync(join(worktree, 'a/b/.ssh'))).toBe(false);
    // Sibling files / parent dirs survive.
    expect(existsSync(join(worktree, 'a/b/keep.txt'))).toBe(true);
    expect(existsSync(join(worktree, 'a'))).toBe(true);
  });

  test('symlink that escapes still throws even when other deny-listed entries exist', () => {
    // Defense-in-depth check: pass 1 must run to completion
    // before pass 2 can delete anything. If a repo has both
    // a malicious symlink AND a `.env`, validation rejects
    // the run; the `.env` MUST still be there afterwards
    // (we threw on the symlink, never reached pass 2).
    writeFileSync(join(worktree, '.env'), 'KEEP_ME_FOR_AUDIT=1');
    writeFileSync(join(outside, 'leak-target'), 'host data');
    symlinkSync(join(outside, 'leak-target'), join(worktree, 'leak'));
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err?.code).toBe('symlink_escapes_worktree');
    // Critical: `.env` was NOT deleted because pass 2 never
    // ran. An operator investigating the rejection sees the
    // worktree exactly as git checked it out.
    expect(existsSync(join(worktree, '.env'))).toBe(true);
  });

  test('symlink_escapes_worktree message redacts the resolved target', () => {
    // M3 from review: the resolved host-side path is the
    // secret the symlink was trying to read; it must NOT
    // appear in `.message`. The operator gets the symlink
    // path via `error.path` and can `readlink` it themselves
    // for forensic investigation.
    writeFileSync(join(outside, 'host-secret-path'), 'data');
    symlinkSync(join(outside, 'host-secret-path'), join(worktree, 'leak'));
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: worktree });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err).toBeDefined();
    // The resolved target name is unique enough that any
    // accidental inclusion in the message would be visible.
    expect(err?.message).not.toContain('host-secret-path');
    expect(err?.message).not.toContain(outside);
    // The symlink path itself is fine — operator needs it.
    expect(err?.message).toContain('leak');
    // Structured `path` field still carries the symlink for
    // programmatic consumers.
    expect(err?.path).toBe('leak');
  });
});

describe('validateWorktreeContents — error paths', () => {
  test('non-existent worktree path throws walk_failed', () => {
    let err: WorktreeValidationError | undefined;
    try {
      validateWorktreeContents({ worktreePath: join(worktree, 'does-not-exist') });
    } catch (e) {
      err = e as WorktreeValidationError;
    }
    expect(err?.code).toBe('walk_failed');
  });

  test('custom deny-list overrides canonical patterns', () => {
    writeFileSync(join(worktree, '.env'), 'SECRET');
    writeFileSync(join(worktree, 'innocuous.txt'), 'data');
    // Override pulls `.env` out of scope (test-only) and adds
    // `*.txt` instead.
    const result = validateWorktreeContents({
      worktreePath: worktree,
      denyListPatterns: ['*.txt'],
    });
    // `.env` survived (no longer in the override list).
    expect(existsSync(join(worktree, '.env'))).toBe(true);
    // `innocuous.txt` was removed.
    expect(existsSync(join(worktree, 'innocuous.txt'))).toBe(false);
    expect(result.deniedRemoved).toEqual([{ path: 'innocuous.txt', pattern: '*.txt' }]);
  });
});

describe('validateWorktreeContents — empty / edge cases', () => {
  test('empty worktree returns zero-counts result', () => {
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result).toEqual({ deniedRemoved: [], symlinksAllowed: 0 });
  });

  test('worktree with only safe files returns zero-counts', () => {
    writeFileSync(join(worktree, 'a.md'), '');
    mkdirSync(join(worktree, 'sub'));
    writeFileSync(join(worktree, 'sub/b.ts'), '');
    const result = validateWorktreeContents({ worktreePath: worktree });
    expect(result.deniedRemoved).toEqual([]);
    expect(result.symlinksAllowed).toBe(0);
    // Tree structure preserved.
    expect(readdirSync(worktree).sort()).toEqual(['a.md', 'sub']);
  });
});
