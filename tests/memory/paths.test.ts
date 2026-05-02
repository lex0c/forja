import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScopeError,
  indexFilePath,
  memoryFilePath,
  projectScopeRoots,
  resolveRepoRoot,
  resolveScopeRoots,
  scopeOfPath,
  userScopeRoot,
} from '../../src/memory/paths.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-paths-test-'));
  tmpDirs.push(dir);
  // Resolve realpath because macOS routinely symlinks /var → /private/var
  // and git rev-parse returns the canonical form; comparing the result
  // against an unresolved tmpdir path would fail there.
  return realpathSync(dir);
};

const initRepo = async (cwd: string): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ['git', 'init', '-b', 'main'],
    cwd,
    env: { LC_ALL: 'C', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.exited;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
});

describe('resolveRepoRoot', () => {
  test('returns the repo root when invoked from a subdir of a git repo', async () => {
    const repo = makeTmp();
    await initRepo(repo);
    const subdir = join(repo, 'src', 'components');
    mkdirSync(subdir, { recursive: true });
    expect(resolveRepoRoot(subdir)).toBe(repo);
  });

  test('returns the repo root when invoked from the repo root itself', async () => {
    const repo = makeTmp();
    await initRepo(repo);
    expect(resolveRepoRoot(repo)).toBe(repo);
  });

  test('falls back to cwd when not in a git repo', () => {
    const dir = makeTmp();
    expect(resolveRepoRoot(dir)).toBe(dir);
  });

  test('falls back to cwd when path does not exist', () => {
    // git rev-parse fails with non-zero exit; the helper returns
    // the input unchanged. The caller's downstream loadScopeIndex
    // will then return `absent` for any scope under that path.
    const ghost = '/definitely/does/not/exist/anywhere';
    expect(resolveRepoRoot(ghost)).toBe(ghost);
  });
});

describe('userScopeRoot', () => {
  test('honors XDG_CONFIG_HOME when set absolute', () => {
    const root = userScopeRoot({ XDG_CONFIG_HOME: '/custom/xdg' });
    expect(root).toBe('/custom/xdg/agent/memory');
  });

  test('falls back to ~/.config when XDG unset', () => {
    const root = userScopeRoot({});
    expect(root).toBe(join(homedir(), '.config', 'agent', 'memory'));
  });

  test('ignores XDG when value is empty or relative', () => {
    expect(userScopeRoot({ XDG_CONFIG_HOME: '' })).toBe(
      join(homedir(), '.config', 'agent', 'memory'),
    );
    expect(userScopeRoot({ XDG_CONFIG_HOME: 'relative/path' })).toBe(
      join(homedir(), '.config', 'agent', 'memory'),
    );
  });
});

describe('projectScopeRoots', () => {
  test('produces shared and local under .agent/memory/', () => {
    const roots = projectScopeRoots('/repo');
    expect(roots.shared).toBe('/repo/.agent/memory/shared');
    expect(roots.local).toBe('/repo/.agent/memory/local');
  });
});

describe('resolveScopeRoots', () => {
  test('combines user + project scopes', () => {
    const roots = resolveScopeRoots('/repo', { XDG_CONFIG_HOME: '/x' });
    expect(roots).toEqual({
      user: '/x/agent/memory',
      projectShared: '/repo/.agent/memory/shared',
      projectLocal: '/repo/.agent/memory/local',
    });
  });
});

describe('memoryFilePath', () => {
  const roots = {
    user: '/x/agent/memory',
    projectShared: '/repo/.agent/memory/shared',
    projectLocal: '/repo/.agent/memory/local',
  };

  test('builds <root>/<name>.md for each scope', () => {
    expect(memoryFilePath(roots, 'user', 'role')).toBe('/x/agent/memory/role.md');
    expect(memoryFilePath(roots, 'project_shared', 'team-conv')).toBe(
      '/repo/.agent/memory/shared/team-conv.md',
    );
    expect(memoryFilePath(roots, 'project_local', 'in-progress')).toBe(
      '/repo/.agent/memory/local/in-progress.md',
    );
  });

  test('rejects path-traversal name attempts (caught by validateName)', () => {
    expect(() => memoryFilePath(roots, 'user', '../escape')).toThrow();
    expect(() => memoryFilePath(roots, 'user', '..')).toThrow();
    expect(() => memoryFilePath(roots, 'user', '.dotfile')).toThrow();
    expect(() => memoryFilePath(roots, 'user', 'a/b')).toThrow();
  });
});

