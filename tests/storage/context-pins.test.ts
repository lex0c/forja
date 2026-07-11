import { beforeEach, describe, expect, test } from 'bun:test';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  type CreatePinInput,
  countActivePinsBySession,
  createPin,
  getActivePinsBySession,
  getPin,
  InvalidDurationError,
  InvalidPinError,
  listPinsBySession,
  PIN_CAP,
  PIN_TEXT_MAX_LENGTH,
  parseDuration,
  removePin,
} from '../../src/storage/repos/context-pins.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let db: DB;
let sessionId: string;

const validInput = (overrides: Partial<CreatePinInput> = {}): CreatePinInput => ({
  sessionId,
  text: 'rodar pnpm fmt antes de commitar',
  kind: 'workflow',
  createdBy: 'user',
  ...overrides,
});

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

describe('context_pins repo: create + read', () => {
  test('createPin inserts and returns the new row', () => {
    const pin = createPin(db, validInput({ text: 'API pública não muda', kind: 'constraint' }));
    expect(pin.id).toBeString();
    expect(pin.sessionId).toBe(sessionId);
    expect(pin.text).toBe('API pública não muda');
    expect(pin.kind).toBe('constraint');
    expect(pin.createdBy).toBe('user');
    expect(pin.expiresAt).toBeNull();
    expect(pin.sourceStepId).toBeNull();
    expect(pin.createdAt).toBeGreaterThan(0);
  });

  test('getPin returns the inserted row', () => {
    const created = createPin(db, validInput());
    const fetched = getPin(db, created.id);
    expect(fetched).toEqual(created);
  });

  test('getPin returns null for unknown id', () => {
    expect(getPin(db, 'no-such-id')).toBeNull();
  });

  test('listPinsBySession returns chronological order', () => {
    createPin(db, validInput({ text: 'b', createdAt: 200 }));
    createPin(db, validInput({ text: 'a', createdAt: 100 }));
    createPin(db, validInput({ text: 'c', createdAt: 300 }));
    const list = listPinsBySession(db, sessionId);
    expect(list.map((p) => p.text)).toEqual(['a', 'b', 'c']);
  });

  test('listPinsBySession scopes to the session', () => {
    const otherSession = createSession(db, { model: 'm', cwd: '/p' }).id;
    createPin(db, validInput({ text: 'mine' }));
    createPin(db, validInput({ sessionId: otherSession, text: 'theirs' }));
    const list = listPinsBySession(db, sessionId);
    expect(list).toHaveLength(1);
    expect(list[0]?.text).toBe('mine');
  });

  test('model-proposed pin records sourceStepId and created_by', () => {
    const pin = createPin(
      db,
      validInput({
        text: 'fase de refactor — não tocar em testes',
        createdBy: 'model_proposed_user_approved',
        sourceStepId: 'step-42',
      }),
    );
    expect(pin.createdBy).toBe('model_proposed_user_approved');
    expect(pin.sourceStepId).toBe('step-42');
  });

  test('createPin accepts an explicit id (replay/import path)', () => {
    // Documented for future replay tooling. Round-trips verbatim so
    // the caller's deterministic id survives.
    const pin = createPin(db, validInput({ id: 'fixed-id-abc', text: 'replayed' }));
    expect(pin.id).toBe('fixed-id-abc');
    expect(getPin(db, 'fixed-id-abc')?.text).toBe('replayed');
  });

  test('duplicate explicit id throws (PRIMARY KEY)', () => {
    // The repo does NOT wrap the SQLite primary-key violation in a
    // structured error. Anyone building a replay tool needs to
    // handle this case explicitly. Test pins the current contract
    // so a future structured-error refactor surfaces here, not as
    // a silent replay regression.
    createPin(db, validInput({ id: 'dup', text: 'first' }));
    expect(() => createPin(db, validInput({ id: 'dup', text: 'second' }))).toThrow();
  });
});

