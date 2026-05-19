// Regression: createDispatchRewrite is persisted AFTER invokeTool
// creates the tool_calls row. The previous ordering passed `tu.id`
// (the provider's tool_use id, NOT tool_calls.id which invokeTool
// generates as a separate UUID) — the FK on
// dispatch_rewrites.tool_call_id → tool_calls.id refused every
// INSERT and the structured audit row never landed.

import { beforeEach, describe, expect, test } from 'bun:test';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessConfig } from '../../src/harness/types.ts';
import { initBashParser } from '../../src/permissions/bash-parser.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listDispatchRewritesBySession } from '../../src/storage/repos/dispatch-rewrites.ts';
import { createPolicy } from '../../src/storage/repos/policies.ts';
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
    id: 'mock/rewrite',
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

// Bash stub. `name: 'bash'` is what triggers the rewrite path in the
// loop; the execute body is a no-op — we don't need real shell
// behavior to verify the audit row landed. `planSafe: () => true`
// keeps plan-mode tests (if any consume this stub) honest, though
// the rewrite path doesn't depend on it.
const bashStub: Tool = {
  name: 'bash',
  description: 'bash stub for rewrite audit tests',
  inputSchema: { type: 'object' },
  metadata: {
    category: 'bash',
    writes: true,
    planSafe: true,
    idempotent: false,
  },
  async execute(args: unknown) {
    return { ok: true, ran: (args as { command?: string }).command };
  },
};

let db: DB;

beforeEach(async () => {
  db = openMemoryDb();
  migrate(db);
  // bash resolver needs the tree-sitter parser ready before the
  // permission engine can decompose any bash command. Other harness
  // tests that exercise real bash resolve this in their own setup;
  // we mirror the pattern.
  await initBashParser();
});

describe('harness dispatch_rewrite audit persistence', () => {
  test('rewrite audit row lands with the tool_calls.id (not the provider tool_use id)', async () => {
    // Active global policy: alias:grep:ripgrep. The resolver walks
    // session → repo → user → language → global and finds this on
    // the last step regardless of the operator's scope chain.
    createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: JSON.stringify({ target: 'ripgrep' }),
      state: 'active',
    });

    const registry = createToolRegistry();
    registry.register(bashStub);
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'provider-tu-001', name: 'bash', input: { command: 'grep foo src/' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      // Bypass mode skips the bash AST resolver — we only need the
      // dispatch-rewrite + invokeTool path here, not the permission
      // engine's full bash decomposition.
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' }, tools: {} },
        { cwd: process.cwd() },
      ),
      db,
      cwd: process.cwd(),
      userPrompt: 'rewrite audit test',
      budget: { maxSteps: 5 },
    };

    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const rewrites = listDispatchRewritesBySession(db, result.sessionId);
    expect(rewrites).toHaveLength(1);
    const row = rewrites[0];
    if (row === undefined) throw new Error('expected one dispatch_rewrites row');

    // Original / rewritten captured correctly.
    expect(row.originalCommand).toBe('grep foo src/');
    expect(row.rewrittenCommand).toBe('ripgrep foo src/');
    expect(row.actionSignature).toBe('alias:grep:ripgrep');
    expect(row.matchedScope).toBe('global');

    // Critical: tool_call_id is the tool_calls.id (UUID), NOT the
    // provider's tu.id ('provider-tu-001'). The previous ordering
    // hit the FK and the catch path stderr-logged silently.
    expect(row.toolCallId).not.toBe('provider-tu-001');
    expect(row.toolCallId.length).toBe(36); // UUID v4
  });

  test('no rewrite → no audit row (sanity)', async () => {
    // No policy. The rewrite path is a no-op; no audit row should land.
    const registry = createToolRegistry();
    registry.register(bashStub);
    const config: HarnessConfig = {
      provider: mockProvider([
        {
          tool_uses: [{ id: 'provider-tu-002', name: 'bash', input: { command: 'ls -la' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ]),
      toolRegistry: registry,
      permissionEngine: createPermissionEngine(
        { defaults: { mode: 'bypass' }, tools: {} },
        { cwd: process.cwd() },
      ),
      db,
      cwd: process.cwd(),
      userPrompt: 'no-rewrite test',
      budget: { maxSteps: 5 },
    };
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const rewrites = listDispatchRewritesBySession(db, result.sessionId);
    expect(rewrites).toEqual([]);
  });
});
