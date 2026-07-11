// Slice 131 fixup #4: pin the tool_error wire in harness/loop.
// Pre-fixup the wire site had ZERO unit tests; a refactor
// reordering the `inv.failed && !denied && approvalSeq` guard
// could silently disable calibration capture.
//
// Uses the same mockProvider / replayStep pattern as
// tests/harness/loop.test.ts so the stream shape matches the
// provider contract the harness actually consumes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';
import { createSqliteOutcomeSink } from '../../src/outcomes/index.ts';
import {
  createPermissionEngine,
  createSqliteSink,
  ensureInstallId,
} from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/types.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { countSignalsByKindSince } from '../../src/storage/repos/outcome-signals.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import { type Tool, toolError } from '../../src/tools/types.ts';

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: 'end_turn' | 'tool_use';
}

const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
  if (step.text !== undefined && step.text.length > 0) {
    yield { kind: 'text_delta', text: step.text };
  }
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
  let i = 0;
  return {
    id: 'mock/m',
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
    async *generate(_req: GenerateRequest): AsyncIterable<StreamEvent> {
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
};

const failingTool: Tool<unknown, unknown> = {
  name: 'always_fails',
  description: 'always fails',
  inputSchema: { type: 'object' },
  metadata: { category: 'fs.read', writes: false, idempotent: false },
  async execute() {
    return toolError('test.fail', 'simulated failure');
  },
};

const succeedingTool: Tool<unknown, unknown> = {
  name: 'always_ok',
  description: 'always ok',
  inputSchema: { type: 'object' },
  metadata: { category: 'fs.read', writes: false, idempotent: true },
  async execute() {
    return { ok: true };
  },
};

let db: DB;
let tmp: string;

beforeEach(() => {
  db = openMemoryDb();
  migrate(db, MIGRATIONS);
  tmp = mkdtempSync(join(tmpdir(), 'forja-wire-tool-err-'));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const buildConfig = (
  toolName: string,
  tools: Tool[],
  policy: Policy,
  outcomeSink: ReturnType<typeof createSqliteOutcomeSink> | undefined,
): HarnessConfig => {
  const registry = createToolRegistry();
  for (const t of tools) registry.register(t);
  const identity = ensureInstallId({
    pathOverride: join(tmp, 'install_id'),
    now: () => 1,
    uuid: () => 'wire-test-uuid',
  });
  const auditSink = createSqliteSink({ db, identity });
  return {
    provider: mockProvider([
      { tool_uses: [{ id: 'tu1', name: toolName, input: {} }], stop_reason: 'tool_use' },
      { text: 'done', stop_reason: 'end_turn' },
    ]),
    toolRegistry: registry,
    permissionEngine: createPermissionEngine(policy, { cwd: tmp, audit: auditSink }),
    db,
    cwd: tmp,
    userPrompt: 'hi',
    ...(outcomeSink !== undefined ? { outcomeSink } : {}),
  };
};

const bypassPolicy: Policy = {
  defaults: { mode: 'bypass' },
  tools: {},
};

describe('tool_error wire (harness/loop)', () => {
  test('failed allowed tool → outcome_signal kind=tool_error', async () => {
    const outcomeSink = createSqliteOutcomeSink({ db });
    const config = buildConfig('always_fails', [failingTool], bypassPolicy, outcomeSink);
    await runAgent(config);
    // The wire emits one signal per failed tool call; the test
    // script has exactly one failing call.
    expect(countSignalsByKindSince(db, 'tool_error', 0)).toBeGreaterThanOrEqual(1);
  });

  test('succeeding tool → NO tool_error signal', async () => {
    const outcomeSink = createSqliteOutcomeSink({ db });
    const config = buildConfig('always_ok', [succeedingTool], bypassPolicy, outcomeSink);
    await runAgent(config);
    expect(countSignalsByKindSince(db, 'tool_error', 0)).toBe(0);
  });

  test('outcomeSink unwired → NO emit (back-compat)', async () => {
    const config = buildConfig('always_fails', [failingTool], bypassPolicy, undefined);
    await runAgent(config);
    expect(countSignalsByKindSince(db, 'tool_error', 0)).toBe(0);
  });
});
