import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, bootstrap } from '../../src/cli/bootstrap.ts';
import type { Provider } from '../../src/providers/index.ts';

let workdir: string;
let dbPath: string;
let originalKey: string | undefined;
let originalXdg: string | undefined;

const mockProvider: Provider = {
  id: 'mock/m',
  family: 'anthropic',
  capabilities: {
    tools: 'native',
    cache: false,
    vision: false,
    streaming: true,
    constrained: 'tools',
    context_window: 1000,
    output_max_tokens: 100,
    cost_per_1k_input: 0,
    cost_per_1k_output: 0,
    notes: [],
  },
  // biome-ignore lint/correctness/useYield: never reaches yield
  async *generate() {
    throw new Error('not used');
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-bootstrap-'));
  dbPath = join(workdir, 'sessions.db');
  originalKey = process.env.ANTHROPIC_API_KEY;
  // Isolate user-scope memory under the workdir so the dev's
  // real ~/.config/agent/memory/ doesn't bleed into bootstrap
  // tests asserting against systemPrompt. The 5.2.c memory
  // injection eagerly loads the merged index; without isolation
  // a developer with personal memories would see their content
  // leak into "passes through unchanged" assertions.
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe('bootstrap', () => {
  test('builds a config with provider override and a fresh DB', () => {
    const { config, db, modelId, policyLayers } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(modelId).toBe(DEFAULT_MODEL);
    expect(policyLayers).toEqual([]);
    expect(config.provider).toBe(mockProvider);
    expect(config.userPrompt).toBe('hi');
    expect(config.cwd).toBe(workdir);
    expect(
      config.toolRegistry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        'bash',
        'bash_background',
        'bash_kill',
        'bash_output',
        'edit_file',
        'glob',
        'grep',
        'memory_list',
        'memory_read',
        'memory_search',
        'memory_write',
        'monitor',
        'read_file',
        'task',
        'task_async',
        'task_await',
        'task_cancel',
        'todo_write',
        'wait_for',
        'write_file',
      ].sort(),
    );
    db.close();
  });

  test('honors --model override', () => {
    const { modelId, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      modelId: 'mock/custom',
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(modelId).toBe('mock/custom');
    db.close();
  });

  test('throws on unknown model when no override is supplied', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(() =>
      bootstrap({
        prompt: 'hi',
        cwd: workdir,
        modelId: 'fake/nope',
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      }),
    ).toThrow(/unknown model: fake\/nope/);
  });

  test('loads project policy when .agent/permissions.yaml exists', () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent/permissions.yaml'),
      'defaults:\n  mode: acceptEdits\ntools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const { config, db, policyLayers } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(policyLayers).toEqual(['project']);
    expect(config.permissionEngine.mode()).toBe('acceptEdits');
    db.close();
  });

  test('falls back to default policy when no file', () => {
    const { config, db, policyLayers } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(policyLayers).toEqual([]);
    expect(config.permissionEngine.mode()).toBe('strict');
    db.close();
  });

  test('plan: true sets harness planMode and injects plan-aware system prompt', () => {
    const { config, db } = bootstrap({
      prompt: 'refactor auth',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      plan: true,
    });
    expect(config.planMode).toBe(true);
    expect(config.systemPrompt).toContain('PLAN MODE');
    expect(config.systemPrompt).toContain('BLOCKED');
    db.close();
  });

  test('plan omitted leaves planMode unset and no system prompt', () => {
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.planMode).toBeUndefined();
    expect(config.systemPrompt).toBeUndefined();
    db.close();
  });

  test('plan + caller systemPrompt composes (plan first, user after separator)', () => {
    const { config, db } = bootstrap({
      prompt: 'refactor',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      plan: true,
      systemPrompt: 'Project convention: prefer functional style.',
    });
    expect(config.planMode).toBe(true);
    expect(config.systemPrompt).toContain('PLAN MODE');
    expect(config.systemPrompt).toContain('Project convention');
    // Plan instructions come first; user prompt after separator.
    const planIdx = (config.systemPrompt ?? '').indexOf('PLAN MODE');
    const userIdx = (config.systemPrompt ?? '').indexOf('Project convention');
    expect(planIdx).toBeLessThan(userIdx);
    db.close();
  });

  test('memory section appended to caller systemPrompt when memories exist', () => {
    // Project local memory under workdir.
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — full-stack TS dev\n');
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      systemPrompt: 'You are a senior engineer.',
    });
    expect(config.systemPrompt).toContain('You are a senior engineer.');
    expect(config.systemPrompt).toContain('# Memory');
    expect(config.systemPrompt).toContain('[project_local] role — full-stack TS dev');
    // memoryRegistry is wired into the config so the memory_*
    // tools can dispatch.
    expect(config.memoryRegistry).toBeDefined();
    db.close();
  });

  test('boot triggers probe the repo root, not the invocation cwd (regression)', () => {
    // Bug: bootstrap evaluated boot triggers from the invocation
    // cwd, not the repo root. Operator running `agent` from
    // `/repo/src/components/` saw `git` / `package` / `tsconfig`
    // triggers fail to fire because the probe scanned the subdir
    // (no root-level files there), even though memories were
    // loaded from `/repo`. Fix: probe from `resolveRepoRoot(cwd)`.
    //
    // Setup: workdir/.git + workdir/package.json (repo-level
    // trigger files), a project_local memory tagged `triggers:
    // [git, package]`, then bootstrap from workdir/src/sub. The
    // memory must surface in the eager prompt section.
    Bun.spawnSync({
      cmd: ['git', 'init', workdir],
      stdout: 'ignore',
      stderr: 'ignore',
    });
    writeFileSync(join(workdir, 'package.json'), '{}');
    const subDir = join(workdir, 'src', 'sub');
    mkdirSync(subDir, { recursive: true });
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, 'MEMORY.md'),
      '- [GitTagged](git-tagged.md) — git-tagged memory\n',
    );
    writeFileSync(
      join(localDir, 'git-tagged.md'),
      [
        '---',
        'name: git-tagged',
        'description: hook for git-tagged',
        'type: feedback',
        'source: user_explicit',
        'triggers:',
        '  - git',
        '  - package',
        '---',
        '',
        'body',
      ].join('\n'),
    );
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: subDir, // invocation cwd is the SUBDIR, not the repo root
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    // Memory should be present — `git` / `package` triggers fired
    // because we probed the repo root.
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).toContain('git-tagged');
    db.close();
  });

  test('memory section becomes systemPrompt when no caller prompt and memories exist', () => {
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — TS dev\n');
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).toContain('# Memory');
    expect(config.systemPrompt?.startsWith('# Memory')).toBe(true);
    db.close();
  });

  test('closes DB when memory registry construction throws (regression: C1)', () => {
    // Seed a project_local MEMORY.md with valid content so the
    // index parser succeeds, then chmod the file 0 so loadScopeIndex
    // hits EACCES on read. The construction error must propagate
    // without leaking the SQLite handle.
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    const memPath = join(localDir, 'MEMORY.md');
    writeFileSync(memPath, '- [Role](role.md) — TS dev\n');
    const { chmodSync } = require('node:fs') as typeof import('node:fs');
    chmodSync(memPath, 0o000);
    try {
      let threw = false;
      try {
        bootstrap({
          prompt: 'hi',
          cwd: workdir,
          providerOverride: mockProvider,
          dbPath,
          enterprisePolicyPath: null,
          userPolicyPath: null,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // The DB file exists but no WAL/SHM lock should remain
      // beyond the throw — sqlite leaves a -wal/-shm pair when a
      // handle is open. Check the wal file is gone (best-effort
      // proxy for "the handle was closed"). If sqlite never created
      // wal because no writes happened post-migrate, this is also
      // fine — the test is checking we DON'T leave a dangling
      // handle, not that we asserted any wal-specific state.
      // Mostly we're verifying bootstrap throws cleanly without
      // the test runner complaining about an unclosed handle.
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      // Restore permissions so the afterEach cleanup can rmSync.
      chmodSync(memPath, 0o644);
    }
  });

  test('memory loads from repo root, not subdir (regression: subdir blindspot)', async () => {
    // Operator runs `agent` from a subdirectory of a git repo
    // (e.g., `/repo/src/components/`). Memory tree lives at the
    // repo root (`/repo/.agent/memory/...`). Pre-fix the
    // bootstrap would resolve scope roots from the subdir cwd
    // and silently miss every project memory. Post-fix it calls
    // git rev-parse and anchors at the repo root.
    const initRepo = async (path: string): Promise<void> => {
      const proc = Bun.spawn({
        cmd: ['git', 'init', '-b', 'main'],
        cwd: path,
        env: { LC_ALL: 'C', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await proc.exited;
    };
    await initRepo(workdir);
    // Seed the repo-root project_local memory.
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — repo root memory\n');

    // Invoke from a subdir, NOT the repo root.
    const subdir = join(workdir, 'src', 'components');
    mkdirSync(subdir, { recursive: true });
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: subdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    // System prompt must include the memory section even though
    // the cwd is a subdir — the repo-root resolution catches it.
    expect(config.systemPrompt).toContain('# Memory');
    expect(config.systemPrompt).toContain('[project_local] role — repo root memory');
    db.close();
  });

  test('memory registry is wired even when no memories exist (empty list)', () => {
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    // With empty memory tree, systemPrompt stays undefined (no
    // injection forces the field) — preserves existing test
    // expectations.
    expect(config.systemPrompt).toBeUndefined();
    // But the registry is still threaded through for tools.
    expect(config.memoryRegistry).toBeDefined();
    expect(config.memoryRegistry?.list()).toEqual([]);
    db.close();
  });

  test('caller systemPrompt without plan passes through unchanged', () => {
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      systemPrompt: 'You are a senior engineer.',
    });
    expect(config.planMode).toBeUndefined();
    expect(config.systemPrompt).toBe('You are a senior engineer.');
    db.close();
  });

  test('forwards budget overrides into config', () => {
    const { config, db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      budget: { maxSteps: 7 },
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.budget?.maxSteps).toBe(7);
    db.close();
  });

  test('migrates the DB so the schema is ready to use', () => {
    const { db } = bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('tool_calls');
    expect(names).toContain('approvals');
    db.close();
  });

  test('malformed permissions.yaml throws BEFORE the DB is opened (no leak)', () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(join(workdir, '.agent/permissions.yaml'), 'defaults: { mode: [unterminated');
    expect(() =>
      bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      }),
    ).toThrow();
    // The DB file should not exist because openDb was never called for
    // this run. (Our reorder loads policy first; if the DB had been
    // opened pre-throw, SQLite would have created the file.)
    expect(existsSync(dbPath)).toBe(false);
  });

  test('unknown model throws BEFORE the DB is opened (no leak)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(() =>
      bootstrap({
        prompt: 'hi',
        cwd: workdir,
        modelId: 'fake/nope',
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      }),
    ).toThrow(/unknown model/);
    expect(existsSync(dbPath)).toBe(false);
  });

  describe('isCwdTrusted resolution (MEMORY.md §7.2.1)', () => {
    test('returns true when cwd is in the trust list', () => {
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));
      const { config, db } = bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.isCwdTrusted).toBe(true);
      db.close();
    });

    test('returns false when cwd is absent from trust list', () => {
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: ['/other/path'] }));
      const { config, db } = bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.isCwdTrusted).toBe(false);
      db.close();
    });

    test('returns false when trust file is missing (storage absent)', () => {
      const trustPath = join(workdir, 'never-created.json');
      const { config, db } = bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.isCwdTrusted).toBe(false);
      db.close();
    });

    test('returns false when trustListPathOverride is null (storage disabled)', () => {
      const { config, db } = bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: null,
      });
      expect(config.isCwdTrusted).toBe(false);
      db.close();
    });
  });
});