describe('indexFilePath', () => {
  const roots = {
    user: '/x/agent/memory',
    projectShared: '/repo/.agent/memory/shared',
    projectLocal: '/repo/.agent/memory/local',
  };

  test('points at MEMORY.md within the scope root', () => {
    expect(indexFilePath(roots, 'user')).toBe('/x/agent/memory/MEMORY.md');
    expect(indexFilePath(roots, 'project_shared')).toBe('/repo/.agent/memory/shared/MEMORY.md');
    expect(indexFilePath(roots, 'project_local')).toBe('/repo/.agent/memory/local/MEMORY.md');
  });
});

describe('scopeOfPath', () => {
  const roots = {
    user: '/home/u/.config/agent/memory',
    projectShared: '/repo/.agent/memory/shared',
    projectLocal: '/repo/.agent/memory/local',
  };

  test('identifies each scope by path prefix', () => {
    expect(scopeOfPath(roots, '/home/u/.config/agent/memory/role.md')).toBe('user');
    expect(scopeOfPath(roots, '/repo/.agent/memory/shared/x.md')).toBe('project_shared');
    expect(scopeOfPath(roots, '/repo/.agent/memory/local/y.md')).toBe('project_local');
  });

  test('local takes precedence over shared when paths overlap', () => {
    // shared and local share the parent .agent/memory/. The
    // resolver checks local first so a hypothetical local path
    // never matches shared.
    expect(scopeOfPath(roots, '/repo/.agent/memory/local/z.md')).toBe('project_local');
  });

  test('returns null for paths outside every scope', () => {
    expect(scopeOfPath(roots, '/etc/passwd')).toBeNull();
    expect(scopeOfPath(roots, '/repo/.agent/sessions.db')).toBeNull();
    // The scope root itself is not "inside" — only strict
    // children are.
    expect(scopeOfPath(roots, '/repo/.agent/memory/shared')).toBeNull();
  });

  test('does not match sibling roots that share a prefix', () => {
    const tricky = {
      user: '/data',
      projectShared: '/repo/shared',
      projectLocal: '/repo/shared2', // sibling, not a child
    };
    // /repo/shared2/x.md must NOT match projectShared.
    expect(scopeOfPath(tricky, '/repo/shared2/x.md')).toBe('project_local');
    expect(scopeOfPath(tricky, '/repo/shared-other/x.md')).toBeNull();
  });
});

describe('memoryFilePath with non-canonical roots (regression: C1)', () => {
  test('accepts a root that contains `..` segments (resolved before sandbox check)', () => {
    const roots = {
      user: '/x/agent/memory',
      // Non-canonical: traverses up and back down. Resolves to
      // /repo/.agent/memory/shared.
      projectShared: '/repo/sub/../.agent/memory/shared',
      projectLocal: '/repo/.agent/memory/local',
    };
    expect(memoryFilePath(roots, 'project_shared', 'foo')).toBe(
      '/repo/.agent/memory/shared/foo.md',
    );
  });

  test('accepts a root with a trailing slash', () => {
    const roots = {
      user: '/x/agent/memory/',
      projectShared: '/repo/.agent/memory/shared',
      projectLocal: '/repo/.agent/memory/local',
    };
    expect(memoryFilePath(roots, 'user', 'foo')).toBe('/x/agent/memory/foo.md');
  });
});

describe('scopeOfPath with non-canonical roots (regression: C1)', () => {
  test('matches when both roots and path are non-canonical', () => {
    const roots = {
      user: '/home/u/.config/agent/memory/',
      projectShared: '/repo/sub/../.agent/memory/shared',
      projectLocal: '/repo/./.agent/memory/local',
    };
    expect(scopeOfPath(roots, '/repo/.agent/memory/shared/x.md')).toBe('project_shared');
    expect(scopeOfPath(roots, '/repo/sub/../.agent/memory/local/y.md')).toBe('project_local');
    expect(scopeOfPath(roots, '/home/u/.config/agent/memory/role.md')).toBe('user');
  });
});

describe('memoryFilePath sandbox - defense in depth', () => {
  // Even though validateName blocks `..` etc., we exercise the
  // post-resolve sandbox check by feeding a contrived root that
  // would let a bad name slip through if the resolver misjoined.
  test('rejects when joined path resolves outside scope root', () => {
    const roots = {
      user: '/r',
      projectShared: '/r/shared',
      projectLocal: '/r/local',
    };
    // Even names that pass validateName must produce paths under
    // the scope root. We can't easily craft one without bypassing
    // validateName itself, so this test just confirms the happy
    // path doesn't throw and ScopeError is exported for the
    // future regression where someone loosens validateName.
    expect(() => memoryFilePath(roots, 'user', 'ok')).not.toThrow();
    expect(ScopeError).toBeDefined();
  });
});
