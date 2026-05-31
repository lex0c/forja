// End-to-end eval: `agent init` scaffolds files → `bootstrap` reads
// them → engine reaches `ready` with the scaffolded values flowing
// through every loader. See `evals/init/README.md` for what this
// pins (and what it doesn't).
//
// Each scenario uses a fresh tmpdir + a mock provider override so
// no actual API call fires. The interesting assertion is the
// CROSS-SUBSYSTEM handshake (init writes ↔ bootstrap reads), not
// any single loader's behavior.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../../src/cli/bootstrap.ts';
import { runInit } from '../../src/cli/init.ts';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/loaders.ts';
import { DEFAULT_BUDGET } from '../../src/harness/types.ts';
import { DEFAULT_MODEL } from '../../src/providers/default-model.ts';
import type { Provider } from '../../src/providers/index.ts';

// Mock provider: bootstrap walks the model lookup but we never
// dispatch a real call, so the capabilities only need to be
// shape-valid. `providerOverride` short-circuits the registry
// lookup so the harness ignores whatever `[providers].model`
// resolves to at the runtime layer — the eval still verifies
// modelId rendering / scaffold contents though.
const mockProvider: Provider = {
  id: 'mock/init-eval',
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
  // biome-ignore lint/correctness/useYield: never reached
  async *generate() {
    throw new Error('not used in eval');
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
};

const FIXTURE_PLAYBOOKS = [
  {
    filename: 'fixture-a.md',
    content: `---
name: fixture-a
description: Stub A
tools: []
budget: { max_steps: 1, max_cost_usd: 0.01 }
---
Body A.`,
  },
];

let workdir: string;
let dbPath: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-init-eval-'));
  dbPath = join(workdir, 'sessions.db');
  // Isolate user-scope config + memory under the workdir so the
  // developer's real ~/.config/agent doesn't bleed into the eval
  // (mirrors bootstrap.test.ts hygiene).
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = workdir;
  process.env.HOME = workdir;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

const collectingSinks = () => {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    outBuf,
    errBuf,
    out: (s: string) => outBuf.push(s),
    err: (s: string) => errBuf.push(s),
  };
};

