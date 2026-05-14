// Slice 130: bootstrap wire-up test. Asserts that when
// `detectSandboxAvailability` reports unavailable AND failureSink
// is wired, a `sandbox.tool_unavailable` row lands BEFORE the
// state-machine transitions to refusing/degraded.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteFailureSink } from '../../src/failures/index.ts';
import { bootstrapPermissionEngine } from '../../src/permissions/bootstrap-engine.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import {
  listFailureEventsByCode,
  listFailureEventsBySession,
} from '../../src/storage/repos/failure-events.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-failure-boot-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const baseDb = (): DB => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

const baseInput = (overrides: Parameters<typeof bootstrapPermissionEngine>[0] | object = {}) => ({
  cwd: '/work/proj',
  home: tmpRoot,
  env: { HOME: tmpRoot },
  db: ('db' in overrides ? (overrides.db as DB) : undefined) ?? baseDb(),
  sessionId: 'sess-failure',
  enterprisePath: null,
  userPath: null,
  now: () => 1,
  uuid: () => 'failure-test-uuid-aaaa',
  ...overrides,
});

describe('bootstrap wire — sandbox.tool_unavailable', () => {
  test('emits failure_event when sandbox.required=true + available=false (fatal)', async () => {
    const db = baseDb();
    const sink = createSqliteFailureSink({ db });
    await bootstrapPermissionEngine(
      baseInput({
        db,
        sandbox: { available: false, hostExplicitlyAllowed: false, required: true },
        failureSink: sink,
      }),
    );
    const rows = listFailureEventsByCode(db, 'sandbox.tool_unavailable', 0, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.classe).toBe('sandbox');
    expect(rows[0]?.recovery_action).toBe('fatal');
    expect(rows[0]?.user_visible).toBe(1);
    expect(rows[0]?.session_id).toBe('sess-failure');
    const payload = JSON.parse(rows[0]?.payload_json as string);
    expect(payload.policy_required).toBe(true);
    expect(payload.host_explicitly_allowed).toBe(false);
  });

  test('emits with recovery_action=degraded when policy does NOT require sandbox', async () => {
    const db = baseDb();
    const sink = createSqliteFailureSink({ db });
    await bootstrapPermissionEngine(
      baseInput({
        db,
        sandbox: { available: false, hostExplicitlyAllowed: false, required: false },
        failureSink: sink,
      }),
    );
    const rows = listFailureEventsByCode(db, 'sandbox.tool_unavailable', 0, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.recovery_action).toBe('degraded');
  });

  test('does NOT emit when sandbox.available=true (happy path)', async () => {
    const db = baseDb();
    const sink = createSqliteFailureSink({ db });
    await bootstrapPermissionEngine(
      baseInput({
        db,
        sandbox: { available: true, hostExplicitlyAllowed: false, required: true },
        failureSink: sink,
      }),
    );
    const rows = listFailureEventsBySession(db, 'sess-failure');
    expect(rows.length).toBe(0);
  });

  test('does NOT emit when failureSink not wired (back-compat)', async () => {
    const db = baseDb();
    // No failureSink supplied.
    await bootstrapPermissionEngine(
      baseInput({
        db,
        sandbox: { available: false, hostExplicitlyAllowed: false, required: true },
      }),
    );
    const rows = listFailureEventsBySession(db, 'sess-failure');
    expect(rows.length).toBe(0);
  });

  test('emission failure does NOT crash bootstrap', async () => {
    const db = baseDb();
    // Sink that throws on every emit — bootstrap must absorb it.
    const broken = {
      emit: () => {
        throw new Error('broken sink');
      },
      verifyChain: () => ({ ok: true as const, rows: 0 }),
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        db,
        sandbox: { available: false, hostExplicitlyAllowed: false, required: true },
        failureSink: broken,
      }),
    );
    // State-machine still transitions despite the sink throw.
    expect(r.state).toBe('refusing');
  });
});
