// memory_verify_override_attempts repo tests (migration 065, S3.3
// substrate).
//
// Pin the contracts the S3.3 dispatcher consumes:
//   - INSERT validates scope, suggested_motivo enum, confidence
//     range, contentHash + memoryName presence.
//   - Cooldown-based lookup: hit within window, miss outside.
//   - Boolean misguiding serializes as 0/1 and round-trips.
//   - FK SET NULL on subagent_runs purge preserves the dedup row.

import { beforeEach, describe, expect, test } from 'bun:test';
import { SEMANTIC_OVERRIDE_COOLDOWN_MS } from '../../src/memory/verify-override.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  listRecentOverrideAttempts,
  lookupRecentOverrideAttempt,
  pruneOverrideAttempts,
  recordOverrideAttempt,
} from '../../src/storage/repos/memory-verify-override-attempts.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;
let childSessionId: string;

const seedFakeChild = (parentId: string): string => {
  const child = createSession(db, {
    model: 'test/model',
    cwd: '/p',
    parentSessionId: parentId,
  });
  db.query(
    `INSERT INTO subagent_runs
       (session_id, name, scope, source_path, source_sha256, system_prompt,
        tools_whitelist, budget_max_steps, budget_max_cost_usd, captured_at)
     VALUES (?, 'verify-override', 'user', '/fake', 'a', 'p', '[]', 8, 0.08, 1)`,
  ).run(child.id);
  return child.id;
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  childSessionId = seedFakeChild(sessionId);
});

describe('recordOverrideAttempt — validation', () => {
  test('persists a well-formed misguiding=true row', () => {
    const r = recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: true,
      confidence: 0.85,
      suggestedMotivo: 'conflict',
      modelId: 'test/model',
      promptHash: 'b'.repeat(64),
      subagentRunSessionId: childSessionId,
      attemptedAt: 2_000_000_000_000,
    });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = listRecentOverrideAttempts(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.misguiding).toBe(true);
    expect(rows[0]?.suggestedMotivo).toBe('conflict');
    expect(rows[0]?.subagentRunSessionId).toBe(childSessionId);
  });

  test('persists a misguiding=false row (no proposal will land, dedup-only)', () => {
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: false,
      confidence: 0.9,
      suggestedMotivo: 'conflict',
      modelId: 'test/model',
      promptHash: 'b'.repeat(64),
      attemptedAt: 2_000_000_000_000,
    });
    const rows = listRecentOverrideAttempts(db);
    expect(rows[0]?.misguiding).toBe(false);
  });

  test('rejects invalid scope', () => {
    expect(() =>
      recordOverrideAttempt(db, {
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid
        memoryScope: 'invalid' as any,
        memoryName: 'foo',
        contentHash: 'a'.repeat(64),
        misguiding: false,
        confidence: 0.5,
        suggestedMotivo: 'conflict',
        modelId: 'm',
        promptHash: 'b'.repeat(64),
      }),
    ).toThrow(/invalid memoryScope/);
  });

  test('rejects empty memoryName / contentHash', () => {
    const base = {
      memoryScope: 'project_local' as const,
      misguiding: false,
      confidence: 0.5,
      suggestedMotivo: 'conflict' as const,
      modelId: 'm',
      promptHash: 'b'.repeat(64),
    };
    expect(() =>
      recordOverrideAttempt(db, { ...base, memoryName: '', contentHash: 'a'.repeat(64) }),
    ).toThrow(/memoryName/);
    expect(() =>
      recordOverrideAttempt(db, { ...base, memoryName: 'foo', contentHash: '' }),
    ).toThrow(/contentHash/);
  });

  test('rejects confidence outside [0, 1]', () => {
    const base = {
      memoryScope: 'project_local' as const,
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: false,
      suggestedMotivo: 'conflict' as const,
      modelId: 'm',
      promptHash: 'b'.repeat(64),
    };
    expect(() => recordOverrideAttempt(db, { ...base, confidence: 1.5 })).toThrow(
      /confidence must be in/,
    );
    expect(() => recordOverrideAttempt(db, { ...base, confidence: -0.1 })).toThrow(
      /confidence must be in/,
    );
  });

  test('rejects invalid suggestedMotivo (outside enum)', () => {
    expect(() =>
      recordOverrideAttempt(db, {
        memoryScope: 'project_local',
        memoryName: 'foo',
        contentHash: 'a'.repeat(64),
        misguiding: false,
        confidence: 0.5,
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid
        suggestedMotivo: 'security' as any,
        modelId: 'm',
        promptHash: 'b'.repeat(64),
      }),
    ).toThrow(/suggestedMotivo/);
  });
});

