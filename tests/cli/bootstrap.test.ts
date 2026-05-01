import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, bootstrap } from '../../src/cli/bootstrap.ts';
import { CodeIndex } from '../../src/code-index/index.ts';
import type { Provider } from '../../src/providers/index.ts';
import { openMemoryDb } from '../../src/storage/db.ts';

let workdir: string;
let dbPath: string;
let originalKey: string | undefined;

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
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
});

describe('bootstrap', () => {
  test('builds a config with provider override and a fresh DB', async () => {
    const { config, db, modelId, policyLayers } = await bootstrap({
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
        'dependents_of',
        'edit_file',
        'find_references',
        'glob',
        'grep',
        'imports_of',
        'monitor',
        'outline_file',
        'read_file',
        'read_symbol',
        'task',
        'todo_write',
        'wait_for',
        'write_file',
      ].sort(),
    );
    db.close();
  });

  test('honors --model override', async () => {
    const { modelId, db } = await bootstrap({
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

  test('throws on unknown model when no override is supplied', async () => {
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

  test('loads project policy when .agent/permissions.yaml exists', async () => {
    mkdirSync(join(workdir, '.agent'), { recursive: true });
    writeFileSync(
      join(workdir, '.agent/permissions.yaml'),
      'defaults:\n  mode: acceptEdits\ntools:\n  bash:\n    allow:\n      - "ls *"\n',
    );
    const { config, db, policyLayers } = await bootstrap({
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

  test('falls back to default policy when no file', async () => {
    const { config, db, policyLayers } = await bootstrap({
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

  test('plan: true sets harness planMode and injects plan-aware system prompt', async () => {
    const { config, db } = await bootstrap({
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

  test('plan omitted leaves planMode unset and no system prompt', async () => {
    const { config, db } = await bootstrap({
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

  test('plan + caller systemPrompt composes (plan first, user after separator)', async () => {
    const { config, db } = await bootstrap({
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

  test('caller systemPrompt without plan passes through unchanged', async () => {
    const { config, db } = await bootstrap({
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

  test('forwards budget overrides into config', async () => {
    const { config, db } = await bootstrap({
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

  test('migrates the DB so the schema is ready to use', async () => {
    const { db } = await bootstrap({
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

  test('malformed permissions.yaml throws BEFORE the DB is opened (no leak)', async () => {
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

  test('threads codeIndex into HarnessConfig when init succeeds', async () => {
    const idx = await CodeIndex.init({ projectRoot: workdir, dbOverride: openMemoryDb() });
    const { config, db, codeIndexError } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      codeIndexOverride: idx,
    });
    expect(config.codeIndex).toBe(idx);
    expect(codeIndexError).toBeUndefined();
    db.close();
    idx.close();
  });

  test('reports codeIndexError on init failure (no stderr leak from bootstrap)', async () => {
    // Capture stderr to confirm bootstrap doesn't write to it.
    // Force init failure by passing an override built against
    // an already-closed DB — any subsequent operation on it
    // throws but we never call those operations, so we have to
    // simulate a different way. Easiest: stub the override path
    // by passing a non-existent DB path... that still works.
    // Instead, simulate via a class-like object that throws on
    // anything.
    //
    // Pragmatic approach: trigger via the real path by passing
    // a cwd that resolveProjectRoot maps to a non-directory.
    // realpathSync on a missing path throws → CodeIndex.init
    // never runs → codeIndexError is set with the realpath
    // failure message.
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: stderr.write overload chaos
    (process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      const bogusCwd = join(workdir, 'does-not-exist');
      const { config, db, codeIndexError } = await bootstrap({
        prompt: 'hi',
        cwd: bogusCwd,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      });
      expect(config.codeIndex).toBeUndefined();
      expect(codeIndexError).toBeDefined();
      expect(codeIndexError).toContain('index.unavailable');
      // Bootstrap itself MUST NOT write to stderr — that's the
      // contract. Caller (CLI) decides whether to surface.
      expect(stderrChunks.join('')).toBe('');
      db.close();
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('unknown model throws BEFORE the DB is opened (no leak)', async () => {
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
});
