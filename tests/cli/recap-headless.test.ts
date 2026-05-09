import { beforeEach, describe, expect, test } from 'bun:test';
import { runRecapHeadless } from '../../src/cli/recap-headless.ts';
import type {
  ConstrainedResult,
  Provider,
  ProviderCapabilities,
  StreamEvent,
} from '../../src/providers/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { completeSession, createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let stdout: string;
let stderr: string;

const out = (s: string): void => {
  stdout += s;
};
const err = (s: string): void => {
  stderr += s;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  stdout = '';
  stderr = '';
});

const stubCaps = (
  constrained: ProviderCapabilities['constrained'] = false,
): ProviderCapabilities => ({
  tools: 'native',
  cache: 'server_5min',
  vision: false,
  streaming: true,
  constrained,
  context_window: 200_000,
  output_max_tokens: 4_096,
  cost_per_1k_input: 1.0,
  cost_per_1k_output: 5.0,
  cost_per_1k_cached_input: 0.1,
  cost_per_1k_cache_write: 1.25,
  notes: [],
});

// Provider stub that fails the constrained capability gate so
// the headless flow always falls back to the deterministic
// renderer. Tests that exercise the LLM path can override.
const stubProvider = (): Provider => ({
  id: 'test/m',
  family: 'anthropic',
  capabilities: stubCaps(false),
  generate: async function* (): AsyncIterable<StreamEvent> {},
  generateConstrained: () => Promise.reject(new Error('not used in headless tests')),
  countTokens: async () => 0,
});

const seedSession = (id?: string): { id: string } => {
  const s = createSession(db, { model: 'sonnet', cwd: '/test/cwd', startedAt: 1_000 });
  appendMessage(db, {
    sessionId: s.id,
    role: 'user',
    content: 'do thing',
    createdAt: 1_100,
  });
  completeSession(db, s.id, 'done', 0.04, true, 2_000);
  return { id: id ?? s.id };
};

