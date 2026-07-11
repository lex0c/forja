// /agent policy slash tests (FEEDBACK_ADAPTATION §3.2 + §9.3).

import { beforeEach, describe, expect, test } from 'bun:test';
import { agentPolicyCommand } from '../../../src/cli/slash/commands/agent-policy.ts';
import type { SlashContext } from '../../../src/cli/slash/types.ts';
import type { HarnessConfig } from '../../../src/harness/index.ts';
import { DEFAULT_BUDGET } from '../../../src/harness/types.ts';
import { createRegistry as createModelRegistry } from '../../../src/providers/registry.ts';
import { type DB, openMemoryDb } from '../../../src/storage/db.ts';
import { migrate } from '../../../src/storage/migrate.ts';
import { createOutcome, type OutcomeResult } from '../../../src/storage/repos/outcomes.ts';
import { createPolicy, getPolicy, type Policy } from '../../../src/storage/repos/policies.ts';
import { createSession } from '../../../src/storage/repos/sessions.ts';
import { createBus } from '../../../src/tui/bus.ts';
import { createFocusStack } from '../../../src/tui/focus-stack.ts';
import { createModalManager } from '../../../src/tui/modal-manager.ts';

let db: DB;
let sessionId: string;
let nowMs: number;

const buildCtx = (overrides: Partial<SlashContext> = {}): SlashContext => {
  const bus = createBus();
  const focusStack = createFocusStack();
  const modalManager = createModalManager({ bus, focusStack, now: () => nowMs });
  const baseConfig = {
    cwd: '/p',
    enableCheckpoints: false,
    budget: { ...DEFAULT_BUDGET },
    provider: { id: 'test/m', capabilities: { context_window: 1000, output_max_tokens: 100 } },
  } as unknown as HarnessConfig;
  return {
    baseConfig,
    db,
    bus,
    modalManager,
    cumulative: { costUsd: 0, steps: 0, turns: 0 },
    now: () => nowMs,
    requestShutdown: () => {},
    isRunning: () => false,
    currentSessionId: () => sessionId,
    replSessionIds: () => [sessionId],
    modelRegistry: createModelRegistry(),
    ...overrides,
  };
};

