import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSubagentChild } from '../../src/cli/subagent-child.ts';
import type { Provider, StreamEvent } from '../../src/providers/index.ts';
import { openDb } from '../../src/storage/db.ts';
import {
  appendMessage,
  createSession,
  getSubagentOutput,
  insertSubagentRun,
  migrate,
} from '../../src/storage/index.ts';

// Cover the canonical happy + error paths for the
// subagent-child entry. The test injects a `providerOverride`
// so we don't need an API key, and uses a real on-disk DB so
// the child + tests share the same SQLite path (mirrors what
// the real subprocess flow does).

let dbDir: string;
let dbPath: string;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'forja-child-test-'));
  dbPath = join(dbDir, 'agent.sqlite');
});

afterEach(() => {
  try {
    unlinkSync(dbPath);
  } catch {}
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {}
});

const stubProvider = (text: string): Provider => ({
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
  async *generate(): AsyncGenerator<StreamEvent> {
    yield { kind: 'start', message_id: 'mock-msg' };
    if (text.length > 0) yield { kind: 'text_delta', text };
    yield { kind: 'stop', reason: 'end_turn' };
  },
  generateConstrained: () => Promise.reject(new Error('n/a')),
  countTokens: () => Promise.resolve(0),
});

const seedChildSession = (cwd: string): { sessionId: string } => {
  const db = openDb(dbPath);
  try {
    migrate(db);
    const parent = createSession(db, { model: 'mock/m', cwd });
    const child = createSession(db, {
      model: 'mock/m',
      cwd,
      parentSessionId: parent.id,
    });
    insertSubagentRun(db, {
      sessionId: child.id,
      name: 'explore',
      scope: 'project',
      sourcePath: '/fake/explore.md',
      sourceSha256: 'a'.repeat(64),
      systemPrompt: 'You are explore.',
      toolsWhitelist: [],
      budgetMaxSteps: 5,
      budgetMaxCostUsd: 0.1,
    });
    appendMessage(db, {
      sessionId: child.id,
      role: 'user',
      content: 'find the README',
    });
    return { sessionId: child.id };
  } finally {
    db.close();
  }
};

describe('runSubagentChild', () => {
  test('happy path: runs harness, publishes done payload, exits 0', async () => {
    const { sessionId } = seedChildSession(dbDir);
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId,
      dbPath,
      providerOverride: stubProvider('hello world'),
      // Disable real permission hierarchy so the test doesn't
      // depend on the host's /etc/agent or ~/.config/agent state.
      enterprisePolicyPath: null,
      userPolicyPath: null,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(0);
    expect(errMessages).toEqual([]);
    // Payload landed on subagent_outputs.
    const db = openDb(dbPath);
    try {
      const out = getSubagentOutput(db, sessionId);
      expect(out?.payload).toBeDefined();
      expect(out?.payload?.status).toBe('done');
      expect(out?.payload?.output).toBe('hello world');
    } finally {
      db.close();
    }
  });

  test('non-existent session id surfaces a stderr line and exit 1', async () => {
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: 'never-existed',
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/session never-existed not found/);
  });

  test('non-subagent session refused (parent_session_id null)', async () => {
    const db = openDb(dbPath);
    let topLevelId: string;
    try {
      migrate(db);
      const top = createSession(db, { model: 'mock/m', cwd: dbDir });
      topLevelId = top.id;
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: topLevelId,
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/is not a subagent/);
  });

  test('missing audit row refused with explicit diagnostic', async () => {
    // Create a child session WITHOUT the subagent_runs row — the
    // child has no way to discover its definition (system prompt,
    // tools, budget) so it must refuse rather than guess.
    const db = openDb(dbPath);
    let childId: string;
    try {
      migrate(db);
      const parent = createSession(db, { model: 'mock/m', cwd: dbDir });
      const child = createSession(db, {
        model: 'mock/m',
        cwd: dbDir,
        parentSessionId: parent.id,
      });
      childId = child.id;
    } finally {
      db.close();
    }
    const errMessages: string[] = [];
    const exitCode = await runSubagentChild({
      sessionId: childId,
      dbPath,
      errSink: (s) => errMessages.push(s),
    });
    expect(exitCode).toBe(1);
    expect(errMessages.join('')).toMatch(/no subagent_runs row/);
  });
});
