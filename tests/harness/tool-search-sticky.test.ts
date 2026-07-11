import { beforeEach, describe, expect, test } from 'bun:test';
import { runAgent } from '../../src/harness/loop.ts';
import type { Policy } from '../../src/permissions/index.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { registerBuiltinTools } from '../../src/tools/builtin/index.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';

// Cross-turn stickiness of tool_search reveals (AGENTIC_CLI §7.6). The REPL
// re-runs runAgent per turn and injects ONE `revealedTools` Set; a tool revealed
// in turn 1 must still be on the surface in turn 2 WITHOUT re-searching. Drives
// the real loop with a scripted provider and captures the `tools` each provider
// call receives.

interface Step {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
}

function* replay(step: Step): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: 'm' };
  if (step.text) yield { kind: 'text_delta', text: step.text };
  for (const tu of step.tool_uses ?? []) {
    yield { kind: 'tool_use_start', id: tu.id, name: tu.name };
    yield { kind: 'tool_use_stop', id: tu.id, final_args: tu.input };
  }
  yield { kind: 'stop', reason: step.tool_uses?.length ? 'tool_use' : 'end_turn' };
}

// Provider that records the tool names it was offered on each call.
const recordingProvider = (script: Step[], offered: string[][]): Provider => {
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
      context_window: 100_000,
      output_max_tokens: 1000,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
    },
    async *generate(req) {
      offered.push((req.tools ?? []).map((t) => t.name));
      const step = script[i++];
      if (step === undefined) throw new Error('script exhausted');
      yield* replay(step);
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
};

const policy = (): Policy => ({ defaults: { mode: 'strict' }, tools: {} });

let db: DB;
beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
});

const baseCfg = (revealedTools: Set<string>) => {
  const toolRegistry = createToolRegistry();
  registerBuiltinTools(toolRegistry);
  return {
    toolRegistry,
    permissionEngine: createPermissionEngine(policy(), { cwd: '/p' }),
    db,
    cwd: '/p',
    revealedTools,
  };
};

describe('tool_search reveals are sticky across REPL turns', () => {
  test('a tool revealed in turn 1 is on the surface in turn 2 without re-searching', async () => {
    // ONE set, shared across both runAgent calls — exactly how the REPL injects it.
    const revealedTools = new Set<string>();

    // Turn 1: tool_search reveals the deferred `retrieve_context`, then ends.
    const t1Offered: string[][] = [];
    await runAgent({
      ...baseCfg(revealedTools),
      provider: recordingProvider(
        [
          {
            tool_uses: [
              { id: 't1', name: 'tool_search', input: { query: 'select:retrieve_context' } },
            ],
          },
          { text: 'done' },
        ],
        t1Offered,
      ),
      userPrompt: 'reveal it',
    });
    // The shared set persists the reveal beyond the run.
    expect(revealedTools.has('retrieve_context')).toBe(true);
    // Turn 1's FIRST provider call did not yet have it (deferred); the rebuilt
    // SECOND call did.
    expect(t1Offered[0]).not.toContain('retrieve_context');
    expect(t1Offered[1]).toContain('retrieve_context');

    // Turn 2: a fresh runAgent with the SAME set — retrieve_context is on the
    // surface from the first provider call, no tool_search needed.
    const t2Offered: string[][] = [];
    await runAgent({
      ...baseCfg(revealedTools),
      provider: recordingProvider([{ text: 'ok' }], t2Offered),
      userPrompt: 'use it',
    });
    expect(t2Offered[0]).toContain('retrieve_context');
  });

  test('without an injected set, a deferred tool is NOT on the surface (control)', async () => {
    const offered: string[][] = [];
    await runAgent({
      ...baseCfg(new Set<string>()),
      provider: recordingProvider([{ text: 'ok' }], offered),
      userPrompt: 'hi',
    });
    expect(offered[0]).toContain('tool_search');
    expect(offered[0]).not.toContain('retrieve_context');
  });
});
