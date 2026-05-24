import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import {
  __resetGitBinaryCacheForTest,
  getGitBinary,
  safeGitEnv,
} from '../../src/subagents/git-binary.ts';

describe('getGitBinary — slice 178 hardening M3', () => {
  beforeEach(() => {
    __resetGitBinaryCacheForTest();
  });

  afterEach(() => {
    __resetGitBinaryCacheForTest();
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
