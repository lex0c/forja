import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArgs } from '../../src/cli/args.ts';
import type { OutputRenderer } from '../../src/cli/output/types.ts';
import { run } from '../../src/cli/run.ts';
import type { HarnessEvent } from '../../src/harness/index.ts';
import type { Provider, ProviderMessage, StreamEvent } from '../../src/providers/index.ts';
import { type DB, openDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendMessage, listMessagesBySession } from '../../src/storage/repos/messages.ts';
import {
  createSession,
  getSession,
  listSessions,
  updateSessionCost,
} from '../../src/storage/repos/sessions.ts';

const baseArgs = (overrides: Partial<ParsedArgs> = {}): ParsedArgs => ({
  prompt: 'hi',
  json: false,
  version: false,
  help: false,
  plan: false,
  listSessions: false,
  includeSubagents: false,
  yes: false,
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
    // Migration 007 made the order strictly insertion-deterministic
    // (seq column, populated at INSERT time), so we can assert
    // positionally now: [user 'first', assistant 'first reply',
    // user 'follow up', assistant 'second reply']. Before the
    // migration, two appends in the same ms could swap on UUID lex.
    const msgsAfterSecond = listMessagesBySession(db, sessionId);
    expect(msgsAfterSecond).toHaveLength(4);
    expect(msgsAfterSecond[0]?.role).toBe('user');
    expect(msgsAfterSecond[0]?.content).toBe('first');
    expect(msgsAfterSecond[1]?.role).toBe('assistant');
    expect(msgsAfterSecond[2]?.role).toBe('user');
    expect(msgsAfterSecond[2]?.content).toBe('follow up');
    expect(msgsAfterSecond[3]?.role).toBe('assistant');
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

    // Migration 008's seq tiebreaker makes the order deterministic
    // even when two sessions start in the same ms tick — no sleep
    // needed for correctness, kept removed.

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

  test("resume 'last' is scoped to the current cwd", async () => {
    // Multi-repo regression: 'last' used to pick the newest
    // session GLOBALLY, then runAgent rejected it for cwd
    // mismatch. With the cwd filter, 'last' resolves to the
    // newest session FOR THIS cwd, so the user gets the
    // "continue this project's latest run" UX they expect.
    const otherCwd = mkdtempSync(join(tmpdir(), 'forja-resume-other-'));
    try {
      // Newer session in a DIFFERENT cwd. listSessions ordered by
      // (started_at DESC, seq DESC) — so this would be the first
      // result globally without the filter.
      const setupDb = openDb(dbPath);
      migrate(setupDb);
      createSession(setupDb, { model: 'mock/m', cwd: otherCwd });
      setupDb.close();

      // Slightly older session in OUR cwd. We expect 'last' to
      // find this one because the global newest belongs to
      // otherCwd.
      await run({
        args: baseArgs({ prompt: 'this-cwd-prompt' }),
        bootstrapOverride: {
          providerOverride: mockProvider([{ text: 'a' }]),
          dbPath,
          cwd: workdir,
        },
        signal: new AbortController().signal,
        rendererOverride: recordingRenderer().renderer,
      });

      db = openTestDb();
      const allSessions = listSessions(db, {});
      // Two sessions exist; the otherCwd one is newer.
      expect(allSessions).toHaveLength(2);
      const ourSession = allSessions.find((s) => s.cwd === workdir);
      if (ourSession === undefined) throw new Error('expected our-cwd session');
      db.close();

      // Now resume 'last' from workdir — should land on ourSession,
      // not the otherCwd session (which would fail cwd guard).
      const code = await run({
        args: baseArgs({ prompt: 'continuing', resume: 'last' }),
        bootstrapOverride: {
          providerOverride: mockProvider([{ text: 'b' }]),
          dbPath,
          cwd: workdir,
        },
        signal: new AbortController().signal,
        rendererOverride: recordingRenderer().renderer,
      });
      expect(code).toBe(0);

      db = openTestDb();
      // Our session got new messages (resume worked).
      const ourMsgs = listMessagesBySession(db, ourSession.id);
      expect(ourMsgs.some((m) => m.content === 'continuing')).toBe(true);
      db.close();
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  test("resume 'last' skips subagent rows", async () => {
    // M3 regression. Subagent sessions live in the same `sessions`
    // table linked via `parent_session_id`. `resolveResumeId` calls
    // `listSessions(db, {limit:1, cwd})`, which defaults to
    // `includeSubagents:false`. A user typing `--resume last` after
    // a subagent run should land on the PARENT, not the most recent
    // subagent child — the child has no follow-up semantics anyway.
    // This locks the contract so a future refactor that flips the
    // default doesn't silently change `--resume last` behavior.
    db = openTestDb();
    const parent = createSession(db, {
      model: 'mock/m',
      cwd: workdir,
      startedAt: 1000,
    });
    appendMessage(db, { sessionId: parent.id, role: 'user', content: 'parent prompt' });
    // Subagent session — newer started_at, but should be ignored
    // by --resume last because it's a child.
    createSession(db, {
      model: 'mock/m',
      cwd: workdir,
      parentSessionId: parent.id,
      startedAt: 9999,
    });
    db.close();

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
    const parentMsgs = listMessagesBySession(db, parent.id);
    // The "continuing" prompt landed on the PARENT, not the child.
    expect(parentMsgs.some((m) => m.content === 'continuing')).toBe(true);
    db.close();
  });

  test("resume 'last' fails clean when no sessions exist for this cwd", async () => {
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ prompt: 'continuing', resume: 'last' }),
      bootstrapOverride: { dbPath, cwd: workdir },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    const out = errLines.join('');
    expect(out).toContain('no sessions');
    // Error message names the cwd that was searched, so the user
    // sees why 'last' didn't find anything.
    expect(out).toContain(workdir);
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

  test('resume in a different cwd is rejected with a clear error', async () => {
    // Silent cwd divergence is dangerous — the model resumes a
    // conversation that referenced files in cwd A, but bash calls
    // run in cwd B. Refuse so the user fixes it deliberately.
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
    db.close();

    // Resume in a DIFFERENT cwd.
    const otherDir = mkdtempSync(join(tmpdir(), 'forja-resume-other-'));
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ prompt: 'follow', resume: id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'b' }]),
        dbPath,
        cwd: otherDir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    rmSync(otherDir, { recursive: true, force: true });
    // The harness throws inside runAgent's init; runAgent catches
    // it via guardedFinish and surfaces as internalError exit (1).
    expect(code).toBe(1);
    // Best signal we can verify here: the run did NOT succeed.
    // The detail is on session_finished's result.detail; renderers
    // would surface it. errLines might be empty in this path
    // because the throw is converted to a result, not propagated
    // to the run.ts catch block.
  });

  test('preflight DB failure routes through errSink (does not throw)', async () => {
    // Regression: --list-sessions and resume preflight executed
    // BEFORE the run() try/catch. If openDb / migrate threw (e.g.,
    // unreadable path), the exception escaped run() instead of
    // surfacing as exit 1 + 'forja: ...' on errSink — breaking
    // the contract that run() always returns a number.
    //
    // Force a failure by pointing dbPath at a path that can't be
    // opened: a directory (sqlite open expects a file). bun:sqlite
    // throws on this; the test verifies the throw lands in run()'s
    // top-level catch.
    const errLines: string[] = [];
    const code = await run({
      args: baseArgs({ listSessions: true }),
      bootstrapOverride: { dbPath: workdir }, // workdir is a directory, not a file
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
      errSink: (s) => errLines.push(s),
    });
    expect(code).toBe(1);
    expect(errLines.join('')).toContain('forja:');
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

  test('resume tolerates persisted tool_use referencing a tool that no longer exists', async () => {
    // Real-world scenario: original session called tool 'bash';
    // the codebase changed and 'bash' was removed from the
    // registry. The persisted log still has assistant messages
    // with `tool_use { name: 'bash', ... }`. Resume replays the
    // log, the model sees the historical tool_use and may try to
    // call 'bash' again — registry returns "not found", harness
    // emits a tool error, model recovers.
    //
    // The minimum bar: resume init does not crash on the
    // persisted shape, AND the run completes without the harness
    // bailing out from a missing tool reference.
    const setupDb = openDb(dbPath);
    migrate(setupDb);
    const s = createSession(setupDb, { model: 'mock/m', cwd: workdir });
    const userMsg = appendMessage(setupDb, {
      sessionId: s.id,
      role: 'user',
      content: 'find files',
    });
    appendMessage(setupDb, {
      sessionId: s.id,
      role: 'assistant',
      content: [
        // Reference a tool name that may or may not exist in the
        // current registry. The harness builds tool defs from the
        // CURRENT registry, but the persisted log is replayed.
        { type: 'tool_use', id: 'tu-historical-1', name: 'definitely_not_a_real_tool', input: {} },
      ],
      parentId: userMsg.id,
    });
    appendMessage(setupDb, {
      sessionId: s.id,
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu-historical-1',
          content: 'historical result',
        },
      ],
    });
    setupDb.close();

    // Mock provider that simply produces a text reply (doesn't try
    // to call the unknown tool again — that path is independent of
    // resume's responsibility).
    const code = await run({
      args: baseArgs({ prompt: 'continue', resume: s.id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'continuing without that tool' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    expect(code).toBe(0);
  });

  test('resume reloads full DB log even when prior run had compacted in-memory', async () => {
    // Compaction modifies the in-memory `messages` array but DOES
    // NOT mutate the DB — every appendMessage persists the
    // ORIGINAL turn. So a session that compacted heavily during
    // its run still has the full uncompacted log on disk; resume
    // reloads it raw, gated only by MAX_RESUME_MESSAGES. Verify
    // by simulating the post-compaction state (full DB log) and
    // confirming resume runs the loop without crashing on the
    // size discrepancy.
    const setupDb = openDb(dbPath);
    migrate(setupDb);
    const s = createSession(setupDb, { model: 'mock/m', cwd: workdir });
    appendMessage(setupDb, { sessionId: s.id, role: 'user', content: 'goal' });
    // Build a long alternating tail (~80 turns = 161 messages)
    // representative of a session where compaction already ran
    // multiple times in-memory.
    let parent: string | null = null;
    const goalMsg = listMessagesBySession(setupDb, s.id)[0];
    if (goalMsg !== undefined) parent = goalMsg.id;
    for (let i = 0; i < 80; i++) {
      const a = appendMessage(setupDb, {
        sessionId: s.id,
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${i}` }],
        ...(parent !== null ? { parentId: parent } : {}),
      });
      const u = appendMessage(setupDb, {
        sessionId: s.id,
        role: 'user',
        content: 'continue',
        parentId: a.id,
      });
      parent = u.id;
    }
    setupDb.close();

    const code = await run({
      args: baseArgs({ prompt: 'final follow-up', resume: s.id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'ack' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    expect(code).toBe(0);

    // Persisted log grew by 2 (new user prompt + assistant reply);
    // the size discrepancy didn't break anything.
    db = openTestDb();
    const total = listMessagesBySession(db, s.id).length;
    expect(total).toBe(1 + 80 * 2 + 2);
    db.close();
  });

  test('repeated stranded resumes do not accumulate alternation violations', async () => {
    // Direct integration: simulate the post-state of three
    // aborted resumes by appending three consecutive user
    // messages to a session row, then resume normally. Without
    // the internal-pair repair, the provider sees user,user,
    // user,assistant_placeholder,user_new — strict-alternation
    // providers reject. With repair, every internal user→user
    // pair has a synthetic assistant inserted, so the provider
    // receives clean user→assistant alternation.
    const setupDb = openDb(dbPath);
    migrate(setupDb);
    const s = createSession(setupDb, { model: 'mock/m', cwd: workdir });
    appendMessage(setupDb, { sessionId: s.id, role: 'user', content: 'original goal' });
    appendMessage(setupDb, { sessionId: s.id, role: 'user', content: 'aborted resume A' });
    appendMessage(setupDb, { sessionId: s.id, role: 'user', content: 'aborted resume B' });
    setupDb.close();

    const seenMessages: ProviderMessage[][] = [];
    const recordingProvider: Provider = {
      ...mockProvider([{ text: 'recovered' }]),
      async *generate(req) {
        seenMessages.push(req.messages);
        yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
        yield { kind: 'text_delta', text: 'recovered' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };

    const code = await run({
      args: baseArgs({ prompt: 'final follow up', resume: s.id }),
      bootstrapOverride: { providerOverride: recordingProvider, dbPath, cwd: workdir },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    expect(code).toBe(0);

    // Assert no two consecutive user messages on the wire.
    const firstCall = seenMessages[0];
    if (firstCall === undefined) throw new Error('expected provider call');
    for (let i = 1; i < firstCall.length; i++) {
      const prev = firstCall[i - 1];
      const curr = firstCall[i];
      if (prev?.role === 'user' && curr?.role === 'user') {
        throw new Error(`consecutive user messages at indices ${i - 1}, ${i} — alternation broken`);
      }
    }
  });

  test('resume of session with only a user message (no assistant)', async () => {
    // Edge case: prior run crashed/aborted before the model
    // produced any assistant turn — persisted log is just
    // [user_root]. Resume appends [user_root, user_followup] in
    // memory, which violates the user→assistant→user alternation
    // every provider expects. Without explicit handling, the
    // first generate() call after resume 400s.
    //
    // Setup the corrupt-shape session directly via storage so we
    // don't have to script a crash in the harness.
    const setupDb = openDb(dbPath);
    migrate(setupDb);
    const s = createSession(setupDb, { model: 'mock/m', cwd: workdir });
    appendMessage(setupDb, { sessionId: s.id, role: 'user', content: 'crashed prompt' });
    setupDb.close();

    // Capture what the mock provider sees on its first generate.
    // If alternation is broken, we'd see two consecutive user
    // messages at the start.
    const seenMessages: ProviderMessage[][] = [];
    const recordingProvider: Provider = {
      ...mockProvider([{ text: 'recovered' }]),
      async *generate(req) {
        seenMessages.push(req.messages);
        yield { kind: 'start', message_id: `mock_${crypto.randomUUID()}` };
        yield { kind: 'text_delta', text: 'recovered' };
        yield { kind: 'stop', reason: 'end_turn' };
      },
    };

    const code = await run({
      args: baseArgs({ prompt: 'continuing', resume: s.id }),
      bootstrapOverride: { providerOverride: recordingProvider, dbPath, cwd: workdir },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    expect(code).toBe(0);

    // Inspect what the provider received on its first call.
    const firstCallMsgs = seenMessages[0];
    if (firstCallMsgs === undefined) throw new Error('expected provider call');
    // The roles must alternate user → assistant → user → ...
    // (or at minimum, no two consecutive same-role messages).
    for (let i = 1; i < firstCallMsgs.length; i++) {
      const prev = firstCallMsgs[i - 1];
      const curr = firstCallMsgs[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr.role).not.toBe(prev.role);
      }
    }
  });

  test('resume of a session with no persisted messages does not crash', async () => {
    // Edge case: a session row exists but appendMessage never ran
    // (e.g., bootstrap created the session and the harness aborted
    // before the user prompt landed). Resume should treat this as
    // an empty conversation — the new userMsg becomes the root
    // (parent_id=null) instead of failing or referencing a tail
    // that doesn't exist.
    const setupDb = openDb(dbPath);
    migrate(setupDb);
    const s = createSession(setupDb, { model: 'mock/m', cwd: workdir });
    setupDb.close();

    const code = await run({
      args: baseArgs({ prompt: 'first message', resume: s.id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'a' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: recordingRenderer().renderer,
    });
    expect(code).toBe(0);

    db = openTestDb();
    const msgs = listMessagesBySession(db, s.id);
    expect(msgs).toHaveLength(2);
    // The prompt is the chain root since there was no prior tail.
    expect(msgs[0]?.parentId).toBeNull();
    expect(msgs[0]?.content).toBe('first message');
    db.close();
  });

  test('parent_id chain is contiguous across resume boundaries', async () => {
    // Regression: the resumed user turn was appending with
    // parent_id=null, starting a NEW root chain in the same
    // session. Walking parent_id from any post-resume message
    // would dead-end at the resume boundary instead of climbing
    // back through the original conversation. Audit / replay /
    // any tree-walk got an inconsistent view.
    //
    // Now: the resume init seeds the new userMsg's parent_id with
    // the tail of the prior persisted log. Walking back from the
    // last message reaches the very first user prompt without a
    // null-parent break in the middle.
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
    const msgs = listMessagesBySession(db, id);
    expect(msgs).toHaveLength(4);
    // Build a parent->child map and walk from the last message
    // back to the root. Every link must resolve until we hit the
    // single null-parent root (the very first user prompt).
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const tail = msgs[msgs.length - 1];
    if (tail === undefined) throw new Error('expected tail');
    const visited: string[] = [];
    let cursor: typeof tail | undefined = tail;
    while (cursor !== undefined) {
      visited.push(cursor.id);
      if (cursor.parentId === null) break;
      const parent = byId.get(cursor.parentId);
      if (parent === undefined) throw new Error(`broken chain at ${cursor.id}`);
      cursor = parent;
    }
    // Visited every message exactly once — chain is contiguous.
    expect(visited.length).toBe(4);
    // Root is the original 'first' user prompt.
    const root = byId.get(visited[visited.length - 1] ?? '');
    expect(root?.role).toBe('user');
    expect(root?.content).toBe('first');
    expect(root?.parentId).toBeNull();
    db.close();
  });

  test('HarnessResult reports per-run cost; persistence stays cumulative', async () => {
    // Contract: HarnessResult.costUsd is THIS RUN's telemetry (so
    // it stays self-consistent with usage); the persisted
    // total_cost_usd column is the session's LIFETIME cost.
    // Earlier seeding of totalCostUsd from the row made costUsd
    // report cumulative while usage stayed per-run — broken
    // self-consistency.
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
    // Seed an artificial cumulative cost (simulating a prior run
    // with usage events that the mock provider can't emit).
    updateSessionCost(db, id, 0.5);
    db.close();

    const { renderer, events } = recordingRenderer();
    await run({
      args: baseArgs({ prompt: 'follow up', resume: id }),
      bootstrapOverride: {
        providerOverride: mockProvider([{ text: 'b' }]),
        dbPath,
        cwd: workdir,
      },
      signal: new AbortController().signal,
      rendererOverride: renderer,
    });

    // HarnessResult is delivered via session_finished. Its
    // costUsd reflects only this run (mock provider has no
    // usage path → 0 for the resume run).
    const finished = events[events.length - 1] as {
      type: 'session_finished';
      result: { costUsd: number; usage: { input: number; output: number } };
    };
    expect(finished.type).toBe('session_finished');
    expect(finished.result.costUsd).toBe(0);
    expect(finished.result.usage.input).toBe(0);
    expect(finished.result.usage.output).toBe(0);

    // Persistence stayed cumulative — the prior $0.50 survived.
    db = openTestDb();
    expect(getSession(db, id)?.totalCostUsd).toBe(0.5);
    db.close();
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
