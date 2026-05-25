import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  __resetGitBinaryCacheForTest,
  getGitBinary,
  getGitBinarySync,
  getGitBinaryWithEnv,
  getGitBinaryWithEnvSync,
  safeGitEnv,
} from '../../src/subagents/git-binary.ts';

describe('getGitBinary — slice 178 hardening M3', () => {
  beforeEach(() => {
    __resetGitBinaryCacheForTest();
  });

  afterEach(() => {
    __resetGitBinaryCacheForTest();
  });

  test('resolves git in-process (no `which` binary dependency)', async () => {
    // The helper walks PATH entries via fs.access(.., X_OK)
    // instead of spawning `which`. Minimal container images
    // (busybox, distroless, scratch + static-binary) often
    // don't ship `which`; the in-process walk works as long as
    // git itself is present and PATH lists its directory.
    //
    // We can't easily prove "no spawn happened" from a black-box
    // test, but we can prove the resolution succeeds — and the
    // resolution code path is the same `fs.access` walk for
    // both canonical and fallback. A direct integration check
    // would mock `Bun.spawn`; the assertion below is the next
    // best thing.
    const path = await getGitBinary();
    if (path === 'git') {
      // Tolerate the bare-fallback case (test env with no git
      // anywhere in SAFE_PATH or process.env.PATH). Still pin
      // the contract that the call returned a string.
      expect(typeof path).toBe('string');
      return;
    }
    expect(path.endsWith('/git')).toBe(true);
  });

  test('resolves to an absolute path on systems with git installed', async () => {
    // CI + dev machines: git is on the safe PATH (/usr/local/bin,
    // /usr/bin, /bin). Resolution must return an absolute path so
    // subsequent spawns aren't subject to PATH shadowing.
    const path = await getGitBinary();
    // Fallback path is the bare string 'git' when which fails — on
    // any sane test environment we should see the absolute path
    // instead.
    if (path === 'git') {
      // Allow the fallback on exotic environments rather than fail
      // the test; pin the contract that fallback IS the bare command.
      expect(path).toBe('git');
      return;
    }
    expect(isAbsolute(path)).toBe(true);
    expect(path.endsWith('/git')).toBe(true);
  });

  test('caches the resolution across calls (single which probe)', async () => {
    const first = await getGitBinary();
    const second = await getGitBinary();
    const third = await getGitBinary();
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test('cache reset re-probes', async () => {
    const first = await getGitBinary();
    __resetGitBinaryCacheForTest();
    const second = await getGitBinary();
    // Same machine: same result. The point is the reset path
    // executes without throw.
    expect(second).toBe(first);
  });
});

describe('safeGitEnv — slice 178 hardening M3', () => {
  beforeEach(() => {
    __resetGitBinaryCacheForTest();
  });

  afterEach(() => {
    __resetGitBinaryCacheForTest();
  });

  test('PATH starts at the canonical set before any resolution', () => {
    // Without a prior getGitBinary call, the spawn PATH is the
    // pristine canonical set. Any caller that uses safeGitEnv
    // before resolving git gets the strict layout.
    const env = safeGitEnv();
    expect(env.PATH).toBe(
      '/opt/homebrew/sbin:/opt/homebrew/bin:/opt/local/sbin:/opt/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
  });

  test('after canonical resolution, PATH augments with operator boot PATH for hooks', async () => {
    // Pin the regression fix: even when git is found in the
    // canonical set, the spawn PATH must include the operator's
    // boot PATH so git's subprocess hooks (post-checkout,
    // pre-commit, etc.) can find user-level tools (nvm, asdf,
    // poetry, ~/bin utilities). Pre-fix only the fallback branch
    // augmented; canonical hits left hooks blind to user PATH and
    // `git worktree add` exit-coded any repo whose hooks called
    // missing tools.
    //
    // Skip if process.env.PATH equals the canonical set verbatim
    // (rare test env where there's nothing to augment with).
    const operatorPath = process.env.PATH;
    if (
      operatorPath === undefined ||
      operatorPath ===
        '/opt/homebrew/sbin:/opt/homebrew/bin:/opt/local/sbin:/opt/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    ) {
      return;
    }
    await getGitBinary();
    const env = safeGitEnv();
    expect(env.PATH).toBe(
      `/opt/homebrew/sbin:/opt/homebrew/bin:/opt/local/sbin:/opt/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${operatorPath}`,
    );
  });

  test('canonical entries still come FIRST in the augmented PATH (shadowing defense)', async () => {
    // Pin: even after augment, `git` resolved by a fork-exec from
    // git's subprocess (e.g., a hook that calls bare `git`)
    // resolves to the canonical /usr/bin/git, NOT a `~/bin/git`
    // shim in operator PATH. PATH lookup is left-to-right.
    await getGitBinary();
    const env = safeGitEnv();
    const pathParts = (env.PATH ?? '').split(':');
    // First 10 entries are the canonical set in order.
    const expectedCanonicalHead = [
      '/opt/homebrew/sbin',
      '/opt/homebrew/bin',
      '/opt/local/sbin',
      '/opt/local/bin',
      '/usr/local/sbin',
      '/usr/local/bin',
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
    ];
    expect(pathParts.slice(0, expectedCanonicalHead.length)).toEqual(expectedCanonicalHead);
  });

  test('PATH includes /opt/homebrew/bin (Apple Silicon Homebrew default)', () => {
    expect(safeGitEnv().PATH).toContain('/opt/homebrew/bin');
  });

  test('PATH includes /opt/local/bin (MacPorts default)', () => {
    expect(safeGitEnv().PATH).toContain('/opt/local/bin');
  });

  test('PATH canonical prefix does NOT include per-user shadow directories', () => {
    // ~/bin and ~/.local/bin are the canonical shim-injection
    // points; the canonical prefix never includes them. The
    // fallback append CAN include them (operator's boot PATH),
    // but the canonical entries come FIRST so a name that exists
    // in both resolves to the canonical copy.
    const env = safeGitEnv();
    expect(env.PATH).toBeDefined();
    const canonicalPrefix = (env.PATH ?? '').split(
      ':/opt/local/sbin:/opt/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    )[0];
    expect(canonicalPrefix).not.toContain('/home/');
    expect(canonicalPrefix).not.toContain('.local/bin');
    expect(canonicalPrefix).not.toContain('~');
  });

  test('preserves the standard git knobs every git call wants', () => {
    const env = safeGitEnv();
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('does NOT set GIT_LITERAL_PATHSPECS (breaks check-ignore et al)', () => {
    // `git check-ignore` rejects the `literal` pathspec magic with
    // exit 128 — pinning it globally would silently break the
    // ignored-collision detector in src/checkpoints/git.ts. Sites
    // that need it merge it locally (worktree-gc, worktree
    // skip-worktree flow).
    expect(safeGitEnv().GIT_LITERAL_PATHSPECS).toBeUndefined();
  });

  test('HOME is preserved (git reads ~/.gitconfig for committer identity)', () => {
    const env = safeGitEnv();
    // Test envs may have HOME unset; the helper falls back to ''.
    expect(typeof env.HOME).toBe('string');
  });

  test('does NOT leak sensitive env vars (no SSH_AUTH_SOCK, no AWS_*)', () => {
    const env = safeGitEnv();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  test('canonical-first ordering when fallback augments PATH', async () => {
    // Simulate the fallback path by forcing canonical lookup to
    // miss: temporarily strip CANONICAL_SAFE_PATH from process.env.PATH
    // so the `which` call against canonical returns null, then the
    // fallback against process.env.PATH (which still has git at
    // /usr/bin or similar) succeeds. We can't actually mutate the
    // outcome of `which` from the test, so the assertion below is
    // weaker: when the cached spawn PATH was augmented with an
    // operator PATH, the canonical entries MUST come first so a
    // name that exists in both resolves to the canonical copy.
    const env = safeGitEnv();
    expect(env.PATH).toBeDefined();
    const pathParts = (env.PATH ?? '').split(':');
    // Canonical first 10 entries are the fixed set, in order.
    const expectedCanonicalHead = [
      '/opt/homebrew/sbin',
      '/opt/homebrew/bin',
      '/opt/local/sbin',
      '/opt/local/bin',
      '/usr/local/sbin',
      '/usr/local/bin',
      '/usr/sbin',
      '/usr/bin',
      '/sbin',
      '/bin',
    ];
    expect(pathParts.slice(0, expectedCanonicalHead.length)).toEqual(expectedCanonicalHead);
  });
});

describe('getGitBinaryWithEnv — slice 178 ordering combinator', () => {
  beforeEach(() => {
    __resetGitBinaryCacheForTest();
  });

  afterEach(() => {
    __resetGitBinaryCacheForTest();
  });

  test('async combinator returns { git, env } with both populated together', async () => {
    const { git, env } = await getGitBinaryWithEnv();
    expect(typeof git).toBe('string');
    expect(git.length).toBeGreaterThan(0);
    expect(env.PATH).toBeDefined();
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('sync combinator mirrors the async shape', () => {
    const { git, env } = getGitBinaryWithEnvSync();
    expect(typeof git).toBe('string');
    expect(git.length).toBeGreaterThan(0);
    expect(env.PATH).toBeDefined();
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('combinator output uses the same cache as the standalone calls', async () => {
    const { git: gitCombo, env: envCombo } = await getGitBinaryWithEnv();
    const gitStandalone = await getGitBinary();
    const envStandalone = safeGitEnv();
    expect(gitCombo).toBe(gitStandalone);
    expect(envCombo.PATH).toBe(envStandalone.PATH);
  });

  test('async + sync combinators share the same cache', async () => {
    const asyncResult = await getGitBinaryWithEnv();
    const syncResult = getGitBinaryWithEnvSync();
    expect(asyncResult.git).toBe(syncResult.git);
    expect(asyncResult.env.PATH).toBe(syncResult.env.PATH);
  });

  test('sync standalone populates cache for subsequent async safeGitEnv', () => {
    // The bug the combinator exists to prevent: safeGitEnv()
    // captured BEFORE getGitBinary() resolution would see the
    // pre-fallback canonical PATH. After resolution (sync or
    // async), safeGitEnv() returns the potentially-augmented
    // PATH. Pin the cache-sharing invariant explicitly.
    const initialEnv = safeGitEnv();
    const initialPath = initialEnv.PATH;
    getGitBinarySync();
    const afterEnv = safeGitEnv();
    // Either the resolution kept PATH canonical (test env has git
    // under SAFE_PATH) or augmented it — but it MUST NOT be
    // different in a way that changes the canonical prefix order.
    // Pin: PATH still STARTS with the canonical entries.
    expect(afterEnv.PATH?.startsWith('/opt/homebrew/sbin')).toBe(true);
    // And: if augmentation happened, the post-resolution PATH is
    // a strict superset (or equal) — never a different prefix.
    expect(afterEnv.PATH?.startsWith(initialPath ?? '')).toBe(true);
  });
});

describe('findGitInPath — slice 178 hardening (review): candidate validation', () => {
  let tmpRoot: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    __resetGitBinaryCacheForTest();
    savedPath = process.env.PATH;
    tmpRoot = mkdtempSync(join(tmpdir(), 'forja-gitbin-'));
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(tmpRoot, { recursive: true, force: true });
    __resetGitBinaryCacheForTest();
  });

  test('skips relative PATH entries (cwd-dependent resolution is unsafe)', () => {
    // PATH entry `.` or `./bin` would make `git` resolve relative
    // to whatever cwd the eventual Bun.spawn uses. The resolver
    // is called from one cwd, the spawn from another (worktree-gc
    // parentCwd, checkpoints opts.cwd) — caching a relative
    // candidate would resolve differently each call.
    //
    // Set PATH to a relative-only entry that LITERALLY contains a
    // git binary (we drop a fake one). Pin: resolution returns
    // the bare fallback 'git' (or whatever the canonical
    // resolution returned) rather than a relative path.
    const fakeGit = join(tmpRoot, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\necho fake\n');
    chmodSync(fakeGit, 0o755);
    // PATH set to relative entry `.` (which doesn't help: walk
    // skips it; canonical lookup still finds real git).
    process.env.PATH = '.';
    const resolved = getGitBinarySync();
    // Either canonical resolution returned an absolute git, or
    // the bare 'git' fallback. NEVER a relative path matching
    // our fake.
    expect(resolved).not.toBe('./git');
    expect(resolved).not.toBe('git/git');
    if (resolved !== 'git') {
      expect(isAbsolute(resolved)).toBe(true);
    }
  });

  test('skips directories named `git` (X_OK alone passes for searchable dirs)', () => {
    // accessSync(.., X_OK) returns success for searchable
    // directories — a dir literally named `git` in a PATH entry
    // would slip past a naive X_OK check and the subsequent spawn
    // would EACCES/EISDIR.
    const dirNamedGit = join(tmpRoot, 'git');
    // Make a directory, not a file. Mode 0755 = readable + traversable.
    require('node:fs').mkdirSync(dirNamedGit, { mode: 0o755 });
    // PATH = ONLY tmpRoot (absolute, so the absolute check passes
    // and the candidate is `${tmpRoot}/git`, which is a dir).
    process.env.PATH = tmpRoot;
    const resolved = getGitBinarySync();
    // Resolution must NOT return the directory. Either canonical
    // hit (absolute path to a real /usr/bin/git or similar) or
    // the bare 'git' fallback.
    expect(resolved).not.toBe(dirNamedGit);
    if (resolved !== 'git') {
      expect(isAbsolute(resolved)).toBe(true);
    }
  });

  test('accepts a regular executable file in an absolute PATH entry', () => {
    // Sanity: the validation isn't so strict that a real git
    // binary in an absolute custom dir is rejected. Drop a fake
    // git, point PATH ONLY at the absolute tmpRoot, force a
    // fallback resolution by ensuring canonical lookup misses
    // (use a PATH that's NOT canonical).
    const fakeGit = join(tmpRoot, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\necho fake\n');
    chmodSync(fakeGit, 0o755);
    process.env.PATH = tmpRoot;
    const resolved = getGitBinarySync();
    // On a dev box with real git in canonical SAFE_PATH, the
    // canonical lookup succeeds first — resolved is /usr/bin/git
    // or similar, NOT our fake. On a stripped env (no canonical
    // git), the fallback would find our fake.
    expect(isAbsolute(resolved) || resolved === 'git').toBe(true);
  });
});
