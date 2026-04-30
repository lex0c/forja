import { describe, expect, test } from 'bun:test';
import { createPermissionEngine } from '../../src/permissions/engine.ts';
import type { Policy } from '../../src/permissions/types.ts';

const CWD = '/proj';

const policy = (p: Partial<Policy>): Policy => ({
  defaults: { mode: 'strict' },
  tools: {},
  ...p,
});

describe('engine.check (bash)', () => {
  test('allows commands matching allow rules', () => {
    const eng = createPermissionEngine(
      policy({ tools: { bash: { allow: ['ls *', 'git status'] } } }),
      { cwd: CWD },
    );
    expect(eng.check('bash', 'bash', { command: 'ls -la' }).kind).toBe('allow');
    expect(eng.check('bash', 'bash', { command: 'git status' }).kind).toBe('allow');
  });

  test('denies commands matching deny rules even if also in allow', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { bash: { allow: ['rm *'], deny: ['rm -rf *'] } },
      }),
      { cwd: CWD },
    );
    const d = eng.check('bash', 'bash', { command: 'rm -rf /' });
    expect(d.kind).toBe('deny');
  });

  test('returns confirm decision for confirm rules', () => {
    const eng = createPermissionEngine(policy({ tools: { bash: { confirm: ['git push *'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('bash', 'bash', { command: 'git push origin main' });
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.prompt).toContain('git push origin main');
    }
  });

  test('default-denies when no rule matches', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('bash', 'bash', { command: 'whoami' }).kind).toBe('deny');
  });

  test('rejects bash with no command argument', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('bash', 'bash', {}).kind).toBe('deny');
  });
});

describe('engine.check (paths)', () => {
  test('write_file: allow_paths matches', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { allow_paths: ['src/**'] } } }),
      { cwd: CWD },
    );
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('allow');
  });

  test('write_file: deny_paths wins over allow_paths', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { write_file: { allow_paths: ['**'], deny_paths: ['**/.env*'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('write_file', 'fs.write', { path: 'src/.env' }).kind).toBe('deny');
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('allow');
  });

  test('read_file: deny_paths blocks reads', () => {
    const eng = createPermissionEngine(
      policy({ tools: { read_file: { deny_paths: ['**/.env*'] } } }),
      { cwd: CWD },
    );
    expect(eng.check('read_file', 'fs.read', { path: '.env.production' }).kind).toBe('deny');
  });

  test('confirm_paths returns a confirm decision', () => {
    const eng = createPermissionEngine(
      policy({ tools: { write_file: { confirm_paths: ['package.json'] } } }),
      { cwd: CWD },
    );
    const d = eng.check('write_file', 'fs.write', { path: 'package.json' });
    expect(d.kind).toBe('confirm');
  });

  test('default-denies when no rule matches', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('deny');
  });

  test('rejects write with no path argument', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('write_file', 'fs.write', {}).kind).toBe('deny');
  });
});

describe('engine modes', () => {
  test('bypass mode allows everything regardless of rules', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'bypass' },
        tools: { bash: { deny: ['rm -rf *'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('bash', 'bash', { command: 'rm -rf /' }).kind).toBe('allow');
  });

  test('acceptEdits default-denies unmatched writes (mode is convenience, not bypass)', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'acceptEdits' } }), { cwd: CWD });
    expect(eng.check('write_file', 'fs.write', { path: 'src/foo.ts' }).kind).toBe('deny');
  });

  test('acceptEdits default-denies unmatched reads', () => {
    const eng = createPermissionEngine(policy({ defaults: { mode: 'acceptEdits' } }), { cwd: CWD });
    expect(eng.check('read_file', 'fs.read', { path: 'src/foo.ts' }).kind).toBe('deny');
  });

  test('acceptEdits auto-allows confirm_paths for writes (skip confirm step)', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: { write_file: { confirm_paths: ['package.json'] } },
      }),
      { cwd: CWD },
    );
    const d = eng.check('write_file', 'fs.write', { path: 'package.json' });
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') {
      expect(d.reason).toContain('acceptEdits');
    }
  });

  test('acceptEdits still confirms confirm_paths for reads', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: { read_file: { confirm_paths: ['secrets.txt'] } },
      }),
      { cwd: CWD },
    );
    const d = eng.check('read_file', 'fs.read', { path: 'secrets.txt' });
    expect(d.kind).toBe('confirm');
  });

  test('acceptEdits still honors deny_paths over confirm_paths', () => {
    const eng = createPermissionEngine(
      policy({
        defaults: { mode: 'acceptEdits' },
        tools: {
          write_file: { confirm_paths: ['**/.env*'], deny_paths: ['**/.env.production'] },
        },
      }),
      { cwd: CWD },
    );
    expect(eng.check('write_file', 'fs.write', { path: '.env.production' }).kind).toBe('deny');
  });
});