describe('init → bootstrap eval', () => {
  test('default init scaffolds all four artifacts; bootstrap reaches ready and reads them', async () => {
    const sinks = collectingSinks();
    const initCode = runInit({
      cwd: workdir,
      mode: 'strict',
      playbookSource: FIXTURE_PLAYBOOKS,
      out: sinks.out,
      err: sinks.err,
    });
    expect(initCode).toBe(0);
    // Bootstrap reads .agent/config.toml; the per-key merge in
    // bootstrap (CLI > project > user > DEFAULT) should land the
    // scaffolded project values into HarnessConfig.
    const {
      config,
      db,
      modelId,
      providersConfigWarnings,
      budgetConfigWarnings,
      memoryConfigWarnings,
      auditConfigWarnings,
      permissionState,
    } = await bootstrap({
      prompt: 'eval probe',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    try {
      // Engine reached ready — the scaffolded permissions.yaml
      // parsed clean.
      expect(permissionState).toBe('ready');
      // Scaffold pinned the model in config.toml; bootstrap picked
      // it up.
      expect(modelId).toBe(DEFAULT_MODEL);
      // Budget partial flowed in from config; effectiveBudget (in
      // the harness) will merge with DEFAULT_BUDGET at runtime,
      // but the partial visible on HarnessConfig.budget already
      // carries the scaffolded values. Explicit `toBeDefined`
      // guards the optional-chain assertions below — without it,
      // `config.budget === undefined` would make every
      // `?.maxSteps` resolve to undefined and the toBe checks
      // silently flag the values as missing instead of failing the
      // structural pin.
      expect(config.budget).toBeDefined();
      expect(config.budget?.maxSteps).toBe(DEFAULT_BUDGET.maxSteps);
      expect(config.budget?.maxCostUsd).toBe(DEFAULT_BUDGET.maxCostUsd);
      // Memory governance: scaffolded `true` for all three (matches
      // DEFAULT_MEMORY_CONFIG). The resolved field on HarnessConfig
      // mirrors the loader output.
      expect(config.memorySemanticVerify).toBe(DEFAULT_MEMORY_CONFIG.verifySemanticLlm);
      expect(config.memoryConflictDetect).toBe(DEFAULT_MEMORY_CONFIG.conflictDetectLlm);
      expect(config.memoryOverrideDetect).toBe(DEFAULT_MEMORY_CONFIG.overrideDetectLlm);
      // No loader complained about the scaffold values — the cross-
      // subsystem handshake is clean.
      expect(providersConfigWarnings).toEqual([]);
      expect(budgetConfigWarnings).toEqual([]);
      expect(memoryConfigWarnings).toEqual([]);
      // [audit] / [audit.retention] not scaffolded by init — loader
      // returns defaults silently with no warnings.
      expect(auditConfigWarnings).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('--only=permissions,config: partial scaffold still boots to ready', async () => {
    // Operator who wants policy + config but not playbooks. The
    // scaffold should produce a working bootstrap — missing
    // playbooks must not refuse boot.
    const sinks = collectingSinks();
    const initCode = runInit({
      cwd: workdir,
      mode: 'strict',
      only: ['permissions', 'config'],
      out: sinks.out,
      err: sinks.err,
    });
    expect(initCode).toBe(0);
    const { db, modelId, permissionState } = await bootstrap({
      prompt: 'eval probe',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    try {
      expect(permissionState).toBe('ready');
      // [providers].model from the scaffolded config still drives
      // resolution even on the partial scaffold.
      expect(modelId).toBe(DEFAULT_MODEL);
    } finally {
      db.close();
    }
  });

  test('re-run idempotency: second init is a no-op, bootstrap stays consistent', async () => {
    const sinks1 = collectingSinks();
    runInit({
      cwd: workdir,
      mode: 'strict',
      playbookSource: FIXTURE_PLAYBOOKS,
      out: sinks1.out,
      err: sinks1.err,
    });
    // Snapshot the scaffolded content for byte-for-byte comparison
    // post-second-init. If the second run somehow re-wrote the
    // file with different content (e.g., DEFAULT_BUDGET drift mid-
    // process — implausible but worth pinning), this catches it.
    const beforePerm = readFileSync(join(workdir, '.agent', 'permissions.yaml'), 'utf8');
    const beforeConfig = readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8');
    const beforeGitignore = readFileSync(join(workdir, '.agent', '.gitignore'), 'utf8');
    const beforePlaybook = readFileSync(join(workdir, '.agent', 'agents', 'fixture-a.md'), 'utf8');

    const sinks2 = collectingSinks();
    const code2 = runInit({
      cwd: workdir,
      mode: 'strict',
      playbookSource: FIXTURE_PLAYBOOKS,
      out: sinks2.out,
      err: sinks2.err,
    });
    expect(code2).toBe(0);
    expect(sinks2.outBuf.join('')).toContain('skipped');
    expect(readFileSync(join(workdir, '.agent', 'permissions.yaml'), 'utf8')).toBe(beforePerm);
    expect(readFileSync(join(workdir, '.agent', 'config.toml'), 'utf8')).toBe(beforeConfig);
    expect(readFileSync(join(workdir, '.agent', '.gitignore'), 'utf8')).toBe(beforeGitignore);
    expect(readFileSync(join(workdir, '.agent', 'agents', 'fixture-a.md'), 'utf8')).toBe(
      beforePlaybook,
    );

    // And bootstrap still reaches ready against the unchanged
    // scaffold.
    const { db, permissionState } = await bootstrap({
      prompt: 'eval probe',
      cwd: workdir,
      providerOverride: mockProvider,
      dbPath,
      enterprisePolicyPath: null,
      userPolicyPath: null,
    });
    try {
      expect(permissionState).toBe('ready');
    } finally {
      db.close();
    }
  });
});