describe('context_pins repo: ring buffer (cap PIN_CAP)', () => {
  test('an 11th pin evicts the oldest, staying at PIN_CAP', () => {
    for (let i = 0; i < PIN_CAP; i++) {
      createPin(db, validInput({ text: `pin ${i}`, createdAt: 1000 + i }));
    }
    createPin(db, validInput({ text: 'overflow', createdAt: 9999 }));
    const texts = listPinsBySession(db, sessionId).map((p) => p.text);
    expect(texts).toHaveLength(PIN_CAP); // capped — no overflow row, no throw
    expect(texts).toContain('overflow');
    expect(texts).not.toContain('pin 0'); // oldest evicted
    expect(texts).toContain('pin 1');
  });

  test('eviction is per-session, not global', () => {
    const otherSession = createSession(db, { model: 'm', cwd: '/p' }).id;
    for (let i = 0; i < PIN_CAP; i++) {
      createPin(db, validInput({ text: `mine ${i}`, createdAt: 1000 + i }));
    }
    // This session at the cap doesn't evict another session's pins.
    createPin(db, validInput({ sessionId: otherSession, text: 'theirs' }));
    expect(listPinsBySession(db, otherSession)).toHaveLength(1);
    expect(listPinsBySession(db, sessionId)).toHaveLength(PIN_CAP);
  });

  test('removePin frees a row (operator /pin --remove path)', () => {
    const id = createPin(db, validInput({ text: 'pin' })).id;
    expect(removePin(db, id)).toBe(true);
    expect(listPinsBySession(db, sessionId)).toHaveLength(0);
  });

  test('eviction counts only ACTIVE pins — expired rows do not occupy the budget', () => {
    const now = 1_000_000;
    const past = now - 60_000;
    for (let i = 0; i < PIN_CAP; i++) {
      createPin(db, validInput({ text: `expired ${i}`, expiresAt: past, createdAt: i }));
    }
    // All 10 are past expiry — a fresh active pin finds zero active and
    // lands without evicting anything.
    createPin(db, validInput({ text: 'fresh', now }));
    expect(getActivePinsBySession(db, sessionId, now).map((p) => p.text)).toEqual(['fresh']);
  });

  test('at the ACTIVE cap, the oldest ACTIVE is evicted (expired ignored)', () => {
    const now = 2_000_000;
    const future = now + 60_000;
    for (let i = 0; i < PIN_CAP; i++) {
      createPin(db, validInput({ text: `live ${i}`, expiresAt: future, createdAt: 1000 + i, now }));
    }
    createPin(db, validInput({ text: 'newest', expiresAt: future, createdAt: 9999, now }));
    const texts = getActivePinsBySession(db, sessionId, now).map((p) => p.text);
    expect(texts).toHaveLength(PIN_CAP);
    expect(texts).toContain('newest');
    expect(texts).not.toContain('live 0'); // oldest active evicted
  });
});

describe('context_pins repo: active filtering', () => {
  test('getActivePinsBySession excludes expired pins', () => {
    const now = 1_000_000;
    createPin(db, validInput({ text: 'live forever', createdAt: now }));
    createPin(db, validInput({ text: 'gone', createdAt: now, expiresAt: now - 1 }));
    createPin(db, validInput({ text: 'still here', createdAt: now, expiresAt: now + 60_000 }));
    const active = getActivePinsBySession(db, sessionId, now);
    expect(active.map((p) => p.text).sort()).toEqual(['live forever', 'still here']);
  });

  test('countActivePinsBySession matches getActivePinsBySession length', () => {
    const now = 1_000_000;
    createPin(db, validInput({ text: 'a', createdAt: now }));
    createPin(db, validInput({ text: 'b', createdAt: now, expiresAt: now - 1 }));
    createPin(db, validInput({ text: 'c', createdAt: now, expiresAt: now + 5000 }));
    expect(countActivePinsBySession(db, sessionId, now)).toBe(2);
  });

  test('expires_at boundary is exclusive (== now is expired)', () => {
    const now = 1_000_000;
    createPin(db, validInput({ text: 'edge', expiresAt: now }));
    expect(getActivePinsBySession(db, sessionId, now)).toHaveLength(0);
    expect(getActivePinsBySession(db, sessionId, now - 1)).toHaveLength(1);
  });
});