describe('engine.check (web.fetch)', () => {
  test('host allow/deny', () => {
    const eng = createPermissionEngine(
      policy({
        tools: { fetch_url: { allow_hosts: ['*.public.com'], deny_hosts: ['*.internal'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('fetch_url', 'web.fetch', { url: 'https://api.public.com/x' }).kind).toBe(
      'allow',
    );
    expect(eng.check('fetch_url', 'web.fetch', { url: 'https://api.internal/x' }).kind).toBe(
      'deny',
    );
  });

  test('rejects malformed URL', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('fetch_url', 'web.fetch', { url: 'not a url' }).kind).toBe('deny');
  });
});

describe('engine.check (search tools: glob/grep)', () => {
  test('glob with no `cwd` arg falls back to session cwd', () => {
    const eng = createPermissionEngine(policy({ tools: { glob: { allow_paths: ['./**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('glob', 'fs.read', { pattern: 'src/**/*.ts' });
    expect(d.kind).toBe('allow');
  });

  test('glob with explicit `cwd` arg matches against allow_paths', () => {
    const eng = createPermissionEngine(policy({ tools: { glob: { allow_paths: ['src/**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('glob', 'fs.read', { pattern: '**/*.ts', cwd: 'src' });
    expect(d.kind).toBe('allow');
  });

  test('grep with no `path` arg falls back to session cwd', () => {
    const eng = createPermissionEngine(policy({ tools: { grep: { allow_paths: ['./**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('grep', 'fs.read', { pattern: 'foo' });
    expect(d.kind).toBe('allow');
  });

  test('grep with explicit `path` arg matches against allow_paths', () => {
    const eng = createPermissionEngine(policy({ tools: { grep: { allow_paths: ['src/**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('grep', 'fs.read', { pattern: 'foo', path: 'src' });
    expect(d.kind).toBe('allow');
  });

  test('grep with explicit `path` outside allow_paths is denied', () => {
    const eng = createPermissionEngine(policy({ tools: { grep: { allow_paths: ['src/**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('grep', 'fs.read', { pattern: 'foo', path: 'docs' });
    expect(d.kind).toBe('deny');
  });

  test('grep rooted at a deny_paths directory is rejected (literal match)', () => {
    // The synthetic-descendant probe alone wouldn't fire because
    // `secrets/**` doesn't match `secrets/.forja-check`'s deny check
    // unless the deny pattern itself reaches descendants. Instead the
    // engine also matches the literal root for search tools.
    const eng = createPermissionEngine(
      policy({
        tools: { grep: { allow_paths: ['**'], deny_paths: ['secrets'] } },
      }),
      { cwd: CWD },
    );
    expect(eng.check('grep', 'fs.read', { pattern: 'foo', path: 'secrets' }).kind).toBe('deny');
  });

  test('glob/grep still default-deny when no allow_paths configured', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('glob', 'fs.read', { pattern: 'src/**' }).kind).toBe('deny');
    expect(eng.check('grep', 'fs.read', { pattern: 'foo' }).kind).toBe('deny');
  });

  test('glob with non-string cwd is denied (does not crash on path.resolve)', () => {
    const eng = createPermissionEngine(
      policy({ tools: { glob: { allow_paths: ['./**'], deny_paths: ['secrets'] } } }),
      { cwd: CWD },
    );
    // Cast bypasses TS — model JSON can carry any shape at runtime.
    const d = eng.check('glob', 'fs.read', {
      cwd: 123,
    } as unknown as Parameters<typeof eng.check>[2]);
    expect(d.kind).toBe('deny');
    if (d.kind === 'deny') expect(d.reason).toContain('non-string');
  });

  test('grep with non-string path is denied (does not crash on path.resolve)', () => {
    const eng = createPermissionEngine(
      policy({ tools: { grep: { allow_paths: ['./**'], deny_paths: ['secrets'] } } }),
      { cwd: CWD },
    );
    const d = eng.check('grep', 'fs.read', {
      path: ['oops'],
    } as unknown as Parameters<typeof eng.check>[2]);
    expect(d.kind).toBe('deny');
  });

  test('read_file with non-string path is denied (regression)', () => {
    const eng = createPermissionEngine(policy({ tools: { read_file: { allow_paths: ['**'] } } }), {
      cwd: CWD,
    });
    const d = eng.check('read_file', 'fs.read', {
      path: { not: 'a string' },
    } as unknown as Parameters<typeof eng.check>[2]);
    expect(d.kind).toBe('deny');
  });
});

describe('engine misc category', () => {
  test('misc tools auto-allow (no gate yet)', () => {
    const eng = createPermissionEngine(policy({}), { cwd: CWD });
    expect(eng.check('todo_write', 'misc', {}).kind).toBe('allow');
  });
});

describe('engine.policy() returns a deep copy', () => {
  test('mutating the returned policy does NOT affect the engine', () => {
    // Subagent runtime serializes the engine's policy into
    // `subagent_runs.policy_snapshot` for the subprocess child.
    // If `policy()` returned the captured reference, a caller
    // could silently corrupt the engine's enforcement state by
    // mutating any nested field. structuredClone defends.
    const eng = createPermissionEngine(policy({ tools: { bash: { allow: ['echo *'] } } }), {
      cwd: CWD,
    });
    const snap = eng.policy();
    // Verify the snapshot reflects the engine's state.
    expect(snap.defaults.mode).toBe('strict');
    expect(snap.tools.bash).toEqual({ allow: ['echo *'] });
    // Mutate the snapshot at the deepest level a consumer could
    // touch — top-level field, nested object, nested array.
    snap.defaults.mode = 'bypass';
    const bashRule = snap.tools.bash as { allow?: string[] };
    if (bashRule.allow !== undefined) bashRule.allow.push('rm -rf /');
    // Engine's enforcement is untouched. mode() still strict;
    // the dangerous command is still denied.
    expect(eng.mode()).toBe('strict');
    expect(eng.check('bash', 'bash', { command: 'rm -rf /' }).kind).toBe('deny');
    // A fresh `policy()` call returns the original shape — the
    // mutation didn't leak back through the closure.
    const snap2 = eng.policy();
    expect(snap2.defaults.mode).toBe('strict');
    expect(snap2.tools.bash).toEqual({ allow: ['echo *'] });
  });
});
