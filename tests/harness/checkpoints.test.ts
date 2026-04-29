import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectedStep } from '../../src/harness/collect.ts';
import { runAgent } from '../../src/harness/loop.ts';
import type { HarnessConfig, HarnessEvent } from '../../src/harness/types.ts';
import { createPermissionEngine } from '../../src/permissions/index.ts';
import type { Policy } from '../../src/permissions/index.ts';
import type { GenerateRequest, Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { insertCheckpoint, listCheckpointsBySession } from '../../src/storage/repos/checkpoints.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

interface ScriptedStep {
  text?: string;
  tool_uses?: { id: string; name: string; input: Record<string, unknown> }[];
  stop_reason?: CollectedStep['stop_reason'];
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
    async *generate(_req: GenerateRequest) {
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('not implemented')),
    countTokens: () => Promise.resolve(0),
  };
};

// Real-fs write tool. We need an actual filesystem mutation so the
// snapshot's write-tree picks up a diff and decides "yes, record this".
// A no-op tool that returns ok-without-writing would always be skipped
// by the manager's idempotent check.
const writeTool: Tool = {
  name: 'write_file',
  description: 'write content to a file under cwd',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  metadata: { category: 'fs.write', writes: true, idempotent: false },
  async execute(args, ctx) {
    const { path, content } = args as { path: string; content: string };
    await writeFile(join(ctx.cwd, path), content);
    return { ok: true };
  },
};

// Pseudo-bash tool. We don't actually invoke bash here — what matters
// to the harness's checkpoint trigger is the tool's NAME (the bash-
// family detection in loop.ts) plus the writes flag. A real fs write
// inside the body keeps the snapshot non-empty.
const bashTool: Tool = {
  name: 'bash',
  description: 'pseudo-bash for tests',
  inputSchema: {
    type: 'object',
    properties: { cmd: { type: 'string' } },
    required: ['cmd'],
  },
  metadata: { category: 'bash', writes: true, idempotent: false },
  async execute(_args, ctx) {
    await writeFile(join(ctx.cwd, 'bash-touched.txt'), 'side effect');
    return { ok: true };
  },
};

const policy = (p: Partial<Policy> = {}): Policy => ({
  defaults: { mode: 'bypass' },
  tools: {},
  ...p,
});