const seedToolCall = (sid: string): string => {
  const msgId = crypto.randomUUID();
  const tcId = crypto.randomUUID();
  db.query(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'tool', '{}', ?)`,
  ).run(msgId, sid, Date.now());
  db.query(
    `INSERT INTO tool_calls (id, message_id, tool_name, input, status, created_at)
     VALUES (?, ?, 'bash', '{}', 'done', ?)`,
  ).run(tcId, msgId, Date.now());
  return tcId;
};

const seedSuccessOutcomes = (sig: string, n: number, scope = sessionId): void => {
  for (let i = 0; i < n; i++) {
    createOutcome(db, {
      sessionId,
      toolCallId: seedToolCall(sessionId),
      actionSignature: sig,
      tier: 1,
      result: 'success' as OutcomeResult,
      scopeKind: 'session',
      scopeId: scope,
      recordedAt: 1000 + i,
    });
  }
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  nowMs = 1_000_000;
});

describe('/agent policy summary', () => {
  test('reports zero policies with usage hint', async () => {
    const r = await agentPolicyCommand.exec(['policy'], buildCtx());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.notes?.[0]).toContain('no adaptation policies');
  });

  test('reports per-state counts when policies exist', async () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:find:fd',
      actionJson: '{}',
      state: 'active',
    });
    const r = await agentPolicyCommand.exec(['policy'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('policies (2 total)');
    expect(text).toContain('proposed: 1');
    expect(text).toContain('active: 1');
  });
});

describe('/agent policy list', () => {
  test('default groups by state', async () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:find:fd',
      actionJson: '{}',
      state: 'active',
    });
    const r = await agentPolicyCommand.exec(['policy', 'list'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('proposed (1):');
    expect(text).toContain('active (1):');
  });

  test('with state filter shows only that state', async () => {
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:find:fd',
      actionJson: '{}',
      state: 'active',
    });
    const r = await agentPolicyCommand.exec(['policy', 'list', 'active'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain("policies in state 'active' (1)");
    expect(text).toContain('alias:find:fd');
    expect(text).not.toContain('alias:grep:ripgrep');
  });

  test('invalid state arg rejected', async () => {
    const r = await agentPolicyCommand.exec(['policy', 'list', 'bogus'], buildCtx());
    expect(r.kind).toBe('error');
  });
});

describe('/agent policy promote', () => {
  test('proposed → active', async () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    const r = await agentPolicyCommand.exec(['policy', 'promote', p.id], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.[0]).toContain('promoted');
    const refetched = getPolicy(db, p.id);
    expect(refetched?.state).toBe('active');
  });

  test('short-prefix promote works', async () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    const prefix = p.id.slice(0, 8);
    const r = await agentPolicyCommand.exec(['policy', 'promote', prefix], buildCtx());
    expect(r.kind).toBe('ok');
    const refetched = getPolicy(db, p.id);
    expect(refetched?.state).toBe('active');
  });

  test('refuses promoting an already-active policy', async () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
    });
    const r = await agentPolicyCommand.exec(['policy', 'promote', p.id], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('illegal transition');
  });

  test('errors on no-match prefix', async () => {
    const r = await agentPolicyCommand.exec(['policy', 'promote', 'nonexistent'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('no policy matches prefix');
  });

  test('full-UUID fast path: 32+ char id with no match returns not found', async () => {
    // resolvePolicyId branches on length >= 32 — the fast path
    // bypasses the prefix scan and calls getPolicy directly. A
    // valid UUID shape that doesn't exist must surface as not
    // found, not silently fall through to "no policy matches
    // prefix".
    const fakeUuid = '00000000-0000-4000-8000-000000000000';
    const r = await agentPolicyCommand.exec(['policy', 'promote', fakeUuid], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('not found');
  });

  test('errors on ambiguous prefix', async () => {
    // Manually craft two policy ids with the same prefix.
    const p1 = createPolicy(db, {
      id: 'abcdef00-0000-4000-8000-000000000001',
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    const p2 = createPolicy(db, {
      id: 'abcdef00-0000-4000-8000-000000000002',
      scopeKind: 'repo',
      scopeId: 'r2',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'proposed',
    });
    expect(p1.id !== p2.id).toBe(true);
    const r = await agentPolicyCommand.exec(['policy', 'promote', 'abcdef00'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('ambiguous');
  });
});

describe('/agent policy invalidate', () => {
  test('active → invalidated with motivo', async () => {
    const p = createPolicy(db, {
      scopeKind: 'repo',
      scopeId: 'r1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
    });
    const r = await agentPolicyCommand.exec(
      ['policy', 'invalidate', p.id, 'tool_removed'],
      buildCtx(),
    );
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.notes?.[0]).toContain('invalidated');
    expect(r.notes?.[0]).toContain('tool_removed');
    const refetched = getPolicy(db, p.id);
    expect(refetched?.state).toBe('invalidated');
    expect(refetched?.motivo).toBe('tool_removed');
  });
});

describe('/agent policy history', () => {
  test('walks parent chain', async () => {
    const root: Policy = createPolicy(db, {
      scopeKind: 'global',
      scopeId: 'global',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
    });
    const child = createPolicy(db, {
      parentId: root.id,
      scopeKind: 'user',
      scopeId: 'u1',
      actionSignature: 'alias:grep:ripgrep',
      actionJson: '{}',
      state: 'active',
    });
    const r = await agentPolicyCommand.exec(['policy', 'history', child.id], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('policy chain (2 entries');
    expect(text).toContain(root.id.slice(0, 8));
    expect(text).toContain(child.id.slice(0, 8));
  });
});

describe('/agent policy run (loop frio invocation)', () => {
  test('runs loop frio and reports proposed + rejected', async () => {
    seedSuccessOutcomes('alias:grep:ripgrep', 12);
    const r = await agentPolicyCommand.exec(['policy', 'run'], buildCtx());
    if (r.kind !== 'ok') throw new Error('expected ok');
    const text = (r.notes ?? []).join('\n');
    expect(text).toContain('considered 1');
    expect(text).toContain('proposed: 1');
    expect(text).toContain('rejected: 0');
  });

  test('rejects unknown sub', async () => {
    const r = await agentPolicyCommand.exec(['policy', 'bogus'], buildCtx());
    expect(r.kind).toBe('error');
  });
});

describe('/agent (non-policy subnamespace)', () => {
  test('refuses unknown subnamespace', async () => {
    const r = await agentPolicyCommand.exec(['bogus'], buildCtx());
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toContain('policy');
  });

  test('empty args refused', async () => {
    const r = await agentPolicyCommand.exec([], buildCtx());
    expect(r.kind).toBe('error');
  });
});
