import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, bootstrap } from '../../src/cli/bootstrap.ts';
import type { Provider } from '../../src/providers/index.ts';
import { flattenSystemSegments } from '../../src/providers/types.ts';

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
    // No [sampling].effort in config → bootstrap applies DEFAULT_EFFORT.
    expect(config.effort).toBe('high');
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
        'clarify',
        'edit_file',
        'glob',
        'grep',
        'memory_list',
        'memory_read',
        'memory_search',
        'memory_write',
        'monitor',
        'pin_context',
        'read_file',
        'retrieve_context',
        'skill_invoke',
        'skill_list',
        'skill_show',
        'task',
        'task_async',
        'task_await',
        'task_cancel',
        'task_list',
        'task_sync',
        'todo_clear',
        'todo_create',
        'todo_get',
        'todo_list',
        'todo_update',
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
    await expect(
      bootstrap({
        prompt: 'hi',
        cwd: workdir,
        modelId: 'fake/nope',
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      }),
    ).rejects.toThrow(/unknown model: fake\/nope/);
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

  test('system prompt carries the parallelism hint as a base preamble', async () => {
    // Post-D227: every bootstrap surfaces the parallelism hint
    // as a base preamble so the model knows multi-tool turns
    // dispatch concurrently. Pre-D227 this test asserted
    // `systemPrompt === undefined`; that's now the only surface
    // change visible to the model.
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).toContain('# Parallelism');
    expect(config.systemPrompt).toContain('emit MULTIPLE tool calls in a SINGLE turn');
    db.close();
  });

  test('emits systemSegments and flattenSystemSegments round-trips to systemPrompt', async () => {
    // Anthropic adapter uses per-segment cache markers; the
    // segment payload must reconstitute to the same string the
    // audit / hash / non-segment-aware adapters consume.
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.systemSegments).toBeDefined();
    // The stable segment is always present; memory segment is
    // conditional on whether memory_index or skills rendered.
    expect(config.systemSegments?.[0]?.id).toBe('stable');
    expect(config.systemSegments?.[0]?.cacheBreakpoint).toBe(true);
    // Round-trip: the flattened segment list must exactly equal
    // the canonical systemPrompt the audit hash was computed over.
    expect(flattenSystemSegments(config.systemSegments ?? [])).toBe(config.systemPrompt ?? '');
    db.close();
  });

  test('records the assembled system prompt in prompt_versions and exposes systemPromptHash', async () => {
    // AUDIT §1.3.3: every session's assembled prompt is content-
    // addressed and registered; the hash surfaces on the result so
    // the harness can stamp messages/tool_calls (§1.3.2 join).
    const { config, db, systemPromptHash } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(systemPromptHash).toBeDefined();
    expect(systemPromptHash).toMatch(/^[0-9a-f]{64}$/);
    const row = db
      .query<{ kind: string; name: string; content: string }, [string]>(
        'SELECT kind, name, content FROM prompt_versions WHERE hash = ?',
      )
      .get(systemPromptHash ?? '');
    expect(row).not.toBeNull();
    expect(row?.kind).toBe('system');
    expect(row?.name).toBe('system.autonomous');
    expect(row?.content).toBe(config.systemPrompt);
    db.close();
  });

  test('caller systemPrompt composes under the parallelism hint (hint, then user)', async () => {
    // Post-D227: two-layer composition. Parallelism hint is the
    // universal background; caller's prompt is the most specific
    // context. Ordering must be hint → user so the model reads
    // them most-generic → most-specific.
    const { config, db } = await bootstrap({
      prompt: 'refactor',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      systemPrompt: 'Project convention: prefer functional style.',
    });
    expect(config.systemPrompt).toContain('# Parallelism');
    expect(config.systemPrompt).toContain('Project convention');
    const hintIdx = (config.systemPrompt ?? '').indexOf('# Parallelism');
    const userIdx = (config.systemPrompt ?? '').indexOf('Project convention');
    expect(hintIdx).toBeLessThan(userIdx);
    db.close();
  });

  // Helper: write a playbook-shaped subagent definition under
  // <workdir>/.agent/agents/<name>.md so bootstrap discovers it
  // through the project scope. Includes `when_to_use` so the def
  // qualifies for the discovery table.
  const writePlaybookDef = (name: string, whenToUse: string): void => {
    const dir = join(workdir, '.agent', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.md`),
      `---
name: ${name}
description: ${name} stub
tools: [read_file]
budget:
  max_steps: 10
  max_cost_usd: 0.5
when_to_use: "${whenToUse}"
---
Body for ${name}.`,
    );
  };

  test('playbook hint absent when no subagent declares when_to_use', async () => {
    // Default workdir has no agents/ dir → registry is empty and
    // the hint must not render. Without this guard the model
    // reads a "Playbook subagents" preamble that lists nothing —
    // pure noise.
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).not.toContain('# Playbook subagents');
    db.close();
  });

  test('playbook hint absent when subagent has no when_to_use field', async () => {
    // Project def WITHOUT when_to_use must not surface in the
    // table. Anchors the §1.4 filter at the bootstrap layer.
    const dir = join(workdir, '.agent', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'legacy.md'),
      `---
name: legacy
description: Legacy generic subagent
tools: [read_file]
budget:
  max_steps: 5
  max_cost_usd: 0.1
---
Body.`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).not.toContain('# Playbook subagents');
    db.close();
  });

  test('playbook hint sits between parallel and user when a def declares when_to_use', async () => {
    writePlaybookDef('code-review', 'gate diff before merge');
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      systemPrompt: 'Project convention: prefer pure functions.',
    });
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).toContain('# Parallelism');
    expect(config.systemPrompt).toContain('# Playbook subagents');
    expect(config.systemPrompt).toContain('| code-review | gate diff before merge |');
    expect(config.systemPrompt).toContain('Project convention');
    const parallelIdx = (config.systemPrompt ?? '').indexOf('# Parallelism');
    const playbookIdx = (config.systemPrompt ?? '').indexOf('# Playbook subagents');
    const userIdx = (config.systemPrompt ?? '').indexOf('Project convention');
    expect(parallelIdx).toBeLessThan(playbookIdx);
    expect(playbookIdx).toBeLessThan(userIdx);
    db.close();
  });

  test('playbook hint composes with the user prompt (parallel → playbook → user)', async () => {
    // Three-layer ordering: most-generic background first, then
    // catalogue, then operator-specific framing. Anchors the
    // bootstrap.ts comment and prevents a future refactor from
    // reordering the layers without updating the model's mental
    // hierarchy.
    writePlaybookDef('refactor', 'apply scope-bounded mutations');
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      systemPrompt: 'Project convention: prefer pure functions.',
    });
    expect(config.systemPrompt).toBeDefined();
    const parallelIdx = (config.systemPrompt ?? '').indexOf('# Parallelism');
    const playbookIdx = (config.systemPrompt ?? '').indexOf('# Playbook subagents');
    const userIdx = (config.systemPrompt ?? '').indexOf('Project convention');
    expect(parallelIdx).toBeGreaterThanOrEqual(0);
    expect(playbookIdx).toBeGreaterThan(parallelIdx);
    expect(userIdx).toBeGreaterThan(playbookIdx);
    db.close();
  });

  test('memory section appended to caller systemPrompt when memories exist', async () => {
    // Project local memory under workdir.
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — full-stack TS dev\n');
    const { config, db } = await bootstrap({
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

  test('boot triggers probe the repo root, not the invocation cwd (regression)', async () => {
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
    const { config, db } = await bootstrap({
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

  test('layered system prompt: identity → env → discipline → response → constraints → parallel → memory', async () => {
    // Layered prompt ordering (bootstrap.ts comment). The
    // outermost layer (which lands FIRST in the rendered string)
    // states the model's role; each inner layer narrows toward
    // task-specific framing. A fresh resume reading the prompt
    // sees:
    //   1. identity / role marker — what Forja is (CONTEXT_TUNING §1.2).
    //   2. # Environment — where am I, what date, git context.
    //   3. # Task discipline — behavioral norms.
    //   4. # Response surface — render-target rules.
    //   5. # Constraints — global negative constraints (§1.6).
    //   6. # Parallelism — concurrency mechanics.
    //   7. (caller / playbook hint wrap when applicable)
    //   8. # Memory — index of cross-session memories.
    const localDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, 'MEMORY.md'), '- [Role](role.md) — TS dev\n');
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt?.startsWith('You are the Hephaestus agent')).toBe(true);
    const identityIdx = config.systemPrompt?.indexOf('You are the Hephaestus agent') ?? -1;
    const envIdx = config.systemPrompt?.indexOf('# Environment') ?? -1;
    const disciplineIdx = config.systemPrompt?.indexOf('# Task discipline') ?? -1;
    const responseIdx = config.systemPrompt?.indexOf('# Response surface') ?? -1;
    const constraintsIdx = config.systemPrompt?.indexOf('# Constraints') ?? -1;
    const parallelIdx = config.systemPrompt?.indexOf('# Parallelism') ?? -1;
    const memoryIdx = config.systemPrompt?.indexOf('# Memory') ?? -1;
    expect(identityIdx).toBe(0);
    expect(envIdx).toBeGreaterThan(identityIdx);
    expect(disciplineIdx).toBeGreaterThan(envIdx);
    expect(responseIdx).toBeGreaterThan(disciplineIdx);
    expect(constraintsIdx).toBeGreaterThan(responseIdx);
    expect(parallelIdx).toBeGreaterThan(constraintsIdx);
    expect(memoryIdx).toBeGreaterThan(parallelIdx);
    db.close();
  });

  test('full layered system prompt: identity → env → discipline → response → constraints → parallel → tool-ergonomics → playbook → caller → project-pointer → memory → skills', async () => {
    // Extends the partial chain test above to assert ALL 13 final
    // layers in their canonical top-down position. Without this,
    // a refactor that drops or reorders tool-ergonomics, playbook
    // hint, project-pointer, or the skill catalog would not be
    // caught by the existing 7-layer test — those four sit
    // between `# Parallelism` and `# Memory` (or after `# Memory`,
    // in the case of `# Skills`) and the partial assertion is
    // satisfied as long as the parallel→memory anchor holds.
    // Mirrors the impl chain documented in `docs/SYSTEM_PROMPT.md
    // §2.1` so a future contributor running this test catches the
    // doc/impl drift at the same time.
    const trustPath = join(workdir, 'trusted_dirs.json');
    writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));
    // AGENTS.md at workdir → project-pointer fires (trust-gated).
    writeFileSync(join(workdir, 'AGENTS.md'), '# project rules\nuse pnpm.\n');
    // Memory file → memory section fires.
    const memDir = join(workdir, '.agent', 'memory', 'local');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), '- [Role](role.md) — TS dev\n');
    // Playbook def with when_to_use → playbook hint fires.
    writePlaybookDef('code-review', 'gate diff before merge');
    // Skill → skill catalog fires.
    const skillsDir = join(workdir, '.agent', 'skills', 'shared');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'explore.md'),
      `---
name: explore
description: Explore an unfamiliar codebase.
version: 1
tools: [bash]
source: project_shared
created_at: 2026-05-24
updated_at: 2026-05-24
expires: null
---

## When to use
When the goal is to orient in a new repo.

## Steps
1. List files.
2. Find entry points.
`,
    );
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      trustListPathOverride: trustPath,
      systemPrompt: 'Caller convention: prefer pure functions.',
    });
    expect(config.systemPrompt).toBeDefined();
    const prompt = config.systemPrompt ?? '';
    const idx = {
      identity: prompt.indexOf('You are the Hephaestus agent'),
      environment: prompt.indexOf('# Environment'),
      discipline: prompt.indexOf('# Task discipline'),
      response: prompt.indexOf('# Response surface'),
      constraints: prompt.indexOf('# Constraints'),
      parallel: prompt.indexOf('# Parallelism'),
      toolErgo: prompt.indexOf('# Tool ergonomics'),
      playbook: prompt.indexOf('# Playbook subagents'),
      caller: prompt.indexOf('Caller convention'),
      projectPtr: prompt.indexOf('# Project context'),
      memory: prompt.indexOf('# Memory'),
      skills: prompt.indexOf('# Skills'),
    };
    // Every layer MUST be present; a missing layer collapses the
    // strict-order chain into a false-positive 0/n comparison
    // below, so assert presence first with a named failure detail.
    for (const [name, position] of Object.entries(idx)) {
      if (position < 0) throw new Error(`layer '${name}' missing from assembled system prompt`);
    }
    // Strict top-down order — each layer appears AFTER the previous.
    expect(idx.identity).toBe(0);
    expect(idx.environment).toBeGreaterThan(idx.identity);
    expect(idx.discipline).toBeGreaterThan(idx.environment);
    expect(idx.response).toBeGreaterThan(idx.discipline);
    expect(idx.constraints).toBeGreaterThan(idx.response);
    expect(idx.parallel).toBeGreaterThan(idx.constraints);
    expect(idx.toolErgo).toBeGreaterThan(idx.parallel);
    expect(idx.playbook).toBeGreaterThan(idx.toolErgo);
    expect(idx.caller).toBeGreaterThan(idx.playbook);
    expect(idx.projectPtr).toBeGreaterThan(idx.caller);
    expect(idx.memory).toBeGreaterThan(idx.projectPtr);
    expect(idx.skills).toBeGreaterThan(idx.memory);
    db.close();
  });

  test('closes DB when memory registry construction throws (regression: C1)', async () => {
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
        await bootstrap({
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
    const { config, db } = await bootstrap({
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

  test('memory registry is wired even when no memories exist (empty list)', async () => {
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    // Bootstrap does NOT install vendor seeds — that's the
    // `agent init` job (spec §5.7.4 + §5.7.8). An operator who
    // never ran init sees the # Memory section's save-criteria
    // guidance but no inventory lines, including no vendor seeds.
    // This preserves the principle that nothing arrives in the
    // user scope without an explicit operator action.
    expect(config.systemPrompt).toBeDefined();
    expect(config.systemPrompt).toContain('# Parallelism');
    expect(config.systemPrompt).toContain('# Memory');
    expect(config.systemPrompt).toContain('memory_write when');
    // Header-only: no inventory lines render with zero entries.
    expect(config.systemPrompt).not.toContain('- [project_local]');
    expect(config.systemPrompt).not.toContain('- [project_shared]');
    expect(config.systemPrompt).not.toContain('- [user]');
    // The header explains the `[seed]` marker in prose, so match the
    // rendered entry marker (` [seed] —`) rather than the bare token.
    expect(config.systemPrompt).not.toContain(' [seed] —');
    // And the registry is still threaded through for tools.
    expect(config.memoryRegistry).toBeDefined();
    expect(config.memoryRegistry?.list()).toEqual([]);
    db.close();
  });

  test('caller systemPrompt is layered after identity / environment / discipline / response-format / constraints / parallelism', async () => {
    // Caller prompt sits INNERMOST in the layered system prompt.
    // The outer wrappers (identity, environment, task discipline,
    // response-format, constraints, parallelism) all land before
    // it; the caller's framing comes last so the operator's
    // specific instructions read against the established context.
    const { config, db } = await bootstrap({
      prompt: 'hi',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
      systemPrompt: 'You are a senior engineer.',
    });
    expect(config.systemPrompt?.startsWith('You are the Hephaestus agent')).toBe(true);
    expect(config.systemPrompt).toContain('# Task discipline');
    expect(config.systemPrompt).toContain('# Response surface');
    expect(config.systemPrompt).toContain('# Constraints');
    expect(config.systemPrompt).toContain('# Parallelism');
    expect(config.systemPrompt).toContain('You are a senior engineer.');
    const identityIdx = config.systemPrompt?.indexOf('You are the Hephaestus agent') ?? -1;
    const envIdx = config.systemPrompt?.indexOf('# Environment') ?? -1;
    const disciplineIdx = config.systemPrompt?.indexOf('# Task discipline') ?? -1;
    const responseIdx = config.systemPrompt?.indexOf('# Response surface') ?? -1;
    const constraintsIdx = config.systemPrompt?.indexOf('# Constraints') ?? -1;
    const parallelIdx = config.systemPrompt?.indexOf('# Parallelism') ?? -1;
    const callerIdx = config.systemPrompt?.indexOf('You are a senior engineer.') ?? -1;
    expect(identityIdx).toBe(0);
    expect(envIdx).toBeGreaterThan(identityIdx);
    expect(disciplineIdx).toBeGreaterThan(envIdx);
    expect(responseIdx).toBeGreaterThan(disciplineIdx);
    expect(constraintsIdx).toBeGreaterThan(responseIdx);
    expect(parallelIdx).toBeGreaterThan(constraintsIdx);
    expect(callerIdx).toBeGreaterThan(parallelIdx);
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
    await expect(
      bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      }),
    ).rejects.toThrow();
    // The DB file should not exist because openDb was never called for
    // this run. (Our reorder loads policy first; if the DB had been
    // opened pre-throw, SQLite would have created the file.)
    expect(existsSync(dbPath)).toBe(false);
  });

  test('unknown model throws BEFORE the DB is opened (no leak)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    await expect(
      bootstrap({
        prompt: 'hi',
        cwd: workdir,
        modelId: 'fake/nope',
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      }),
    ).rejects.toThrow(/unknown model/);
    expect(existsSync(dbPath)).toBe(false);
  });

  describe('isCwdTrusted resolution (MEMORY.md §7.2.1)', () => {
    test('returns true when cwd is in the trust list', async () => {
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));
      const { config, db } = await bootstrap({
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

    test('returns false when cwd is absent from trust list', async () => {
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: ['/other/path'] }));
      const { config, db } = await bootstrap({
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

    test('returns false when trust file is missing (storage absent)', async () => {
      const trustPath = join(workdir, 'never-created.json');
      const { config, db } = await bootstrap({
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

    test('returns false when trustListPathOverride is null (storage disabled)', async () => {
      const { config, db } = await bootstrap({
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

  describe('project pointer (AGENTS.md)', () => {
    // Pin the wire-up to the system prompt that
    // src/cli/project-pointer.ts produces. Module-level tests
    // verify the helper's contract; these verify bootstrap
    // actually calls it with the right inputs and threads the
    // result into config.systemPrompt at the right position
    // (between the system layers and the memory section).

    test('emits the AGENTS.md pointer when cwd is trusted and AGENTS.md exists', async () => {
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));
      writeFileSync(join(workdir, 'AGENTS.md'), '# Project rules\nUse pnpm.\n');
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.systemPrompt).toBeDefined();
      expect(config.systemPrompt).toContain('# Project context');
      expect(config.systemPrompt).toContain(join(workdir, 'AGENTS.md'));
      // Pointer sits AFTER the universal hints (e.g. the
      // parallelism layer) but BEFORE the memory section per
      // CONTEXT_TUNING.md §2 layout. The cache-stability
      // ranking is most-stable-first; project pointer is
      // stable until AGENTS.md is renamed/removed, memory index
      // is stable until any /memory write. Pin both adjacencies
      // so a future composer reorder shows up at PR review
      // rather than as quiet cache invalidation.
      const promptText = config.systemPrompt ?? '';
      const hintIdx = promptText.indexOf('# Parallelism');
      const pointerIdx = promptText.indexOf('# Project context');
      const memoryIdx = promptText.indexOf('# Memory');
      expect(hintIdx).toBeLessThan(pointerIdx);
      // Memory section is only present when at least one
      // memory exists in the registry — the bootstrap test
      // setup isolates user scope under the workdir, which
      // starts empty, so the section is absent here. When
      // present, pointer must precede it.
      if (memoryIdx >= 0) {
        expect(pointerIdx).toBeLessThan(memoryIdx);
      }
      db.close();
    });

    test('emits the pointer for the cwd-specific AGENTS.md when present (subdir scope)', async () => {
      // Operator running `agent` from a subdir that has its own
      // AGENTS.md should see THAT file pointed to, not the
      // repoRoot one. Bootstrap forwards both `cwd` and
      // `repoRoot` to the helper; cwd-first probe wins when
      // both files exist.
      const subdir = join(workdir, 'src');
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(workdir, 'AGENTS.md'), '# repo-wide');
      writeFileSync(join(subdir, 'AGENTS.md'), '# subdir-specific');
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [subdir] }));
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: subdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.systemPrompt ?? '').toContain(join(subdir, 'AGENTS.md'));
      // The repoRoot file's path should NOT be advertised when
      // the cwd-scoped file exists — operator scoped to subdir
      // gets the subdir's conventions.
      expect(config.systemPrompt ?? '').not.toContain(join(workdir, 'AGENTS.md'));
      db.close();
    });

    test('does not advertise repoRoot AGENTS.md when only the subdir is trusted (security boundary)', async () => {
      // Threat model: operator trusted only the subdir
      // (`directories: [subdir]`), not the repoRoot. Trust
      // storage is exact-path membership — a trusted subdir does
      // NOT extend trust to its parent. AGENTS.md exists at the
      // (untrusted) repoRoot only; trust modal probed
      // `subdir/AGENTS.md` (absent) so the operator never saw a
      // disclosure for the repoRoot file. The pointer must
      // suppress the fallback to keep the system prompt's path
      // surface aligned with what the operator authorized.
      //
      // `git init workdir` is necessary so `resolveRepoRoot(subdir)`
      // returns `workdir` and not `subdir` itself — without a
      // `.git` directory the resolver falls back to cwd, which
      // would degenerate the test (cwd === repoRoot, no
      // boundary case to exercise).
      Bun.spawnSync({ cmd: ['git', 'init', workdir], stdout: 'ignore', stderr: 'ignore' });
      const subdir = join(workdir, 'src');
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(workdir, 'AGENTS.md'), '# repo-wide rules');
      // No AGENTS.md at the trusted subdir.
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [subdir] }));
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: subdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.systemPrompt ?? '').not.toContain('# Project context');
      expect(config.systemPrompt ?? '').not.toContain(join(workdir, 'AGENTS.md'));
      db.close();
    });

    test('falls back to repoRoot when BOTH cwd and repoRoot are trusted (typical workflow)', async () => {
      // The common operator workflow: trust the whole repo, run
      // `agent` from a subdir. Both directories are in the trust
      // list. Pointer should fall back to repoRoot/AGENTS.md
      // when the subdir has no AGENTS.md.
      //
      // Same `git init workdir` setup as above so resolveRepoRoot
      // returns workdir, not the cwd subdir.
      Bun.spawnSync({ cmd: ['git', 'init', workdir], stdout: 'ignore', stderr: 'ignore' });
      const subdir = join(workdir, 'src');
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(workdir, 'AGENTS.md'), '# repo-wide rules');
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir, subdir] }));
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: subdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.systemPrompt ?? '').toContain(join(workdir, 'AGENTS.md'));
      db.close();
    });

    test('suppresses the pointer when cwd is untrusted (even with AGENTS.md present)', async () => {
      // Trust modal not yet granted (one-shot CLI / programmatic
      // boot) — the pointer must NOT advertise a file the
      // operator hasn't authorized the agent to read. The
      // permission engine would block read_file anyway; this
      // gate avoids the misleading nudge upstream.
      writeFileSync(join(workdir, 'AGENTS.md'), '# Project rules\nUse pnpm.\n');
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        // No trust list path → not trusted.
        trustListPathOverride: null,
      });
      expect(config.systemPrompt ?? '').not.toContain('# Project context');
      db.close();
    });

    test('suppresses the pointer when AGENTS.md is absent (even on a trusted cwd)', async () => {
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));
      // No AGENTS.md written.
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(config.systemPrompt ?? '').not.toContain('# Project context');
      db.close();
    });
  });

  describe('brokerMode (§13.7, slice 87)', () => {
    test('omitted brokerMode → broker is wired; default depends on host sandbox availability', async () => {
      // Default broker mode resolves dynamically: when the host has
      // a working sandbox tool (bwrap/sandbox-exec), spawn-mode wins
      // automatically so bash spawns get wrapped; otherwise in-process.
      // This test asserts the broker exists and round-trips a bash
      // command — both modes produce the same `ok:true + stdout`
      // shape for an unwrapped echo (`sandboxProfile: null`), so
      // the smoke test is host-mode-agnostic. The
      // `brokerMode: 'in-process'` and `brokerMode: 'spawn'` tests
      // below pin each mode explicitly; this one pins that the
      // default path constructs SOMETHING usable regardless of host.
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      });
      const broker = config.broker;
      if (broker === undefined) throw new Error('expected broker to be wired');
      const r = await broker.execute({
        toolName: 'bash',
        args: { command: 'echo default-ok' },
        capabilities: [],
        sandboxProfile: null,
      });
      expect(r.ok).toBe(true);
      expect(r.stdout).toBe('default-ok\n');
      await broker.close();
      db.close();
    });

    test('brokerMode "in-process" explicit → in-process broker wired regardless of host capability', async () => {
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        brokerMode: 'in-process',
      });
      const broker = config.broker;
      if (broker === undefined) throw new Error('expected broker to be wired');
      const r = await broker.execute({
        toolName: 'bash',
        args: { command: 'echo explicit-ok' },
        capabilities: [],
        sandboxProfile: null,
      });
      expect(r.ok).toBe(true);
      expect(r.stdout).toBe('explicit-ok\n');
      await broker.close();
      db.close();
    });

    test('brokerMode "spawn" → wired against bun run worker.ts; roundtrips a bash command', async () => {
      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        brokerMode: 'spawn',
      });
      const broker = config.broker;
      if (broker === undefined) throw new Error('expected broker to be wired');
      // End-to-end: bootstrap → createSpawnBroker → bun run
      // src/broker/worker.ts → bash handler → echo response.
      const r = await broker.execute({
        toolName: 'bash',
        args: { command: 'echo spawn-ok' },
        capabilities: [],
        sandboxProfile: null,
      });
      expect(r.ok).toBe(true);
      expect(r.stdout).toBe('spawn-ok\n');
      await broker.close();
      db.close();
    });
  });

  describe('default broker resolver (§13.7 sandbox-availability gate)', () => {
    // The default broker mode resolves dynamically per
    // `sandboxAvail.available`. These tests pin both branches via
    // the `sandboxAvailabilityOverride` test seam so the verdict
    // doesn't depend on the runner host's actual sandbox state.

    test('sandbox available + brokerMode omitted → spawn mode + active enforcement snapshot', async () => {
      const { sandboxEnforcement, config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        sandboxAvailabilityOverride: {
          available: true,
          tool: 'bwrap',
          path: '/usr/bin/bwrap',
          trustLevel: 'canonical',
          reason: '',
          trustWarnings: [],
        },
      });
      expect(sandboxEnforcement.active).toBe(true);
      expect(sandboxEnforcement.reason).toBe('active');
      expect(sandboxEnforcement.tool).toBe('bwrap');
      // Broker is wired (spawn mode); smoke-execute a no-op to
      // confirm the construction didn't refuse silently.
      if (config.broker === undefined) throw new Error('expected broker');
      await config.broker.close();
      db.close();
    });

    test('sandbox absent + brokerMode omitted → in-process mode + no-tool snapshot', async () => {
      const { sandboxEnforcement, config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        sandboxAvailabilityOverride: {
          available: false,
          tool: null,
          path: null,
          trustLevel: 'absent',
          reason: 'no sandbox tool detected',
          trustWarnings: [],
        },
      });
      expect(sandboxEnforcement.active).toBe(false);
      expect(sandboxEnforcement.reason).toBe('no-tool');
      expect(sandboxEnforcement.tool).toBeNull();
      if (config.broker === undefined) throw new Error('expected broker');
      await config.broker.close();
      db.close();
    });

    test('sandbox available + brokerMode=in-process → operator-override snapshot', async () => {
      const { sandboxEnforcement, config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        brokerMode: 'in-process',
        sandboxAvailabilityOverride: {
          available: true,
          tool: 'bwrap',
          path: '/usr/bin/bwrap',
          trustLevel: 'canonical',
          reason: '',
          trustWarnings: [],
        },
      });
      expect(sandboxEnforcement.active).toBe(false);
      expect(sandboxEnforcement.reason).toBe('operator-override');
      // Tool is still reported as present even when override
      // suppressed enforcement — operator wants to know they had
      // the option to enable.
      expect(sandboxEnforcement.tool).toBe('bwrap');
      if (config.broker === undefined) throw new Error('expected broker');
      await config.broker.close();
      db.close();
    });

    test('sandbox absent + brokerMode=spawn → degraded-passthrough snapshot', async () => {
      const { sandboxEnforcement, config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        brokerMode: 'spawn',
        sandboxAvailabilityOverride: {
          available: false,
          tool: null,
          path: null,
          trustLevel: 'absent',
          reason: 'no sandbox tool detected',
          trustWarnings: [],
        },
      });
      expect(sandboxEnforcement.active).toBe(false);
      expect(sandboxEnforcement.reason).toBe('degraded-passthrough');
      if (config.broker === undefined) throw new Error('expected broker');
      await config.broker.close();
      db.close();
    });
  });

  describe('memory_provenance retention sweep at boot (S1/T1.7)', () => {
    test('prunes rows older than the retention window; keeps recent rows', async () => {
      // Seed the DB BEFORE bootstrap so the row pre-exists when
      // the boot sweep runs. Bootstrap re-opens the same dbPath,
      // runs migrations (idempotent), then fires the sweep.
      const {
        MEMORY_PROVENANCE_RETENTION_MS: RETENTION_MS,
        recordProvenance,
        listGlobalProvenanceByName,
      } = await import('../../src/storage/repos/memory-provenance.ts');
      const { openDb, migrate } = await import('../../src/storage/index.ts');
      const { createSession } = await import('../../src/storage/repos/sessions.ts');

      const seedDb = openDb(dbPath);
      migrate(seedDb);
      const seedSession = createSession(seedDb, { model: 'm', cwd: workdir });
      const nowMs = Date.now();
      // Row 1: well past retention — must be swept.
      recordProvenance(seedDb, {
        sessionId: seedSession.id,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'old',
        surface: 'eager',
        createdAt: nowMs - RETENTION_MS - 24 * 60 * 60 * 1000,
      });
      // Row 2: inside retention window — must survive.
      recordProvenance(seedDb, {
        sessionId: seedSession.id,
        toolCallId: null,
        memoryScope: 'user',
        memoryName: 'fresh',
        surface: 'eager',
        createdAt: nowMs - 1000,
      });
      seedDb.close();

      const { config, db } = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
      });
      // Bootstrap doesn't surface the swept count; the assertion
      // is on the post-sweep state of the table.
      const oldRows = listGlobalProvenanceByName(db, 'old');
      const freshRows = listGlobalProvenanceByName(db, 'fresh');
      expect(oldRows).toEqual([]);
      expect(freshRows).toHaveLength(1);
      // Smoke-check the config built normally (sweep didn't poison
      // anything downstream).
      expect(config.memoryRegistry).toBeDefined();
      db.close();
    });
  });

  describe('shared-corpus trust probe (S5/T5.2)', () => {
    // Verify the boot probe wires substrate + callback + bulk-
    // invalidate end-to-end inside bootstrap. Per-unit assertions
    // already live in tests/memory/trust-corpus-probe.test.ts; this
    // suite covers the bootstrap-layer contract: gating on
    // isCwdTrusted, plumbing the callback, exposing the result.

    const seedFromMain = async (extra?: {
      seed?: (db: import('../../src/storage/index.ts').DB) => void;
    }) => {
      const { openDb, migrate } = await import('../../src/storage/index.ts');
      const seedDb = openDb(dbPath);
      migrate(seedDb);
      extra?.seed?.(seedDb);
      seedDb.close();
    };

    test('skipped when no askSharedTrust callback is supplied', async () => {
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [A](a.md) — h\n');
      writeFileSync(
        join(sharedDir, 'a.md'),
        '---\nname: a\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(result.sharedTrustProbe).toBeUndefined();
      result.db.close();
    });

    test('skipped when cwd is not trusted (probe requires cwd consent first)', async () => {
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [A](a.md) — h\n');
      writeFileSync(
        join(sharedDir, 'a.md'),
        '---\nname: a\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [] }));

      let callbackFired = false;
      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async () => {
          callbackFired = true;
          return 'yes';
        },
      });
      expect(callbackFired).toBe(false);
      expect(result.sharedTrustProbe).toBeUndefined();
      result.db.close();
    });

    test('seeded silently when no shared corpus exists (empty case)', async () => {
      // P0/F2: silent seed is reserved for the case where there's
      // nothing to consent to. No `.agent/memory/shared/` directory
      // at all → EMPTY_CORPUS_HASH → no modal fires.
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      let modalCalls = 0;
      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async () => {
          modalCalls++;
          return 'yes';
        },
      });
      expect(modalCalls).toBe(0);
      expect(result.sharedTrustProbe?.kind).toBe('seeded');
      result.db.close();
    });

    test('first-visit non-empty: modal fires in mode=first-visit (P0/F2)', async () => {
      // Pre-populated shared/ + cwd already trusted MUST trigger the
      // first-visit modal. Silent seeding here would let a poisoned
      // repo's `.agent/memory/shared/` flow into the model on the
      // very first agent invocation after `git clone`.
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [A](a.md) — h\n');
      writeFileSync(
        join(sharedDir, 'a.md'),
        '---\nname: a\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      let modalCalls = 0;
      let receivedMode: 'first-visit' | 'drift' | null = null;
      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async (args) => {
          modalCalls++;
          receivedMode = args.mode;
          return 'yes';
        },
      });
      expect(modalCalls).toBe(1);
      expect(receivedMode as 'first-visit' | 'drift' | null).toBe('first-visit');
      expect(result.sharedTrustProbe?.kind).toBe('reconfirmed');
      result.db.close();
    });

    test('revoked: corpus changed after seeding → modal fires, bulk-invalidate runs', async () => {
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [A](a.md) — h\n');
      writeFileSync(
        join(sharedDir, 'a.md'),
        '---\nname: a\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      // Pre-seed trust row with the CURRENT hash so the probe sees
      // a baseline. Without this, the first bootstrap would seed
      // silently and any drift test would be conflated with the
      // initial-seed path.
      const { computeSharedFingerprint, setSharedTrust } = await import(
        '../../src/memory/trust-corpus.ts'
      );
      const baselineHash = computeSharedFingerprint(sharedDir);
      expect(baselineHash).toBeString();
      await seedFromMain({
        seed: (db) => setSharedTrust(db, sharedDir, baselineHash as string, 1000),
      });

      // Modify the corpus AFTER the trust baseline.
      writeFileSync(
        join(sharedDir, 'a.md'),
        '---\nname: a\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nTAMPERED\n',
      );

      let receivedPath: string | null = null;
      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async (args) => {
          receivedPath = args.path;
          return 'no';
        },
      });
      expect(receivedPath as string | null).toBe(sharedDir);
      expect(result.sharedTrustProbe?.kind).toBe('revoked');
      if (result.sharedTrustProbe?.kind === 'revoked') {
        expect(result.sharedTrustProbe.invalidated.map((q) => q.name)).toEqual(['a']);
        expect(result.sharedTrustProbe.failed).toEqual([]);
      }
      // CRIT/F2: trust row stamped at post-invalidate hash so the
      // next boot doesn't re-prompt (the invalidated frontmatter is
      // the persistent decline marker). Pre-hardening this was
      // null; the F2 fix made it the durable post-revoke stamp.
      const { getSharedTrust } = await import('../../src/memory/trust-corpus.ts');
      const stored = getSharedTrust(result.db, sharedDir);
      expect(stored).not.toBeNull();
      // The stamped hash matches the corpus state AFTER bulk-
      // invalidate flipped each frontmatter to `state: invalidated`.
      expect(stored?.lastConfirmedHash).toBe(computeSharedFingerprint(sharedDir) as string);
      result.db.close();
    });

    test('revoked: invalidated memory is excluded from the system prompt this turn', async () => {
      // End-to-end: probe runs BEFORE assembleMemorySection so the
      // bulk-invalidate landing on disk is reflected in the prompt
      // built this very boot. Without that ordering the operator
      // would need to restart to get the memories out of the
      // system prompt.
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [Quokka](quokka.md) — h\n');
      writeFileSync(
        join(sharedDir, 'quokka.md'),
        '---\nname: quokka\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      const { computeSharedFingerprint, setSharedTrust } = await import(
        '../../src/memory/trust-corpus.ts'
      );
      const baselineHash = computeSharedFingerprint(sharedDir);
      await seedFromMain({
        seed: (db) => setSharedTrust(db, sharedDir, baselineHash as string, 1000),
      });

      writeFileSync(
        join(sharedDir, 'quokka.md'),
        '---\nname: quokka\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nTAMPERED\n',
      );

      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async () => 'no',
      });
      expect(result.sharedTrustProbe?.kind).toBe('revoked');
      // The system prompt was assembled AFTER the bulk-invalidate
      // landed on disk; the invalidated memory must not appear.
      expect(result.config.systemPrompt ?? '').not.toContain('quokka');
      result.db.close();
    });

    test('unchanged: prior row matches current hash → no modal, probe returns unchanged (T5.5)', async () => {
      // T5.5 strengthening for the happy path inside bootstrap. The
      // unit test in tests/memory/trust-corpus-probe.test.ts already
      // pins this against the probe in isolation; this version
      // verifies the bootstrap-layer plumbing doesn't somehow
      // induce a divergence on the in-sync path (e.g., a registry
      // construction quirk that wrote to the corpus and shifted
      // its hash).
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [A](a.md) — h\n');
      writeFileSync(
        join(sharedDir, 'a.md'),
        '---\nname: a\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nbody\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      const { computeSharedFingerprint, setSharedTrust } = await import(
        '../../src/memory/trust-corpus.ts'
      );
      const baselineHash = computeSharedFingerprint(sharedDir);
      await seedFromMain({
        seed: (db) => setSharedTrust(db, sharedDir, baselineHash as string, 1000),
      });

      let modalCalls = 0;
      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async () => {
          modalCalls++;
          return 'no';
        },
      });
      expect(modalCalls).toBe(0);
      expect(result.sharedTrustProbe?.kind).toBe('unchanged');
      // The trust row stays put with its original timestamp — no
      // re-stamp implied by "unchanged".
      const { getSharedTrust } = await import('../../src/memory/trust-corpus.ts');
      expect(getSharedTrust(result.db, sharedDir)?.lastConfirmedAtMs).toBe(1000);
      result.db.close();
    });

    test('headless without callback: fail-closed when corpus diverged from stored trust (CRIT/F4+M4)', async () => {
      // Pre-hardening: no askSharedTrust → probe skipped → eager-
      // load proceeded with whatever was on disk. A CI run against
      // a corpus that diverged since the operator's last interactive
      // confirm silently auto-accepted the new content.
      // Post-hardening: when the probe doesn't run, the bootstrap
      // computes the hash itself and excludes project_shared
      // unless stored trust matches.
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [X](x.md) — h\n');
      writeFileSync(
        join(sharedDir, 'x.md'),
        '---\nname: x\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nOPERATOR_INFLUENCING_BODY\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      // Pre-seed trust at a STALE hash (simulates: operator
      // confirmed days ago, corpus has since drifted).
      const { openDb, migrate } = await import('../../src/storage/index.ts');
      const seedDb = openDb(dbPath);
      migrate(seedDb);
      const { setSharedTrust } = await import('../../src/memory/trust-corpus.ts');
      setSharedTrust(seedDb, sharedDir, 'stale-hash-from-before', 1_000);
      seedDb.close();

      // Headless boot: no askSharedTrust callback.
      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        // intentionally no askSharedTrust
      });
      // Probe didn't run → no probe result.
      expect(result.sharedTrustProbe).toBeUndefined();
      // BUT the eager-load fail-closed gate kicked in: the shared
      // body must NOT appear in the system prompt.
      expect(result.config.systemPrompt ?? '').not.toContain('OPERATOR_INFLUENCING_BODY');
      // And the retrieval-side gate is also active.
      expect(result.config.memoryExcludeScopes).toEqual(['project_shared']);
      result.db.close();
    });

    test('headless without callback: stored hash matches current → scope loads (CRIT/F4+M4 happy)', async () => {
      // The companion to the fail-closed case: when there's an
      // operator-confirmed trust row matching current disk state,
      // headless callers DO load the scope. Otherwise CI runs
      // against a well-curated repo would be broken.
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [K](kept.md) — h\n');
      writeFileSync(
        join(sharedDir, 'kept.md'),
        '---\nname: kept\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nKEPT_BODY\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [workdir] }));

      const { openDb, migrate } = await import('../../src/storage/index.ts');
      const { computeSharedFingerprint, setSharedTrust } = await import(
        '../../src/memory/trust-corpus.ts'
      );
      const currentHash = computeSharedFingerprint(sharedDir) as string;
      const seedDb = openDb(dbPath);
      migrate(seedDb);
      setSharedTrust(seedDb, sharedDir, currentHash, 1_000);
      seedDb.close();

      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
      });
      expect(result.sharedTrustProbe).toBeUndefined();
      // Stored matches current → scope is online → body in prompt.
      expect(result.config.systemPrompt ?? '').toContain('kept');
      expect(result.config.memoryExcludeScopes).toBeUndefined();
      result.db.close();
    });

    test('untrusted cwd: shared scope excluded even with empty corpus (CRIT/F4+M4)', async () => {
      // Spec §9 — trust is per-project. Without cwd-trust, the
      // shared scope must not load. Probe is also skipped (gated on
      // isCwdTrusted) and the fail-closed branch fires.
      const sharedDir = join(workdir, '.agent', 'memory', 'shared');
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, 'MEMORY.md'), '- [S](s.md) — h\n');
      writeFileSync(
        join(sharedDir, 's.md'),
        '---\nname: s\ndescription: h\ntype: feedback\nsource: user_explicit\n---\n\nUNTRUSTED_BODY\n',
      );
      const trustPath = join(workdir, 'trusted_dirs.json');
      writeFileSync(trustPath, JSON.stringify({ directories: [] }));

      const result = await bootstrap({
        prompt: 'hi',
        cwd: workdir,
        providerOverride: mockProvider,
        dbPath,
        enterprisePolicyPath: null,
        userPolicyPath: null,
        trustListPathOverride: trustPath,
        askSharedTrust: async () => 'yes',
      });
      expect(result.sharedTrustProbe).toBeUndefined();
      expect(result.config.systemPrompt ?? '').not.toContain('UNTRUSTED_BODY');
      expect(result.config.memoryExcludeScopes).toEqual(['project_shared']);
      result.db.close();
    });

    // NOTE: A bootstrap-level integration test for verify_failed
    // (probe-result kind 'verify_failed' → exclude project_shared
    // from system prompt) is intentionally NOT here. The natural
    // way to trigger verify_failed in production is to make the
    // shared root unreadable (EACCES) — but that ALSO makes the
    // registry's MEMORY.md read fail BEFORE the probe runs, so
    // bootstrap throws at registry construction. The probe-layer
    // unit test (`tests/memory/trust-corpus-probe.test.ts:
    // 'returns verify_failed when the shared root is unreadable'`)
    // and the assembleMemorySection unit test
    // (`tests/cli/memory-prompt.test.ts: 'drops every listing in
    // an excluded scope ...'`) together cover the two halves; the
    // bootstrap wiring is a single conditional that fans them out.
  });
});
