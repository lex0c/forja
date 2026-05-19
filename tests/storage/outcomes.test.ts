// outcomes repo tests (FEEDBACK_ADAPTATION §3.1).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  countOutcomes,
  countOutcomesByActionSignature,
  createOutcome,
  getLatestOutcomeForSignature,
  listOutcomesByActionSignature,
  listOutcomesBySession,
} from '../../src/storage/repos/outcomes.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;
let toolCallId: string;

const seedToolCall = (id: string, sid: string): string => {
  // tool_calls FK requires a message_id; messages FK a session.
  // Insert a stub message + tool_call so the FK chain holds.
  const msgId = crypto.randomUUID();
  db.query(
    `INSERT INTO messages (id, session_id, role, content, created_at)
     VALUES (?, ?, 'tool', '{}', ?)`,
  ).run(msgId, sid, Date.now());
  db.query(
    `INSERT INTO tool_calls (id, message_id, tool_name, input, status, created_at)
     VALUES (?, ?, 'bash', '{}', 'done', ?)`,
  ).run(id, msgId, Date.now());
  return id;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  toolCallId = seedToolCall(crypto.randomUUID(), sessionId);
});

afterEach(() => {
  db.close();
});

describe('createOutcome — evidence scrub (AUDIT.md §1 medium sensitivity)', () => {
  test('scrubs secret patterns inside evidence_json', () => {
    const o = createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'flag:bash:default:default',
      tier: 1,
      result: 'failure',
      evidenceJson: JSON.stringify({
        tool_name: 'bash',
        error_message: 'log: sk-ant-aaaaaaaaaaaaaaaaaaaa expired',
      }),
      scopeKind: 'session',
      scopeId: sessionId,
    });
    expect(o.evidenceJson).not.toBeNull();
    expect(o.evidenceJson).not.toContain('sk-ant-aaaaaaaaaaaaaaaaaaaa');
  });

  test('scrubs paths inside nested arrays + objects', () => {
    const o = createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'flag:bash:default:default',
      tier: 1,
      result: 'failure',
      evidenceJson: JSON.stringify({
        paths: ['/home/operator/secrets/key.pem'],
        inner: { ref: '/Users/operator/.aws/credentials' },
      }),
      scopeKind: 'session',
      scopeId: sessionId,
    });
    expect(o.evidenceJson).not.toContain('/home/operator');
    expect(o.evidenceJson).not.toContain('/Users/operator');
  });

  test('malformed JSON preserved as scrubbed marker', () => {
    const o = createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'flag:bash:default:default',
      tier: 1,
      result: 'failure',
      evidenceJson: 'not-actually-json sk-ant-secretsecretsecretsecret',
      scopeKind: 'session',
      scopeId: sessionId,
    });
    expect(o.evidenceJson).toContain('_scrubbed_invalid_json');
    expect(o.evidenceJson).not.toContain('sk-ant-secretsecretsecretsecret');
  });

  test('null evidenceJson stays null (no scrub op)', () => {
    const o = createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'flag:bash:default:default',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
    });
    expect(o.evidenceJson).toBeNull();
  });
});

describe('createOutcome', () => {
  test('lands a row with default id + recorded_at', () => {
    const o = createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
    });
    expect(o.id).toBeTruthy();
    expect(o.recordedAt).toBeGreaterThan(0);
    expect(o.evidenceJson).toBeNull();
    expect(countOutcomes(db)).toBe(1);
  });

  test('rejects invalid tier via CHECK', () => {
    expect(() =>
      createOutcome(db, {
        sessionId,
        toolCallId,
        actionSignature: 'alias:grep:ripgrep',
        tier: 7 as 1,
        result: 'success',
        scopeKind: 'session',
        scopeId: sessionId,
      }),
    ).toThrow();
  });

  test('rejects invalid result via CHECK', () => {
    expect(() =>
      createOutcome(db, {
        sessionId,
        toolCallId,
        actionSignature: 'alias:grep:ripgrep',
        tier: 1,
        result: 'maybe' as 'success',
        scopeKind: 'session',
        scopeId: sessionId,
      }),
    ).toThrow();
  });

  test('rejects invalid scope_kind via CHECK', () => {
    expect(() =>
      createOutcome(db, {
        sessionId,
        toolCallId,
        actionSignature: 'alias:grep:ripgrep',
        tier: 1,
        result: 'success',
        scopeKind: 'bogus' as 'session',
        scopeId: sessionId,
      }),
    ).toThrow();
  });

  test('CASCADE: session purge removes outcomes', () => {
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
    });
    expect(countOutcomes(db)).toBe(1);
    // Need to also clean tool_calls + messages FK chain before
    // session delete cascades. The CASCADE on outcomes.session_id
    // does the work directly.
    db.query('PRAGMA foreign_keys = ON').run();
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(countOutcomes(db)).toBe(0);
  });
});

