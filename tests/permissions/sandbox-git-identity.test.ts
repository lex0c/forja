import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GitIdentity,
  gitIdentityPassthroughEnv,
  resolveGitIdentity,
} from '../../src/permissions/sandbox-git-identity.ts';

// `gitIdentityPassthroughEnv` is pure — the shape logic (both / name-only /
// email-only / none) is exercised here without touching git, so the
// "nothing configured → no injection" contract is deterministic.
describe('gitIdentityPassthroughEnv', () => {
  test('maps a full identity to author + committer, name + email', () => {
    const id: GitIdentity = { name: 'Ada Lovelace', email: 'ada@example.com' };
    expect(gitIdentityPassthroughEnv(id)).toEqual({
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
  });

  test('name-only identity yields only the two NAME vars', () => {
    expect(gitIdentityPassthroughEnv({ name: 'Ada' })).toEqual({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_COMMITTER_NAME: 'Ada',
    });
  });

  test('email-only identity yields only the two EMAIL vars', () => {
    expect(gitIdentityPassthroughEnv({ email: 'ada@example.com' })).toEqual({
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
  });

  test('empty identity → empty map (no injection; native commit failure preserved)', () => {
    expect(gitIdentityPassthroughEnv({})).toEqual({});
  });

  test('empty-string fields are treated as absent', () => {
    expect(gitIdentityPassthroughEnv({ name: '', email: '' })).toEqual({});
  });

  test('never emits an executable / repo-redirect GIT_* var', () => {
    const out = gitIdentityPassthroughEnv({ name: 'Ada', email: 'ada@example.com' });
    expect(Object.keys(out).sort()).toEqual([
      'GIT_AUTHOR_EMAIL',
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_COMMITTER_NAME',
    ]);
  });
});

// `resolveGitIdentity` shells out to the real `git` in a tmpdir (same
// philosophy as cli/git-context.test.ts). Determinism: point
// GIT_CONFIG_GLOBAL at a temp file we control and /dev/null the system
// config, so the runner's real ~/.gitconfig + /etc/gitconfig never leak
// in — this ALSO exercises the Nix/XDG fix (the probe must forward
// GIT_CONFIG_GLOBAL or the temp global would be invisible).
const gitAvailable = (): boolean => {
  try {
    return (
      Bun.spawnSync({ cmd: ['git', '--version'], stdout: 'ignore', stderr: 'ignore' }).exitCode ===
      0
    );
  } catch {
    return false;
  }
};

const git = (cwd: string, ...args: string[]): void => {
  Bun.spawnSync({ cmd: ['git', '-C', cwd, ...args], stdout: 'ignore', stderr: 'ignore' });
};

const writeGlobal = (path: string, name: string | null, email: string | null): void => {
  let s = '[user]\n';
  if (name !== null) s += `\tname = ${name}\n`;
  if (email !== null) s += `\temail = ${email}\n`;
  writeFileSync(path, s);
};

describe('resolveGitIdentity (global-only, local-gated)', () => {
  let dir: string;
  let repo: string;
  let globalCfg: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-git-id-'));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    globalCfg = join(dir, 'global.gitconfig');
    Bun.spawnSync({
      cmd: ['git', 'init', '--initial-branch=main', repo],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    // Isolate global/system config so the machine's real identity can't
    // leak into the assertions.
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'XDG_CONFIG_HOME']) {
      saved[k] = process.env[k];
    }
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg-empty');
  });
  afterEach(() => {
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'XDG_CONFIG_HOME']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test('forwards the GLOBAL identity when the repo has no local config (Nix/XDG fix)', () => {
    if (!gitAvailable()) return;
    writeGlobal(globalCfg, 'Global User', 'global@example.com');

    const id = resolveGitIdentity(repo);
    expect(id).toEqual({ name: 'Global User', email: 'global@example.com' });
    // If the probe failed to forward GIT_CONFIG_GLOBAL, id would be {} —
    // this asserts the forwarding that the Nix home-manager case needs.
    expect(gitIdentityPassthroughEnv(id)).toEqual({
      GIT_AUTHOR_NAME: 'Global User',
      GIT_COMMITTER_NAME: 'Global User',
      GIT_AUTHOR_EMAIL: 'global@example.com',
      GIT_COMMITTER_EMAIL: 'global@example.com',
    });
  });

  test('repo-local identity is NOT injected (visible in-sandbox; must not be overridden)', () => {
    if (!gitAvailable()) return;
    writeGlobal(globalCfg, 'Global User', 'global@example.com');
    git(repo, 'config', 'user.name', 'Repo Local');
    git(repo, 'config', 'user.email', 'local@example.com');

    // Both fields set locally → both skipped → nothing forwarded (the
    // visible .git/config drives the commit inside the sandbox).
    expect(resolveGitIdentity(repo)).toEqual({});
  });

  test('per-field gate: local name present, email only global → forwards email only', () => {
    if (!gitAvailable()) return;
    writeGlobal(globalCfg, 'Global User', 'global@example.com');
    git(repo, 'config', 'user.name', 'Repo Local'); // local name only

    // name → skipped (local present); email → global.
    expect(resolveGitIdentity(repo)).toEqual({ email: 'global@example.com' });
  });

  test('rejects a global value carrying control chars (terminal-escape guard)', () => {
    if (!gitAvailable()) return;
    // ESC + BEL embedded in the global user.name; email is clean.
    writeGlobal(globalCfg, 'A]0;pwnedB', 'clean@example.com');

    const id = resolveGitIdentity(repo);
    expect(id.name).toBeUndefined(); // tainted → dropped
    expect(id.email).toBe('clean@example.com');
  });

  test('no identity anywhere → empty (bare git commit fails natively, by design)', () => {
    if (!gitAvailable()) return;
    writeGlobal(globalCfg, null, null); // empty [user]
    expect(resolveGitIdentity(repo)).toEqual({});
  });

  test('is best-effort: a non-existent cwd never throws', () => {
    const id = resolveGitIdentity(join(dir, 'does', 'not', 'exist'));
    expect(typeof id).toBe('object');
  });
});