describe('runRecapHeadless — plain text mode', () => {
  test('renders deterministic human output for `recap session <id>`', async () => {
    const { id } = seedSession();
    const code = await runRecapHeadless({
      args: ['session', id],
      json: false,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 5_000,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('# Recap');
    expect(stdout).toContain('do thing');
    expect(stdout).toContain('## Cost');
    expect(stderr).toBe('');
  });

  test('returns non-zero and writes to stderr on parse error', async () => {
    const code = await runRecapHeadless({
      args: ['mystery'],
      json: false,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 5_000,
    });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown subcommand');
  });

  test('honors --out by writing the rendered output to the file', async () => {
    const { id } = seedSession();
    const tmp = `${process.env.TMPDIR ?? '/tmp'}/forja-recap-headless-${crypto.randomUUID()}/out.md`;
    const code = await runRecapHeadless({
      args: ['session', id, '--out', tmp],
      json: false,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 5_000,
    });
    expect(code).toBe(0);
    expect(stdout).toContain(`wrote human render to ${tmp}`);
    const written = await Bun.file(tmp).text();
    expect(written).toContain('# Recap');
  });

  test('rejects when no current session and no `session <id>` form', async () => {
    const code = await runRecapHeadless({
      args: [],
      json: false,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 5_000,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('no active session');
  });
});

describe('runRecapHeadless — --json mode (RECAP §9 NDJSON)', () => {
  test('emits 4 events with the documented shape and order', async () => {
    const { id } = seedSession();
    let tick = 1_000_000;
    const code = await runRecapHeadless({
      args: ['session', id],
      json: true,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => {
        tick += 250;
        return tick;
      },
    });
    expect(code).toBe(0);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(4);
    const events = lines.map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toEqual([
      'recap_start',
      'recap_intermediate',
      'recap_render',
      'recap_end',
    ]);
  });

  test('recap_start carries scope; recap_intermediate carries the full schema', async () => {
    const { id } = seedSession();
    await runRecapHeadless({
      args: ['session', id],
      json: true,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 7_777,
    });
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const start = JSON.parse(lines[0] ?? '{}') as {
      type: string;
      scope: { kind: string; sessionIds: string[] };
      ts: number;
    };
    expect(start.type).toBe('recap_start');
    expect(start.scope.kind).toBe('session_specific');
    expect(start.scope.sessionIds).toEqual([id]);
    expect(start.ts).toBe(7_777);

    const intermediate = JSON.parse(lines[1] ?? '{}') as {
      type: string;
      data: { schemaVersion: string; goal: { text: string } };
    };
    expect(intermediate.type).toBe('recap_intermediate');
    expect(intermediate.data.schemaVersion).toBe('v1');
    expect(intermediate.data.goal.text).toBe('do thing');
  });

  test('recap_render carries renderer name and output bytes', async () => {
    const { id } = seedSession();
    await runRecapHeadless({
      args: ['pr', 'session', id, '--no-llm-render'],
      json: true,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
    });
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const renderEv = JSON.parse(lines[2] ?? '{}') as {
      type: string;
      renderer: string;
      output: string;
    };
    expect(renderEv.type).toBe('recap_render');
    expect(renderEv.renderer).toBe('pr');
    expect(renderEv.output).toContain('## Summary');
  });

  test('recap_end carries duration_ms, used_llm, cost_usd', async () => {
    const { id } = seedSession();
    let tick = 0;
    await runRecapHeadless({
      args: ['session', id],
      json: true,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => {
        tick += 100;
        return tick;
      },
    });
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const endEv = JSON.parse(lines[3] ?? '{}') as {
      type: string;
      duration_ms: number;
      used_llm: boolean;
      cost_usd: number;
    };
    expect(endEv.type).toBe('recap_end');
    expect(endEv.duration_ms).toBeGreaterThan(0);
    expect(endEv.used_llm).toBe(false);
    expect(endEv.cost_usd).toBe(0);
  });
});

describe('runRecapHeadless — list passthrough', () => {
  test('`recap list` without --json prints the table to stdout', async () => {
    seedSession();
    const code = await runRecapHeadless({
      args: ['list'],
      json: false,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 5_000,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('STARTED');
    expect(stdout).toContain('do thing');
  });

  test('`recap list` with global --json appends --json to the list args (NDJSON of mini rows)', async () => {
    seedSession();
    const code = await runRecapHeadless({
      args: ['list'],
      json: true,
      dbOverride: db,
      provider: stubProvider(),
      out,
      err,
      now: () => 5_000,
    });
    expect(code).toBe(0);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { schemaVersion: string };
    expect(parsed.schemaVersion).toBe('mini-v1');
  });
});

describe('runRecapHeadless — LLM path with stub provider', () => {
  // Provider that DOES support constrained generation and returns
  // a valid PrRenderV1 payload — simulates a successful LLM render.
  const llmProvider = (output: string): Provider => ({
    id: 'anthropic/claude-haiku-4-5',
    family: 'anthropic',
    capabilities: stubCaps('tools'),
    generate: async function* () {},
    generateConstrained: async (): Promise<ConstrainedResult> => ({
      output,
      usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
    }),
    countTokens: async () => 0,
  });

  test('--json mode reflects used_llm:true when the LLM renders successfully', async () => {
    const { id } = seedSession();
    const stubPr = JSON.stringify({
      schemaVersion: 'pr-v1',
      summary: ['did the thing'],
      changes: [],
      testPlan: [],
      notes: [],
    });
    await runRecapHeadless({
      args: ['pr', 'session', id],
      json: true,
      dbOverride: db,
      provider: llmProvider(stubPr),
      out,
      err,
    });
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    const endEv = JSON.parse(lines[3] ?? '{}') as { used_llm: boolean; cost_usd: number };
    expect(endEv.used_llm).toBe(true);
    expect(endEv.cost_usd).toBeGreaterThan(0);
  });
});