describe('listOutcomesByActionSignature', () => {
  test('filters by action_signature + scope', () => {
    const tc2 = seedToolCall(crypto.randomUUID(), sessionId);
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'repo',
      scopeId: 'repo-hash-1',
    });
    createOutcome(db, {
      sessionId,
      toolCallId: tc2,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'failure',
      scopeKind: 'repo',
      scopeId: 'repo-hash-1',
    });
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'repo',
      scopeId: 'other-repo',
    });

    const rows = listOutcomesByActionSignature(db, 'alias:grep:ripgrep', 'repo', 'repo-hash-1');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scopeId === 'repo-hash-1')).toBe(true);
  });

  test('respects sinceMs window', () => {
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 1000,
    });
    createOutcome(db, {
      sessionId,
      toolCallId: seedToolCall(crypto.randomUUID(), sessionId),
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 5000,
    });
    const recent = listOutcomesByActionSignature(db, 'alias:grep:ripgrep', 'session', sessionId, {
      sinceMs: 3000,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.recordedAt).toBe(5000);
  });

  test('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      createOutcome(db, {
        sessionId,
        toolCallId: seedToolCall(crypto.randomUUID(), sessionId),
        actionSignature: 'alias:grep:ripgrep',
        tier: 1,
        result: 'success',
        scopeKind: 'session',
        scopeId: sessionId,
        recordedAt: 1000 + i,
      });
    }
    const rows = listOutcomesByActionSignature(db, 'alias:grep:ripgrep', 'session', sessionId, {
      limit: 3,
    });
    expect(rows).toHaveLength(3);
  });
});

describe('countOutcomesByActionSignature', () => {
  test('counts rows for the (action, scope) tuple', () => {
    for (let i = 0; i < 7; i++) {
      createOutcome(db, {
        sessionId,
        toolCallId: seedToolCall(crypto.randomUUID(), sessionId),
        actionSignature: 'alias:grep:ripgrep',
        tier: 1,
        result: i % 2 === 0 ? 'success' : 'failure',
        scopeKind: 'repo',
        scopeId: 'r1',
      });
    }
    expect(countOutcomesByActionSignature(db, 'alias:grep:ripgrep', 'repo', 'r1')).toBe(7);
    expect(countOutcomesByActionSignature(db, 'alias:grep:ripgrep', 'repo', 'r2')).toBe(0);
  });

  test('respects sinceMs window', () => {
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 100,
    });
    createOutcome(db, {
      sessionId,
      toolCallId: seedToolCall(crypto.randomUUID(), sessionId),
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 500,
    });
    expect(
      countOutcomesByActionSignature(db, 'alias:grep:ripgrep', 'session', sessionId, 300),
    ).toBe(1);
  });
});

describe('listOutcomesBySession', () => {
  test('returns every outcome for the session, newest first', () => {
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 100,
    });
    createOutcome(db, {
      sessionId,
      toolCallId: seedToolCall(crypto.randomUUID(), sessionId),
      actionSignature: 'flag:bash:cwd_arg:preferred',
      tier: 2,
      result: 'partial',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 200,
    });
    const rows = listOutcomesBySession(db, sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.recordedAt).toBe(200);
    expect(rows[1]?.recordedAt).toBe(100);
  });
});

describe('getLatestOutcomeForSignature', () => {
  test('returns the most-recent row for (action, scope)', () => {
    createOutcome(db, {
      sessionId,
      toolCallId,
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'failure',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 100,
    });
    createOutcome(db, {
      sessionId,
      toolCallId: seedToolCall(crypto.randomUUID(), sessionId),
      actionSignature: 'alias:grep:ripgrep',
      tier: 1,
      result: 'success',
      scopeKind: 'session',
      scopeId: sessionId,
      recordedAt: 200,
    });
    const latest = getLatestOutcomeForSignature(db, 'alias:grep:ripgrep', 'session', sessionId);
    expect(latest?.result).toBe('success');
    expect(latest?.recordedAt).toBe(200);
  });

  test('null when no match', () => {
    expect(getLatestOutcomeForSignature(db, 'alias:none:none', 'global', 'global')).toBeNull();
  });
});
