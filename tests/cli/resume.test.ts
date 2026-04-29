import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { OutputRenderer } from '../../src/cli/output/types.ts';
import { run } from '../../src/cli/run.ts';
import type { HarnessEvent } from '../../src/harness/index.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMessagesBySession } from '../../src/storage/repos/messages.ts';
import { getSession, listSessions, updateSessionCost } from '../../src/storage/repos/sessions.ts';

const baseArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: 'hi',
  json: false,
  version: false,
  help: false,
  plan: false,
  listSessions: false,
  ...overrides,
});

const recordingRenderer = (): { renderer: OutputRenderer; events: HarnessEvent[] } => {
  const events: HarnessEvent[] = [];
  return {
    events,
    renderer: { onEvent: (e) => events.push(e), flush: () => undefined },
  };
};

interface ScriptedStep {
  text?: string;
}
const replayStep = function* (step: ScriptedStep): Iterable<StreamEvent> {
  yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
  if (step.text !== undefined) yield { kind: 'text_delta', text: step.text };
  yield { kind: 'stop', reason: 'end_turn' };
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
      context_window: 1000,
      output_max_tokens: 100,
      cost_per_1k_input: 0,
      cost_per_1k_output: 0,
      notes: [],
    },
    async *generate() {
      const step = script[i++];
      if (step === undefined) throw new Error('mock script exhausted');
      for (const ev of replayStep(step)) yield ev;
    },
    generateConstrained: () => Promise.reject(new Error('n/a')),
    countTokens: () => Promise.resolve(0),
  };
};

let workdir: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-resume-'));
  dbPath = join(workdir, 'sessions.db');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const openTestDb = (): DB => {
  const d = openDb(dbPath);
  migrate(d);
  return d;
};

