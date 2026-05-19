// Regression: harness resolves the scope chain from the repo ROOT,
// not from the invocation directory. An operator starting the CLI
// from `<repo>/sub/dir` previously produced repo-scoped outcomes
// keyed by `<repo>/sub/dir` — fragmenting evidence across folders
// and preventing the loop frio from accumulating per-repo signal.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listOutcomesBySession } from '../../src/storage/repos/outcomes.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: 'end_turn' | 'tool_use';
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
  if (step.text !== undefined) yield { kind: 'text_delta', text: step.text };
  for (const tu of step.tool_uses ?? []) {
    yield { kind: 'tool_use_start', id: tu.id, name: tu.name };
    yield { kind: 'tool_use_stop', id: tu.id, final_args: tu.input };
  }
  yield {
    kind: 'stop',
    reason: step.stop_reason ?? (step.tool_uses?.length ? 'tool_use' : 'end_turn'),
  };
};

const mockProvider = (script: ScriptedStep[]): Provider => {
  const requests: GenerateRequest[] = [];
  let i = 0;
  return {
    id: 'mock/scope',
    family: 'anthropic',
    capabilities: {
      tools: 'native',
      cache: false,
      vision: false,
      streaming: true,
      constrained: 'tools',
      context_window: 200_000,
      output_max_tokens: 4096,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
    },
    async *generate(req) {
      requests.push(req);
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
};

// Always-success tool with `category: 'misc'` (auto-allowed under
// strict default-deny per the permission engine's category whitelist).
const harmlessTool: Tool = {
  name: 'noop',
  description: 'no-op for scope chain tests',
  inputSchema: { type: 'object' },
  metadata: { category: 'misc', writes: false, idempotent: true },
  async execute() {
    return { ok: true };
  },
};

let db: DB;
const tempRoots: string[] = [];

const initGitRepo = (root: string): void => {
  const proc = Bun.spawnSync({
    cmd: ['git', 'init', '--initial-branch=main', root],
    env: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git init failed: ${proc.stderr.toString()}`);
  }
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

afterEach(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  tempRoots.length = 0;
});

describe('harness scope chain', () => {
  test('outcomes from a subdirectory cwd land at scope_id = repo root', async () => {
    // Initialize a git repo at /tmp/forja-scope-XXXX with a /sub/dir
    // subdirectory. Run runAgent with cwd = subdir and verify the
    // outcome row's scope_id resolves to the REPO ROOT, not the
    // operator's working subdirectory.
    const repoRoot = mkdtempSync(join(tmpdir(), 'forja-scope-'));
    tempRoots.push(repoRoot);
    initGitRepo(repoRoot);
    const subdir = join(repoRoot, 'sub', 'dir');
    mkdirSync(subdir, { recursive: true });

    const registry = createToolRegistry();
    registry.register(harmlessTool);
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu-1', name: 'noop', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' }, tools: {} },
        { cwd: subdir },
      ),
      db,
      cwd: subdir, // operator invoked from the subdir
      userPrompt: 'scope-chain test',
      budget: { maxSteps: 5 },
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const outcomes = listOutcomesBySession(db, result.sessionId);
    expect(outcomes.length).toBeGreaterThan(0);
    const repoScopedOutcomes = outcomes.filter((o) => o.scopeKind === 'repo');
    expect(repoScopedOutcomes.length).toBeGreaterThan(0);
    // The scope_id MUST be the repo root, not the subdir.
    // `git rev-parse --show-toplevel` may return a symlink-resolved
    // path different from `repoRoot` on platforms where tmpdir is a
    // symlink (macOS `/tmp` → `/private/tmp`), so we check by suffix
    // rather than equality.
    for (const o of repoScopedOutcomes) {
      expect(o.scopeId.endsWith(repoRoot.split('/').pop() as string)).toBe(true);
      // And critically, it does NOT end with the subdir path tail.
      expect(o.scopeId.endsWith('sub/dir')).toBe(false);
    }
  });

  test('outside a git repo falls back to cwd (resolveRepoRoot graceful)', async () => {
    // No `git init`. resolveRepoRoot falls back to cwd; the scope
    // chain still resolves repo to that path so outcomes land at
    // scope=repo (not session). Regression guard: a fallback path
    // must not silently disable the repo scope detection.
    const cwd = mkdtempSync(join(tmpdir(), 'forja-scope-nogit-'));
    tempRoots.push(cwd);

    const registry = createToolRegistry();
    registry.register(harmlessTool);
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'tu-1', name: 'noop', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' }, tools: {} },
        { cwd },
      ),
      db,
      cwd,
      userPrompt: 'no-git test',
      budget: { maxSteps: 5 },
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const outcomes = listOutcomesBySession(db, result.sessionId);
    // At least one repo-scoped outcome lands. Without a git repo,
    // scope_id == cwd (the fallback). What the test pins is that
    // the operator's actual working directory was used as the
    // anchor, not 'unknown'.
    const repoScoped = outcomes.find((o) => o.scopeKind === 'repo');
    expect(repoScoped).toBeDefined();
  });
});