const initRepo = async (cwd: string): Promise<void> => {
  const proc = Bun.spawn({
    cmd: ['git', 'init', '-b', 'main'],
    cwd,
    env: {
      LC_ALL: 'C',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
};

const buildConfig = (input: {
  cwd: string;
  script: ScriptedStep[];
  tools: Tool[];
  enableCheckpoints?: boolean;
  checkpointsRetentionDays?: number;
  events?: HarnessEvent[];
  db: DB;
}): HarnessConfig => {
  const provider = mockProvider(input.script);
  const registry = createToolRegistry();
  for (const t of input.tools) registry.register(t);
  return {
    provider,
    toolRegistry: registry,
    permissionEngine: createPermissionEngine(policy(), { cwd: input.cwd }),
    db: input.db,
    cwd: input.cwd,
    userPrompt: 'go',
    ...(input.enableCheckpoints !== undefined
      ? { enableCheckpoints: input.enableCheckpoints }
      : {}),
    ...(input.checkpointsRetentionDays !== undefined
      ? { checkpointsRetentionDays: input.checkpointsRetentionDays }
      : {}),
    ...(input.events !== undefined
      ? {
          onEvent: (ev: HarnessEvent) => {
            input.events?.push(ev);
          },
        }
      : {}),
  };
};

let repo: string;
let db: DB;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'forja-loop-ckpt-'));
  db = openMemoryDb();
  migrate(db);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('harness checkpoint wiring', () => {
  test('enableCheckpoints undefined → no snapshots, no events', async () => {
    await initRepo(repo);
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [writeTool],
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const created = events.filter((e) => e.type === 'checkpoint_created');
    expect(created).toHaveLength(0);
    expect(listCheckpointsBySession(db, result.sessionId)).toHaveLength(0);
  });

  test('enableCheckpoints=true + non-git cwd → checkpoints_unavailable event, no snapshots', async () => {
    // No git init for this test — repo is a plain temp dir.
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [writeTool],
      enableCheckpoints: true,
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    expect(result.status).toBe('done');
    const unavailable = events.find((e) => e.type === 'checkpoints_unavailable');
    expect(unavailable).toBeDefined();
    if (unavailable !== undefined && unavailable.type === 'checkpoints_unavailable') {
      expect(unavailable.reason).toContain('not a git repository');
    }
    expect(events.filter((e) => e.type === 'checkpoint_created')).toHaveLength(0);
    expect(listCheckpointsBySession(db, result.sessionId)).toHaveLength(0);
  });

  test('enableCheckpoints=true + git cwd + write tool → snapshot recorded with had_bash=false', async () => {
    await initRepo(repo);
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [writeTool],
      enableCheckpoints: true,
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: 'a.txt', content: 'one' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    expect(result.status).toBe('done');

    const created = events.filter((e) => e.type === 'checkpoint_created');
    expect(created).toHaveLength(1);
    const ev = created[0];
    if (ev !== undefined && ev.type === 'checkpoint_created') {
      expect(ev.hadBash).toBe(false);
      expect(ev.checkpointId).toBeString();
      expect(ev.gitRef.length).toBe(40);
    }

    const rows = listCheckpointsBySession(db, result.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hadBash).toBe(false);
  });

  test('read-only step does NOT trigger a snapshot', async () => {
    await initRepo(repo);
    const echoTool: Tool = {
      name: 'echo',
      description: 'r/o',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      metadata: { category: 'misc', writes: false, idempotent: true },
      async execute(args) {
        return { echoed: (args as { msg: string }).msg };
      },
    };
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [echoTool],
      enableCheckpoints: true,
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'echo', input: { msg: 'hi' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    await runAgent(config);
    expect(events.filter((e) => e.type === 'checkpoint_created')).toHaveLength(0);
  });

  test('bash tool sets had_bash on the resulting checkpoint', async () => {
    await initRepo(repo);
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [bashTool],
      enableCheckpoints: true,
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'bash', input: { cmd: 'noop' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    const created = events.filter((e) => e.type === 'checkpoint_created');
    expect(created).toHaveLength(1);
    const ev = created[0];
    if (ev !== undefined && ev.type === 'checkpoint_created') {
      expect(ev.hadBash).toBe(true);
    }
    const rows = listCheckpointsBySession(db, result.sessionId);
    expect(rows[0]?.hadBash).toBe(true);
  });

  test('write tool that does NOT mutate the tree → snapshot is skipped (no-op)', async () => {
    await initRepo(repo);
    // Tool declares writes:true (so the harness fires the snapshot
    // path) but doesn't actually touch the filesystem. The manager's
    // defense-in-depth check compares the pre-step tree with the prior
    // snapshot's tree; equal trees ⇒ no row recorded. This is the
    // mechanic that protects against tools that LIE about writing,
    // and also against a refactor where the model decides to no-op
    // a step at the last moment.
    const noopWriteTool: Tool = {
      name: 'noop_write',
      description: 'declares writes:true but is a no-op',
      inputSchema: { type: 'object' },
      metadata: { category: 'fs.write', writes: true, idempotent: false },
      async execute() {
        return { ok: true };
      },
    };
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [noopWriteTool],
      enableCheckpoints: true,
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'noop_write', input: {} }],
          stop_reason: 'tool_use',
        },
        {
          tool_uses: [{ id: 'tu2', name: 'noop_write', input: {} }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    const created = events.filter((e) => e.type === 'checkpoint_created');
    // First step's snapshot captures the empty pre-tool tree (the only
    // checkpoint recorded). Second step's pre-tool tree is still empty
    // (the tool didn't write), matches the prior chain head, skipped.
    expect(created).toHaveLength(1);
    expect(listCheckpointsBySession(db, result.sessionId)).toHaveLength(1);
  });

  test('two write steps with different content → two snapshots', async () => {
    await initRepo(repo);
    const events: HarnessEvent[] = [];
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [writeTool],
      enableCheckpoints: true,
      events,
      script: [
        {
          tool_uses: [{ id: 'tu1', name: 'write_file', input: { path: 'a.txt', content: 'v1' } }],
          stop_reason: 'tool_use',
        },
        {
          tool_uses: [{ id: 'tu2', name: 'write_file', input: { path: 'a.txt', content: 'v2' } }],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    const created = events.filter((e) => e.type === 'checkpoint_created');
    expect(created).toHaveLength(2);
    const rows = listCheckpointsBySession(db, result.sessionId);
    expect(rows).toHaveLength(2);
  });

  test('lazy retention sweep drops aged-out checkpoints from prior sessions', async () => {
    await initRepo(repo);
    // Seed an aged-out row from a prior session. The sweep deletes
    // by created_at < cutoff regardless of which session owns the
    // row, so the orphan handling exercises the same path that
    // happens after a long-running install where prior session
    // ckpts have rotted past the retention horizon.
    const oldSessionId = createSession(db, { model: 'm', cwd: repo }).id;
    insertCheckpoint(db, {
      sessionId: oldSessionId,
      stepId: 'old-step',
      gitRef: 'aaa',
      hadBash: false,
      createdAt: 0, // epoch — well past any retentionDays cutoff
    });
    expect(listCheckpointsBySession(db, oldSessionId)).toHaveLength(1);

    // Run a no-op session (text-only step) with checkpoints enabled.
    // The sweep is fire-and-forget; we await runAgent which gives
    // the microtask queue time to drain so the deletion lands by
    // the time we assert.
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [],
      enableCheckpoints: true,
      checkpointsRetentionDays: 1,
      script: [{ text: 'done', stop_reason: 'end_turn' }],
    });
    await runAgent(config);
    // Yield once so any pending purge promise resolves before we
    // observe the row count. Without this yield the test races on
    // fast machines where the purge hasn't finished yet.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(listCheckpointsBySession(db, oldSessionId)).toHaveLength(0);
  });

  test('lazy sweep does not drop the current session even with retention=0', async () => {
    await initRepo(repo);
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [writeTool],
      enableCheckpoints: true,
      // 0 days = "anything older than now"; the new session's row
      // is created during the run with created_at = now, so it
      // still survives because the cutoff is `now - 0*86400e3 = now`
      // and rows with created_at = now are NOT < now.
      checkpointsRetentionDays: 0,
      script: [
        {
          tool_uses: [
            { id: 'tu1', name: 'write_file', input: { path: 'a.txt', content: 'fresh' } },
          ],
          stop_reason: 'tool_use',
        },
        { text: 'done', stop_reason: 'end_turn' },
      ],
    });
    const result = await runAgent(config);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listCheckpointsBySession(db, result.sessionId)).toHaveLength(1);
  });

  test('lazy sweep is silent when checkpoints are unavailable', async () => {
    // No initRepo — cwd isn't a git repo, sweep should be skipped.
    const oldSessionId = createSession(db, { model: 'm', cwd: repo }).id;
    insertCheckpoint(db, {
      sessionId: oldSessionId,
      stepId: 'old-step',
      gitRef: 'aaa',
      hadBash: false,
      createdAt: 0,
    });
    const config = buildConfig({
      cwd: repo,
      db,
      tools: [],
      enableCheckpoints: true,
      checkpointsRetentionDays: 1,
      script: [{ text: 'done', stop_reason: 'end_turn' }],
    });
    await runAgent(config);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The aged-out row is left in place because no manager-driven
    // purge ran (sweep only fires when git is available).
    expect(listCheckpointsBySession(db, oldSessionId)).toHaveLength(1);
  });
});