describe('--resume flow', () => {
  test('resume <id> reuses the same session id and appends new turns', async () => {
    // Run #1: create a session with one user prompt + one assistant reply.
    const { renderer: r1 } = recordingRenderer();
    await run({
      args: baseArgs({ prompt: 'first' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'first reply' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: r1,
    });
    db = openTestDb();
    const sessionsAfterFirst = listSessions(db, {});
    expect(sessionsAfterFirst).toHaveLength(1);
    const sessionId = sessionsAfterFirst[0]?.id;
    if (sessionId === undefined) throw new Error('expected one session');
    expect(sessionsAfterFirst[0]?.status).toBe('done');
    // Two messages persisted: user 'first' + assistant 'first reply'.
    const msgsAfterFirst = listMessagesBySession(db, sessionId);
    expect(msgsAfterFirst).toHaveLength(2);
    db.close();

    // Run #2: resume the same id with a follow-up.
    const { renderer: r2 } = recordingRenderer();
    const code = await run({
      args: baseArgs({ prompt: 'follow up', resume: sessionId }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'second reply' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: r2,
    });
    expect(code).toBe(0);

    db = openTestDb();
    // Session count is still 1 — resume reuses, doesn't create new.
    const sessionsAfterSecond = listSessions(db, {});
    expect(sessionsAfterSecond).toHaveLength(1);
    expect(sessionsAfterSecond[0]?.id).toBe(sessionId);
    expect(sessionsAfterSecond[0]?.status).toBe('done');
    // Messages: 2 from first run + 2 from second run = 4 total.
    // Position-independent assertion: ORDER BY created_at, id can
    // rank two messages with the same ms timestamp by UUID, which
    // is non-deterministic. Verify the follow-up landed by content
    // search rather than positional index.
    const msgsAfterSecond = listMessagesBySession(db, sessionId);
    expect(msgsAfterSecond).toHaveLength(4);
    expect(msgsAfterSecond.some((m) => m.role === 'user' && m.content === 'follow up')).toBe(true);
    expect(msgsAfterSecond.some((m) => m.role === 'user' && m.content === 'first')).toBe(true);
    db.close();
  });

  test("resume 'last' resolves to the most recent session", async () => {
    // Run #1.
    await run({
      args: baseArgs({ prompt: 'first' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'a' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    // Brief gap so timestamps differ. 20ms is conservative against
    // CI-machine clock-resolution noise (Date.now is 1ms-granular,
    // but two sessions starting within the same tick would tie on
    // the ORDER BY started_at DESC sort).
    await new Promise((r) => setTimeout(r, 20));

    // Run #2 (separate session).
    await run({
      args: baseArgs({ prompt: 'second' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'b' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    db = openTestDb();
    const sessionsBefore = listSessions(db, {});
    expect(sessionsBefore).toHaveLength(2);
    const newest = sessionsBefore[0]?.id;
    if (newest === undefined) throw new Error('expected newest session');
    db.close();

    // Resume 'last' should target the newest.
    await run({
      args: baseArgs({ prompt: 'continuing', resume: 'last' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'c' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    db = openTestDb();
    const sessionsAfter = listSessions(db, {});
    expect(sessionsAfter).toHaveLength(2); // still 2, resume reused
    // The newest session got new messages.
    const newestMsgs = listMessagesBySession(db, newest);
    expect(newestMsgs.some((m) => m.content === 'continuing')).toBe(true);
    db.close();
  });

  test("resume 'last' fails clean when no sessions exist", async () => {
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ prompt: 'continuing', resume: 'last' }),
      bootstrapOverride: { dbPath, cwd: workdir },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('no sessions');
  });

  test('resume with empty prompt is rejected', async () => {
    // Without a follow-up, the harness would loop on the prior
    // assistant message — useless. Forced error here keeps the
    // contract honest.
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ prompt: '', resume: 'last' }),
      bootstrapOverride: { dbPath, cwd: workdir },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('follow-up prompt');
  });

  test('resume with unknown id surfaces a clean error', async () => {
    // The harness throws 'session X not found' from getSession;
    // run() catches it and prints to errSink with exit 1.
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ prompt: 'continuing', resume: 'definitely-not-a-real-id' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'x' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('not found');
  });

  test('preserves total_cost_usd cumulatively across resume', async () => {
    // Regression: totalCostUsd is OVERWRITTEN by completeSession at
    // run-end. Without seeding the local accumulator from the
    // existing session row, a resumed run's UPDATE would clobber
    // the prior cumulative cost with just the resume's local total
    // (0 here, since the mock provider emits no usage). With the
    // seed, the prior $0.50 is preserved.
    await run({
      args: baseArgs({ prompt: 'first' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'a' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    db = openTestDb();
    const id = listSessions(db, {})[0]?.id;
    if (id === undefined) throw new Error('expected session');
    // Seed an artificial cumulative cost — simulates a real run
    // with usage events. The mock provider has no usage path, so
    // we inject what production would produce.
    updateSessionCost(db, id, 0.5);
    expect(getSession(db, id)?.totalCostUsd).toBe(0.5);
    db.close();

    await run({
      args: baseArgs({ prompt: 'follow up', resume: id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'b' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    db = openTestDb();
    // Without the seed, this would be 0.0 (clobbered). With the
    // seed, the prior $0.50 survives the resume.
    expect(getSession(db, id)?.totalCostUsd).toBe(0.5);
    db.close();
  });

  test('reopened session ends in done status after the resumed run completes', async () => {
    // Regression: completeSession has a WHERE status='running'
    // guard. reopenSession must flip the prior 'done' back so the
    // resumed run can finalize cleanly.
    await run({
      args: baseArgs({ prompt: 'first' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'a' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    db = openTestDb();
    const id = listSessions(db, {})[0]?.id;
    if (id === undefined) throw new Error('expected session');
    expect(getSession(db, id)?.status).toBe('done');
    db.close();

    await run({
      args: baseArgs({ prompt: 'follow', resume: id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'b' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    db = openTestDb();
    expect(getSession(db, id)?.status).toBe('done');
    db.close();
  });
});

describe('--list-sessions flow', () => {
  test('lists prior sessions in JSON mode (smoke through run())', async () => {
    // Use run() to drive the public CLI surface end-to-end.
    await run({
      args: baseArgs({ prompt: 'first' }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'a' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });

    // Capture stdout via a temporary write spy. run() writes to
    // process.stdout for list-sessions; for unit-test purposes we
    // call the underlying handler via run(args.listSessions=true)
    // and confirm exit code. The dedicated list-sessions.test.ts
    // covers output shape with a string sink.
    const code = await run({
      args: baseArgs({ listSessions: true, json: true }),
      bootstrapOverride: { dbPath },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    expect(code).toBe(0);
  });
});