describe('context_pins repo: validation (TS-level)', () => {
  test('rejects empty text', () => {
    expect(() => createPin(db, validInput({ text: '' }))).toThrow(InvalidPinError);
  });

  test('rejects text > 500 chars', () => {
    const long = 'x'.repeat(PIN_TEXT_MAX_LENGTH + 1);
    expect(() => createPin(db, validInput({ text: long }))).toThrow(InvalidPinError);
  });

  test('accepts text exactly at 500 chars', () => {
    const exact = 'y'.repeat(PIN_TEXT_MAX_LENGTH);
    expect(() => createPin(db, validInput({ text: exact }))).not.toThrow();
  });

  test('rejects invalid kind', () => {
    expect(() => createPin(db, validInput({ kind: 'banana' as never }))).toThrow(InvalidPinError);
  });

  test('rejects invalid created_by', () => {
    expect(() => createPin(db, validInput({ createdBy: 'hook' as never }))).toThrow(
      InvalidPinError,
    );
  });

  test('rejects non-positive expires_at', () => {
    expect(() => createPin(db, validInput({ expiresAt: 0 }))).toThrow(InvalidPinError);
    expect(() => createPin(db, validInput({ expiresAt: -1 }))).toThrow(InvalidPinError);
    expect(() => createPin(db, validInput({ expiresAt: Number.NaN }))).toThrow(InvalidPinError);
  });
});

describe('context_pins repo: DB-level CHECK constraints', () => {
  // These exercise the SQL CHECK as defense-in-depth — the TS
  // validateInput already covers the happy path. A raw INSERT
  // through bun:sqlite simulates a future caller that bypassed
  // the repo (e.g., an import script).
  test('CHECK rejects unknown kind on raw insert', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO context_pins (id, session_id, text, kind, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('id1', sessionId, 'x', 'bogus', Date.now(), 'user'),
    ).toThrow();
  });

  test('CHECK rejects unknown created_by on raw insert', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO context_pins (id, session_id, text, kind, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('id1', sessionId, 'x', 'workflow', Date.now(), 'cron'),
    ).toThrow();
  });

  test('CHECK rejects text > 500 chars on raw insert', () => {
    const long = 'z'.repeat(PIN_TEXT_MAX_LENGTH + 1);
    expect(() =>
      db
        .query(
          `INSERT INTO context_pins (id, session_id, text, kind, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('id1', sessionId, long, 'workflow', Date.now(), 'user'),
    ).toThrow();
  });
});

describe('context_pins repo: CASCADE + removePin', () => {
  test('removePin returns true when row exists', () => {
    const pin = createPin(db, validInput());
    expect(removePin(db, pin.id)).toBe(true);
    expect(getPin(db, pin.id)).toBeNull();
  });

  test('removePin returns false for unknown id', () => {
    expect(removePin(db, 'no-such-pin')).toBe(false);
  });

  test('FK CASCADE deletes pins when their session is purged', () => {
    createPin(db, validInput({ text: 'doomed' }));
    expect(listPinsBySession(db, sessionId)).toHaveLength(1);
    db.query('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(listPinsBySession(db, sessionId)).toHaveLength(0);
  });
});

describe('parseDuration', () => {
  test('parses minute / hour / day units', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  test('trims surrounding whitespace', () => {
    expect(parseDuration('  45m  ')).toBe(45 * 60_000);
  });

  test('rejects empty / blank input', () => {
    expect(() => parseDuration('')).toThrow(InvalidDurationError);
    expect(() => parseDuration('   ')).toThrow(InvalidDurationError);
  });

  test('rejects unsupported units', () => {
    expect(() => parseDuration('30s')).toThrow(InvalidDurationError);
    expect(() => parseDuration('1w')).toThrow(InvalidDurationError);
    expect(() => parseDuration('5')).toThrow(InvalidDurationError);
  });

  test('rejects compound / fractional inputs', () => {
    expect(() => parseDuration('1h30m')).toThrow(InvalidDurationError);
    expect(() => parseDuration('1.5h')).toThrow(InvalidDurationError);
  });

  test('rejects zero and negative durations', () => {
    expect(() => parseDuration('0m')).toThrow(InvalidDurationError);
    // -30 doesn't match the regex (the minus is outside the
    // capture); it still fails, just on the parser-level check
    // before the positive guard.
    expect(() => parseDuration('-30m')).toThrow(InvalidDurationError);
  });

  test('rejects values above the 365d ceiling', () => {
    expect(() => parseDuration('366d')).toThrow(InvalidDurationError);
    expect(parseDuration('365d')).toBe(365 * 86_400_000);
  });
});