describe('lookupRecentOverrideAttempt — cooldown gate', () => {
  test('returns null when no attempt exists', () => {
    const r = lookupRecentOverrideAttempt(
      db,
      'project_local',
      'foo',
      'a'.repeat(64),
      SEMANTIC_OVERRIDE_COOLDOWN_MS,
    );
    expect(r).toBeNull();
  });

  test('returns the most-recent attempt when within cooldown window', () => {
    const now = 2_000_000_000_000;
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: true,
      confidence: 0.85,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      attemptedAt: now - 1000, // 1s ago, well within 24h cooldown
    });
    const r = lookupRecentOverrideAttempt(
      db,
      'project_local',
      'foo',
      'a'.repeat(64),
      SEMANTIC_OVERRIDE_COOLDOWN_MS,
      now,
    );
    expect(r).not.toBeNull();
    expect(r?.misguiding).toBe(true);
  });

  test('returns null when last attempt is older than the cooldown window', () => {
    const now = 2_000_000_000_000;
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: true,
      confidence: 0.85,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      attemptedAt: now - SEMANTIC_OVERRIDE_COOLDOWN_MS - 1, // just past
    });
    const r = lookupRecentOverrideAttempt(
      db,
      'project_local',
      'foo',
      'a'.repeat(64),
      SEMANTIC_OVERRIDE_COOLDOWN_MS,
      now,
    );
    expect(r).toBeNull();
  });

  test('different content_hash invalidates the cache (operator edit)', () => {
    const now = 2_000_000_000_000;
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: false,
      confidence: 0.9,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      attemptedAt: now,
    });
    // Different hash → cache miss.
    const r = lookupRecentOverrideAttempt(
      db,
      'project_local',
      'foo',
      'c'.repeat(64),
      SEMANTIC_OVERRIDE_COOLDOWN_MS,
      now,
    );
    expect(r).toBeNull();
  });

  test('returns the LATEST attempt when multiple exist within window', () => {
    const now = 2_000_000_000_000;
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: false,
      confidence: 0.6,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      attemptedAt: now - 2000,
    });
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: true,
      confidence: 0.9,
      suggestedMotivo: 'shift',
      modelId: 'm',
      promptHash: 'c'.repeat(64),
      attemptedAt: now - 1000,
    });
    const r = lookupRecentOverrideAttempt(
      db,
      'project_local',
      'foo',
      'a'.repeat(64),
      SEMANTIC_OVERRIDE_COOLDOWN_MS,
      now,
    );
    expect(r?.misguiding).toBe(true); // newer attempt won
    expect(r?.suggestedMotivo).toBe('shift');
  });
});

describe('pruneOverrideAttempts', () => {
  test('drops rows older than cutoff (exclusive boundary)', () => {
    const now = 2_000_000_000_000;
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: false,
      confidence: 0.5,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      attemptedAt: now - 1,
    });
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'bar',
      contentHash: 'a'.repeat(64),
      misguiding: false,
      confidence: 0.5,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      attemptedAt: now,
    });
    const deleted = pruneOverrideAttempts(db, now);
    expect(deleted).toBe(1);
    expect(listRecentOverrideAttempts(db).length).toBe(1);
  });
});

describe('FK SET NULL on subagent_runs purge', () => {
  test('preserves the attempt row + nulls subagent_run_session_id', () => {
    recordOverrideAttempt(db, {
      memoryScope: 'project_local',
      memoryName: 'foo',
      contentHash: 'a'.repeat(64),
      misguiding: true,
      confidence: 0.85,
      suggestedMotivo: 'conflict',
      modelId: 'm',
      promptHash: 'b'.repeat(64),
      subagentRunSessionId: childSessionId,
      attemptedAt: 2_000_000_000_000,
    });
    // Purge the child session (CASCADE on subagent_runs would normally
    // fire; SET NULL keeps the attempt row).
    db.query('DELETE FROM sessions WHERE id = ?').run(childSessionId);
    const rows = listRecentOverrideAttempts(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.subagentRunSessionId).toBeNull();
  });
});
