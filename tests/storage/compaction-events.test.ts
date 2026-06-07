import { describe, expect, test } from 'bun:test';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  appendCompactionEvent,
  listCompactionEventsBySession,
  sumCompactionUsage,
} from '../../src/storage/repos/compaction-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

// compaction_events (migration 072) — the audit/replay trail for compaction.
// The live array persists no messages, so these rows are the only record of
// the DECISION (strategy, freed bytes, before/after hash, the LLM summary).

describe('compaction-events repo', () => {
  const freshSession = (): { db: ReturnType<typeof openMemoryDb>; sid: string } => {
    const db = openMemoryDb();
    migrate(db);
    const sid = createSession(db, { model: 'm', cwd: '/p' }).id;
    return { db, sid };
  };

  test('round-trips a relevance event (elidedIds JSON; no LLM summary)', () => {
    const { db, sid } = freshSession();
    const id = appendCompactionEvent(db, {
      sessionId: sid,
      strategy: 'relevance',
      foldedCount: 3,
      freedBytes: 4096,
      tokensBefore: 150_000,
      tokensAfter: 90_000,
      beforeHash: 'h1',
      afterHash: 'h2',
      elidedIds: ['tu1', 'tu2', 'tu3'],
      reason: 'relevance-elide: 3 pointered',
      recordedAt: 1000,
    });
    const rows = listCompactionEventsBySession(db, sid);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.id).toBe(id);
    expect(r?.strategy).toBe('relevance');
    expect(r?.folded_count).toBe(3);
    expect(r?.freed_bytes).toBe(4096);
    expect(r?.tokens_before).toBe(150_000);
    expect(r?.tokens_after).toBe(90_000);
    expect(r?.elided_ids).toBe(JSON.stringify(['tu1', 'tu2', 'tu3']));
    expect(r?.summary).toBeNull();
    db.close();
  });

  test('round-trips an llm event with summary + null relevance/token fields (forced /compact shape)', () => {
    const { db, sid } = freshSession();
    appendCompactionEvent(db, {
      sessionId: sid,
      strategy: 'llm',
      foldedCount: 12,
      beforeHash: 'a',
      afterHash: 'b',
      summary: 'GOAL: x\nDECISIONS: y',
      recordedAt: 2000,
    });
    const r = listCompactionEventsBySession(db, sid)[0];
    expect(r?.strategy).toBe('llm');
    expect(r?.summary).toBe('GOAL: x\nDECISIONS: y');
    expect(r?.freed_bytes).toBeNull();
    expect(r?.elided_ids).toBeNull();
    expect(r?.tokens_before).toBeNull(); // forced compaction has no trigger count
    db.close();
  });

  test('round-trips the billed call usage (migration 073 columns)', () => {
    const { db, sid } = freshSession();
    appendCompactionEvent(db, {
      sessionId: sid,
      strategy: 'llm',
      foldedCount: 10,
      beforeHash: 'a',
      afterHash: 'b',
      callUsage: { tokensIn: 1200, tokensOut: 300, cacheRead: 800, cacheCreation: 100 },
      recordedAt: 1,
    });
    const r = listCompactionEventsBySession(db, sid)[0];
    expect(r?.call_tokens_in).toBe(1200);
    expect(r?.call_tokens_out).toBe(300);
    expect(r?.call_cache_read).toBe(800);
    expect(r?.call_cache_creation).toBe(100);
    db.close();
  });

  test('sumCompactionUsage sums across rows; absent callUsage COALESCEs to 0', () => {
    const { db, sid } = freshSession();
    // LLM compaction with billed usage.
    appendCompactionEvent(db, {
      sessionId: sid,
      strategy: 'llm',
      foldedCount: 5,
      beforeHash: 'a',
      afterHash: 'b',
      callUsage: { tokensIn: 1000, tokensOut: 200, cacheRead: 500, cacheCreation: 50 },
      recordedAt: 1,
    });
    // Relevance-only compaction: no provider call → no callUsage → NULL cols.
    appendCompactionEvent(db, {
      sessionId: sid,
      strategy: 'relevance',
      foldedCount: 3,
      beforeHash: 'b',
      afterHash: 'c',
      elidedIds: ['t1'],
      recordedAt: 2,
    });
    const u = sumCompactionUsage(db, sid);
    expect(u).toEqual({ tokensIn: 1000, tokensOut: 200, cacheRead: 500, cacheCreation: 50 });
    db.close();
  });

  test('sumCompactionUsage returns zeros for a session with no compaction', () => {
    const { db, sid } = freshSession();
    expect(sumCompactionUsage(db, sid)).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });
    db.close();
  });

  test('the CHECK constraint rejects an unknown strategy', () => {
    const { db, sid } = freshSession();
    expect(() =>
      appendCompactionEvent(db, {
        sessionId: sid,
        strategy: 'bogus',
        foldedCount: 0,
        beforeHash: 'a',
        afterHash: 'b',
        recordedAt: 1,
      }),
    ).toThrow();
    db.close();
  });
});
