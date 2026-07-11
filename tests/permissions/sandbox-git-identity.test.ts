import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSanitizedGitconfigFile,
  type GitIdentity,
  gitIdentityPassthroughEnv,
  renderSanitizedGitconfig,
  resolveGitIdentity,
  resolveGlobalGitIdentity,
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

// The Linux delivery: a sanitized `[user]`-only gitconfig, quoted so
// comment chars / quotes round-trip and NOTHING but identity is exposed.
describe('renderSanitizedGitconfig', () => {
  test('emits a quoted [user] block with name + email', () => {
    expect(renderSanitizedGitconfig({ name: 'Ada Lovelace', email: 'ada@example.com' })).toBe(
      '[user]\n\tname = "Ada Lovelace"\n\temail = "ada@example.com"\n',
    );
  });

  test('name-only / email-only render just that line', () => {
    expect(renderSanitizedGitconfig({ name: 'Ada' })).toBe('[user]\n\tname = "Ada"\n');
    expect(renderSanitizedGitconfig({ email: 'a@b' })).toBe('[user]\n\temail = "a@b"\n');
  });

  test('empty identity → null (nothing to deliver)', () => {
    expect(renderSanitizedGitconfig({})).toBeNull();
    expect(renderSanitizedGitconfig({ name: '', email: '' })).toBeNull();
  });

  test('escapes backslash + quote and quotes comment chars so the value round-trips', () => {
    // A name with `;`/`#` (config comment chars) must be quoted, and `"`/`\`
    // escaped, or git would truncate/mis-parse it.
    expect(renderSanitizedGitconfig({ name: 'A ; B # C' })).toBe('[user]\n\tname = "A ; B # C"\n');
    expect(renderSanitizedGitconfig({ name: 'a"b\\c' })).toBe('[user]\n\tname = "a\\"b\\\\c"\n');
  });

  test('never emits a section other than [user]', () => {
    const out = renderSanitizedGitconfig({ name: 'Ada', email: 'a@b' }) ?? '';
    // No core.* / alias / credential / includeIf — only identity.
    expect(out.includes('[core]')).toBe(false);
    expect(out.includes('sshCommand')).toBe(false);
    expect(out.trimStart().startsWith('[user]')).toBe(true);
  });
});

describe('ensureSanitizedGitconfigFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-gitcfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes the rendered config and returns its path', () => {
    const id: GitIdentity = { name: 'Ada', email: 'ada@example.com' };
    const p = ensureSanitizedGitconfigFile(id, dir);
    expect(p).not.toBeNull();
    const expected = renderSanitizedGitconfig(id) as string;
    expect(readFileSync(p as string, 'utf8')).toBe(expected);
  });

  test('empty identity → null, no file written', () => {
    expect(ensureSanitizedGitconfigFile({}, dir)).toBeNull();
  });

  test('content-addressed: different identities → different immutable paths (no clobber)', () => {
    const p1 = ensureSanitizedGitconfigFile({ name: 'Ada', email: 'ada@x' }, dir);
    const p2 = ensureSanitizedGitconfigFile({ name: 'Bob', email: 'bob@x' }, dir);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1).not.toBe(p2);
    // Each file keeps its OWN identity — a concurrent second session writing
    // a different identity can't overwrite the first's file.
    expect(readFileSync(p1 as string, 'utf8')).toContain('ada@x');
    expect(readFileSync(p2 as string, 'utf8')).toContain('bob@x');
  });

  test('same identity → same path (idempotent)', () => {
    const id: GitIdentity = { name: 'Ada', email: 'ada@x' };
    expect(ensureSanitizedGitconfigFile(id, dir)).toBe(ensureSanitizedGitconfigFile(id, dir));
  });

  test('atomic write leaves no temp file behind', () => {
    ensureSanitizedGitconfigFile({ name: 'Ada', email: 'ada@x' }, dir);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
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
    for (const k of [
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'XDG_CONFIG_HOME',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg-empty');
    delete process.env.GIT_CONFIG_NOSYSTEM; // clean default (system read unless a test opts out)
  });
  afterEach(() => {
    for (const k of [
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'XDG_CONFIG_HOME',
    ]) {
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

  // resolveGlobalGitIdentity (the Linux file path) is UNGATED — it returns
  // the operator's global identity even when the repo sets its own local
  // identity, because the file sits at GLOBAL precedence so repo-local wins
  // naturally inside git. This is the key difference from the gated env path.
  test('resolveGlobalGitIdentity returns the global identity even when the repo has local config', () => {
    if (!gitAvailable()) return;
    writeGlobal(globalCfg, 'Global User', 'global@example.com');
    git(repo, 'config', 'user.name', 'Repo Local');
    git(repo, 'config', 'user.email', 'local@example.com');

    // Ungated: global returned regardless of local (contrast: resolveGitIdentity → {}).
    expect(resolveGlobalGitIdentity(repo)).toEqual({
      name: 'Global User',
      email: 'global@example.com',
    });
    expect(resolveGitIdentity(repo)).toEqual({});
  });

  test('resolveGlobalGitIdentity rejects control-char values too', () => {
    if (!gitAvailable()) return;
    writeGlobal(globalCfg, 'A\x1b]0;x\x07B', 'clean@example.com');
    const id = resolveGlobalGitIdentity(repo);
    expect(id.name).toBeUndefined();
    expect(id.email).toBe('clean@example.com');
  });

  // includeIf: operators select work/personal identity via `[includeIf
  // "gitdir:…"]`. `--global --get` ignores it (returns the unconditional
  // value); the scoped read must resolve it the way `git commit` would.
  test('honors an includeIf gitdir conditional identity (not the unconditional global)', () => {
    if (!gitAvailable()) return;
    const inc = join(dir, 'work.inc');
    writeFileSync(inc, '[user]\n\temail = work@corp\n');
    // Unconditional personal identity + a conditional include for THIS repo.
    writeFileSync(
      globalCfg,
      `[user]\n\tname = Personal\n\temail = personal@x\n[includeIf "gitdir:${repo}/"]\n\tpath = ${inc}\n`,
    );
    // The includeIf'd email wins (git commit here would use work@corp), name
    // falls back to the unconditional value.
    expect(resolveGlobalGitIdentity(repo)).toEqual({ name: 'Personal', email: 'work@corp' });
  });

  test('a repo NOT under the includeIf condition gets the unconditional identity', () => {
    if (!gitAvailable()) return;
    const inc = join(dir, 'work.inc');
    writeFileSync(inc, '[user]\n\temail = work@corp\n');
    writeFileSync(
      globalCfg,
      `[user]\n\tname = Personal\n\temail = personal@x\n[includeIf "gitdir:${join(dir, 'elsewhere')}/"]\n\tpath = ${inc}\n`,
    );
    expect(resolveGlobalGitIdentity(repo)).toEqual({ name: 'Personal', email: 'personal@x' });
  });

  // GIT_CONFIG_NOSYSTEM: an operator who disabled system config must not have
  // a /etc/gitconfig-level identity captured. The probe forwards the var.
  test('captures a system-level identity by default (system scope is read)', () => {
    if (!gitAvailable()) return;
    const sysCfg = join(dir, 'system.gitconfig');
    writeFileSync(sysCfg, '[user]\n\temail = sys@fromsystem\n');
    process.env.GIT_CONFIG_SYSTEM = sysCfg; // override the /dev/null default
    writeGlobal(globalCfg, null, null); // no global identity → only system has email

    expect(resolveGlobalGitIdentity(repo).email).toBe('sys@fromsystem');
  });

  test('honors GIT_CONFIG_NOSYSTEM — no system-level identity is captured', () => {
    if (!gitAvailable()) return;
    const sysCfg = join(dir, 'system.gitconfig');
    writeFileSync(sysCfg, '[user]\n\temail = sys@fromsystem\n');
    process.env.GIT_CONFIG_SYSTEM = sysCfg;
    process.env.GIT_CONFIG_NOSYSTEM = '1'; // operator disabled system config
    writeGlobal(globalCfg, null, null);

    // git would ignore /etc/gitconfig; so must we.
    expect(resolveGlobalGitIdentity(repo).email).toBeUndefined();
  });

  test('is best-effort: a non-existent cwd never throws', () => {
    const id = resolveGitIdentity(join(dir, 'does', 'not', 'exist'));
    expect(typeof id).toBe('object');
    expect(typeof resolveGlobalGitIdentity(join(dir, 'nope'))).toBe('object');
  });
});
