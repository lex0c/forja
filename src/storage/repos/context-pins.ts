// context_pins repo. Per CONTEXT_TUNING.md §12.4 — pinned context
// primitive. Cap of 10 pins per session is enforced here via
// withImmediateTransaction (read count, refuse if ≥ 10, insert
// atomically) because SQLite CHECK can't reference COUNT subqueries.
//
// Surface:
//
//   createPin(db, input)              → ContextPin              throws PinCapExceededError, InvalidPinError
//   getPin(db, id)                    → ContextPin | null
//   listPinsBySession(db, sid)        → ContextPin[]            all pins (no expiry filter)
//   getActivePinsBySession(db, sid)   → ContextPin[]            filters expired
//   countActivePinsBySession(db, sid) → number                  also exposed for /pin --list summary
//   removePin(db, id)                 → boolean                 true iff a row was deleted
//
// Plus a small `parseDuration` helper for `--expires-in 30m`-style
// inputs and constants for the public limits.

import type { SQLQueryBindings } from 'bun:sqlite';
import { type DB, withImmediateTransaction } from '../db.ts';

// Public limits — referenced by tool/slash validators and test
// fixtures. Pin cap from §12.4.2 ("10 pins por sessão"); text cap
// from the same section ("≤ 500 chars"). Exported so callers don't
// re-encode the magic number.
export const PIN_CAP = 10;
export const PIN_TEXT_MAX_LENGTH = 500;

export const PIN_KINDS = ['constraint', 'workflow', 'invariant', 'reminder'] as const;
export type PinKind = (typeof PIN_KINDS)[number];

export const PIN_CREATED_BY = ['user', 'model_proposed_user_approved'] as const;
export type PinCreatedBy = (typeof PIN_CREATED_BY)[number];

export interface ContextPin {
  id: string;
  sessionId: string;
  text: string;
  kind: PinKind;
  createdAt: number;
  createdBy: PinCreatedBy;
  // NULL = lives until end of session (cascade reaps on purge).
  // Epoch ms otherwise.
  expiresAt: number | null;
  // Step that originated a model-proposed pin; NULL for /pin slash.
  sourceStepId: string | null;
}

interface ContextPinRow {
  id: string;
  session_id: string;
  text: string;
  kind: PinKind;
  created_at: number;
  created_by: PinCreatedBy;
  expires_at: number | null;
  source_step_id: string | null;
}

const PERSISTED_COLUMNS = [
  'id',
  'session_id',
  'text',
  'kind',
  'created_at',
  'created_by',
  'expires_at',
  'source_step_id',
] as const;

const PLACEHOLDERS = PERSISTED_COLUMNS.map(() => '?').join(', ');
const COLUMN_LIST = PERSISTED_COLUMNS.join(', ');
const INSERT_SQL = `INSERT INTO context_pins (${COLUMN_LIST}) VALUES (${PLACEHOLDERS})`;

// Explicit SELECT list — a future ALTER widening the row shape
// must trip a compile-time signal, not silently broaden TS.
const SELECT_ALL = `SELECT id, session_id, text, kind, created_at, created_by,
       expires_at, source_step_id
  FROM context_pins`;

const fromRow = (row: ContextPinRow): ContextPin => ({
  id: row.id,
  sessionId: row.session_id,
  text: row.text,
  kind: row.kind,
  createdAt: row.created_at,
  createdBy: row.created_by,
  expiresAt: row.expires_at,
  sourceStepId: row.source_step_id,
});

const valuesForInsert = (row: ContextPinRow): SQLQueryBindings[] =>
  PERSISTED_COLUMNS.map((col) => {
    const v = (row as unknown as Record<string, unknown>)[col];
    return (v ?? null) as SQLQueryBindings;
  });

// Cap exceeded is a routine outcome (operator + model can both
// trigger it under §12.4.2's 10-pin ceiling), not a programming
// error. UI should render the message and suggest /pin --remove.
export class PinCapExceededError extends Error {
  readonly sessionId: string;
  readonly currentCount: number;
  readonly cap: number;
  constructor(sessionId: string, currentCount: number, cap: number = PIN_CAP) {
    super(
      `context_pins: session ${sessionId} already has ${currentCount} pins (cap ${cap}); remove one first`,
    );
    this.name = 'PinCapExceededError';
    this.sessionId = sessionId;
    this.currentCount = currentCount;
    this.cap = cap;
  }
}

