// context_pins repo. Per CONTEXT_TUNING.md §12.4 — pinned context
// primitive. Cap of 10 pins per session via withImmediateTransaction
// (read count, evict the oldest active pin when already at the cap,
// then insert — a ring buffer) because SQLite CHECK can't reference
// COUNT subqueries.
//
// Surface:
//
//   createPin(db, input)              → ContextPin              ring buffer (PIN_CAP): evicts oldest; throws InvalidPinError
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

// 'model' = the pin_context tool created it directly (no modal). 'user' =
// /pin slash command. 'model_proposed_user_approved' = legacy (the modal
// proposal flow that never shipped; kept for CHECK/fixture compatibility).
export const PIN_CREATED_BY = ['user', 'model_proposed_user_approved', 'model'] as const;
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
  // Step that originated a model-created pin; NULL for /pin slash.
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

// Invalid input from the slash parser or the pin_context tool. The
// DB-level CHECK constraints catch the same shapes but a TS-level
// throw gives the caller a structured field hint without needing to
// parse a SQLite error string.
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
  // Optional step_id for model-created pins; NULL for /pin slash.
  sourceStepId?: string | null;
  // Optional wall-clock anchor for the cap check (expired pins
  // don't count toward the cap). Defaults to Date.now() in
  // production; tests pin a value to make expiry deterministic.
  now?: number;
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
    // Cap check counts ONLY active (non-expired) pins, matching
    // what /pin --list shows and what prefix removal operates on.
    // Counting expired rows here produced a dead-end: 10
    // short-lived pins that lapsed would still block new creates,
    // but the operator couldn't list or remove the expired rows to
    // free the slot. §12.4.2's "10 pins per session" is the active
    // surface budget; expired rows linger as history but don't
    // occupy capacity. Use the same `now` anchor downstream
    // surfaces use so expired-but-not-yet-gc'd rows fall off the
    // count atomically with the active-list view.
    const nowMs = input.now ?? Date.now();
    const { count } = db
      .query<{ count: number }, [string, number]>(
        `SELECT COUNT(*) AS count FROM context_pins
          WHERE session_id = ?
            AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(input.sessionId, nowMs) ?? { count: 0 };
    if (count >= PIN_CAP) {
      // Ring buffer (cap PIN_CAP): the pin list is a bounded stack the model
      // only ever pushes to (no remove tool). At the cap, a new pin evicts
      // the OLDEST active one(s) instead of being rejected — the most recent
      // pins win, the count stays honest, and the model never has to free a
      // slot. Same writer lock as the count, so evict+insert is atomic.
      const overflow = count - PIN_CAP + 1;
      db.query(
        `DELETE FROM context_pins
          WHERE id IN (
            SELECT id FROM context_pins
              WHERE session_id = ?
                AND (expires_at IS NULL OR expires_at > ?)
              ORDER BY created_at ASC, id ASC
              LIMIT ?
          )`,
      ).run(input.sessionId, nowMs, overflow);
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

// Resolve a pin id prefix to its full row(s) within a session's active
// pins. Used by `/pin --remove <id>`: the list output shows an 8-char
// shortId for readability, but DELETE requires an exact match. Rather
// than dump 36-char UUIDs at the operator, we accept any unique prefix
// (git-style abbreviated SHA) and refuse on ambiguity.
//
// Scope is the session — pin ids are globally unique (UUID v4) so
// session-scoping isn't required for correctness, but it keeps the
// prefix index narrow (the operator's pins, not every pin in the DB)
// and matches the operator's mental model ("pins I can see").
//
// Returns an array so the caller can disambiguate: 0 matches → not
// found; 1 match → safe to delete by full id; ≥2 → ambiguous, the
// operator must lengthen the prefix.
export const findActivePinsByIdPrefix = (
  db: DB,
  sessionId: string,
  prefix: string,
  now: number = Date.now(),
): ContextPin[] => {
  // Escape SQL LIKE wildcards in operator-typed input. UUIDs only
  // contain hex + dashes so this is belt-and-braces, but a future
  // id scheme might include `%` / `_`.
  const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const rows = db
    .query<ContextPinRow, [string, number, string]>(
      `${SELECT_ALL}
        WHERE session_id = ?
          AND (expires_at IS NULL OR expires_at > ?)
          AND id LIKE ? ESCAPE '\\'
        ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId, now, `${escaped}%`);
  return rows.map(fromRow);
};

// Session-scoped store wrapping the db handle so consumers (tool,
// slash command, recap projection) don't reach into raw db queries.
// Mirrors the TodoStore / MemoryRegistry shape: harness owns
// construction, threads via ToolContext, tools fail-clean when
// absent. Distinct from TodoStore in that this one IS persistent
// — backed by SQLite, not an in-memory map — because pins must
// survive a `/resume` per §12.4.4.
export interface ContextPinsStore {
  createPin(input: CreatePinInput): ContextPin;
  getPin(id: string): ContextPin | null;
  listPinsBySession(sessionId: string): ContextPin[];
  getActivePinsBySession(sessionId: string, now?: number): ContextPin[];
  countActivePinsBySession(sessionId: string, now?: number): number;
  findActivePinsByIdPrefix(sessionId: string, prefix: string, now?: number): ContextPin[];
  removePin(id: string): boolean;
}

export const createContextPinsStore = (db: DB): ContextPinsStore => ({
  createPin: (input) => createPin(db, input),
  getPin: (id) => getPin(db, id),
  listPinsBySession: (sessionId) => listPinsBySession(db, sessionId),
  getActivePinsBySession: (sessionId, now) => getActivePinsBySession(db, sessionId, now),
  countActivePinsBySession: (sessionId, now) => countActivePinsBySession(db, sessionId, now),
  findActivePinsByIdPrefix: (sessionId, prefix, now) =>
    findActivePinsByIdPrefix(db, sessionId, prefix, now),
  removePin: (id) => removePin(db, id),
});

export { PERSISTED_COLUMNS };

// ─── pruneContextPins ──────────────────────────────────────────────────
//
// Retention sweep for `agent gc` (AGENTIC_CLI §2.1.3, AUDIT §1.2,
// CONTEXT_TUNING §12.4). Default retention 90d on `created_at`.
// Cutoff EXCLUSIVE — a row at exactly `olderThanMs` is KEPT.
//
// Distinct from the per-pin `expires_at` short-circuit in the read
// path (`getActivePinsBySession` filters on `expires_at`): this
// sweep handles the table-level retention regardless of per-pin
// TTL. A pin with `expires_at = NULL` (lives until session end)
// still ages out by `created_at` once it crosses the table
// retention window — otherwise long-lived sessions would
// accumulate unbounded pinned context.
//
// FK CASCADE with `sessions` already drops pins when the parent
// session is purged; this sweep covers pins on still-active
// sessions that are older than retention.
export const pruneContextPins = (db: DB, olderThanMs: number): number => {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error(
      `pruneContextPins: olderThanMs must be a positive finite number (got ${olderThanMs})`,
    );
  }
  const result = db.query('DELETE FROM context_pins WHERE created_at < ?').run(olderThanMs);
  return Number(result.changes);
};