// Invalid input from the slash parser or the model-proposed tool
// confirmation flow. The DB-level CHECK constraints catch the same
// shapes but a TS-level throw gives the caller a structured field
// hint without needing to parse a SQLite error string.
export class InvalidPinError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`context_pins: invalid ${field}: ${reason}`);
    this.name = 'InvalidPinError';
    this.field = field;
  }
}

// `--expires-in 30m|2h|1d` — short positive duration. Plain
// regex-and-multiply; no support for compound forms (`1h30m`) or
// fractional values. Spec §12.4.1 lists exactly three units; the
// parser refuses anything else to keep the contract tight.
//
// Throws `InvalidPinError('expires_in', ...)` on any malformed
// input so the caller can surface a structured field-level error
// to the UI.
export class InvalidDurationError extends InvalidPinError {
  constructor(input: string, reason: string) {
    super('expires_in', `${reason} (got "${input}")`);
    this.name = 'InvalidDurationError';
  }
}

const DURATION_RE = /^(\d+)([mhd])$/;
const UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;
type DurationUnit = keyof typeof UNIT_MS;

export const parseDuration = (input: string): number => {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new InvalidDurationError(input, 'empty');
  }
  const match = DURATION_RE.exec(trimmed);
  if (match === null) {
    throw new InvalidDurationError(input, 'expected <N>m|h|d (e.g. "30m", "2h", "1d")');
  }
  // The regex above guarantees both capture groups but TS strict
  // mode types them as `string | undefined`. Defensive narrows
  // satisfy lint/style/noNonNullAssertion without changing runtime
  // behavior — the throws are unreachable.
  const nStr = match[1];
  const unitRaw = match[2];
  if (nStr === undefined || unitRaw === undefined) {
    throw new InvalidDurationError(input, 'parser internal error');
  }
  if (unitRaw !== 'm' && unitRaw !== 'h' && unitRaw !== 'd') {
    throw new InvalidDurationError(input, 'parser internal error');
  }
  const unit: DurationUnit = unitRaw;
  const n = Number.parseInt(nStr, 10);
  if (n <= 0) {
    throw new InvalidDurationError(input, 'must be positive');
  }
  const ms = n * UNIT_MS[unit];
  // Defense against absurd values that would overflow JS number
  // arithmetic in downstream comparisons. 365d covers any realistic
  // session-scoped pin; longer values likely indicate a typo
  // (`30d` instead of `30m`) and should be rejected loudly.
  const MAX_MS = 365 * UNIT_MS.d;
  if (ms > MAX_MS) {
    throw new InvalidDurationError(input, 'exceeds 365d ceiling');
  }
  return ms;
};

export interface CreatePinInput {
  sessionId: string;
  text: string;
  kind: PinKind;
  createdBy: PinCreatedBy;
  // Optional ULID/UUID — defaults to crypto.randomUUID(). Caller
  // supplies when replaying from a deterministic source.
  id?: string;
  // Optional epoch ms — defaults to Date.now().
  createdAt?: number;
  // Optional epoch ms — NULL means "lives until end of session".
  expiresAt?: number | null;
  // Optional step_id for model-proposed pins; NULL for /pin slash.
  sourceStepId?: string | null;
}

const validateInput = (input: CreatePinInput): void => {
  if (input.text.length === 0) {
    throw new InvalidPinError('text', 'must not be empty');
  }
  if (input.text.length > PIN_TEXT_MAX_LENGTH) {
    throw new InvalidPinError(
      'text',
      `must be ≤ ${PIN_TEXT_MAX_LENGTH} chars (got ${input.text.length})`,
    );
  }
  if (!PIN_KINDS.includes(input.kind)) {
    throw new InvalidPinError('kind', `must be one of ${PIN_KINDS.join(', ')}`);
  }
  if (!PIN_CREATED_BY.includes(input.createdBy)) {
    throw new InvalidPinError('created_by', `must be one of ${PIN_CREATED_BY.join(', ')}`);
  }
  // expires_at sanity: if supplied and not null, must be a positive
  // epoch ms. Past timestamps are technically valid (pin would be
  // filtered out immediately by getActivePinsBySession) but most
  // likely a caller bug — reject loudly.
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) {
      throw new InvalidPinError('expires_at', 'must be a positive epoch ms');
    }
  }
};

// IMMEDIATE transaction: count + insert under the same writer lock
// so two concurrent createPin calls for the same session can't
// both pass a 9-pin check and land an 11th row. Per db.ts comment,
// busy_timeout=5000 absorbs transient contention; subagent vs.
// parent racing on /pin would serialize through the lock instead
// of throwing SQLITE_BUSY.
export const createPin = (db: DB, input: CreatePinInput): ContextPin => {
  validateInput(input);
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const expiresAt = input.expiresAt ?? null;
  const sourceStepId = input.sourceStepId ?? null;
  const row: ContextPinRow = {
    id,
    session_id: input.sessionId,
    text: input.text,
    kind: input.kind,
    created_at: createdAt,
    created_by: input.createdBy,
    expires_at: expiresAt,
    source_step_id: sourceStepId,
  };
  return withImmediateTransaction(db, () => {
    // Cap check counts ALL pins for the session, not just non-
    // expired ones. §12.4.2 says "10 pins per session" without
    // qualifier — operator removing expired ones explicitly is
    // intentional friction (the alternative, silently allowing
    // creation after expiry, hides resource pressure). The TTL
    // window in the spec is short (default end-of-session) so
    // this only matters in very long sessions with high pin churn,
    // a degenerate case where the cap should bite harder anyway.
    const { count } = db
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM context_pins WHERE session_id = ?',
      )
      .get(input.sessionId) ?? { count: 0 };
    if (count >= PIN_CAP) {
      throw new PinCapExceededError(input.sessionId, count);
    }
    db.query(INSERT_SQL).run(...valuesForInsert(row));
    return fromRow(row);
  });
};

export const getPin = (db: DB, id: string): ContextPin | null => {
  const row = db.query(`${SELECT_ALL} WHERE id = ?`).get(id) as ContextPinRow | null;
  return row !== null ? fromRow(row) : null;
};

// All pins for a session, ordered chronologically — created_at ASC
// then id ASC as the deterministic tiebreak. Used by /pin --list
// (operator wants to see the order they were created in) and as
// input to `listPinsBySession` callers that want history including
// expired ones (e.g., recap forensics).
export const listPinsBySession = (db: DB, sessionId: string): ContextPin[] => {
  const rows = db
    .query<ContextPinRow, [string]>(
      `${SELECT_ALL} WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId);
  return rows.map(fromRow);
};

// Non-expired pins for a session, ordered chronologically. The
// goal-reinjection / auto-rehydrate / compaction paths read this
// — they should never re-inject a pin whose `expires_at` has
// already passed. `now` is parameterized for test determinism;
// defaults to Date.now() in production.
export const getActivePinsBySession = (
  db: DB,
  sessionId: string,
  now: number = Date.now(),
): ContextPin[] => {
  const rows = db
    .query<ContextPinRow, [string, number]>(
      `${SELECT_ALL}
        WHERE session_id = ?
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId, now);
  return rows.map(fromRow);
};

// Cheap count used by `/pin --list` summary header ("3/10 pins
// active"). Counting in SQL is faster than getActivePinsBySession
// + .length when callers only need the number.
export const countActivePinsBySession = (
  db: DB,
  sessionId: string,
  now: number = Date.now(),
): number => {
  const { count } = db
    .query<{ count: number }, [string, number]>(
      `SELECT COUNT(*) AS count FROM context_pins
        WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(sessionId, now) ?? { count: 0 };
  return count;
};

// Removes a pin by id. Returns true iff a row was deleted — false
// for unknown ids (idempotent from the caller's POV; UI surfaces a
// `pin <id> not found` message rather than throwing).
export const removePin = (db: DB, id: string): boolean => {
  const result = db.query('DELETE FROM context_pins WHERE id = ?').run(id);
  return result.changes > 0;
};

export { PERSISTED_COLUMNS };
