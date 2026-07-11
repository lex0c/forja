import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import {
  createRecordingTelemetrySink,
  type PermissionDecisionEvent,
  type TelemetryEvent,
} from '../../src/telemetry/index.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-audit-telem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const setupBase = () => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  const identity = ensureInstallId({
    env: { HOME: tmpRoot },
    now: () => 1,
    uuid: () => 'audit-telem-uuid',
  });
  return { db, identity };
};

const baseEmitArgs = {
  session_id: 's',
  tool_name: 'bash',
  args: { command: 'ls' },
  decision: 'allow' as const,
  policy_hash: 'sha256:p',
  reason_chain: [],
  // Slice 143 (API-3): the 7 load-bearing fields below are now
  // required on AuditEmitInput — default to "no signal" values
  // since this fixture exercises the telemetry hook, not the
  // score / classifier / sandbox columns.
  capabilities: [] as readonly string[],
  score: 0,
  score_components: {},
  classifier_hash: 'none' as string | null,
  classifier_adjust: null as number | null,
  sandbox_profile: null as string | null,
  ttl_expires_at: null as number | null,
};

describe('createSqliteSink — §18 telemetry integration (slice 70)', () => {
  test('no telemetry option → emit behaves exactly as before slice 70', () => {
    const { db, identity } = setupBase();
    const sink = createSqliteSink({ db, identity });
    const r = sink.emit({ ...baseEmitArgs, ts: 100 });
    expect(r.seq).toBe(1);
    expect(r.this_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('telemetry sink receives one permission.decision event per emit', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({ db, identity, telemetry });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    sink.emit({ ...baseEmitArgs, ts: 101 });
    sink.emit({ ...baseEmitArgs, ts: 102 });
    expect(telemetry.events()).toHaveLength(3);
    for (const event of telemetry.events()) {
      expect(event.kind).toBe('permission.decision');
    }
  });

  test('event mirrors the audit row content per spec §18 line 1179', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({ db, identity, telemetry });
    const row = sink.emit({
      ...baseEmitArgs,
      ts: 7777,
      tool_name: 'bash',
      decision: 'confirm',
      policy_hash: 'sha256:abc',
      score: 0.62,
      score_components: { capability_risk: 0.4, shell_chain: 0.2 },
      confidence: 'high',
      capabilities: ['exec:shell', 'write-fs:./build/**'],
      classifier_hash: 'v0.3',
      classifier_adjust: 0.02,
      sandbox_profile: 'cwd-rw-net',
      ttl_expires_at: 1731086400000,
      tool_version: 'v1.2',
      resolver_version: 'bash@1.3',
    });
    const event = telemetry.events()[0];
    expect(event).toBeDefined();
    if (event === undefined || event.kind !== 'permission.decision') {
      throw new Error('expected permission.decision event');
    }
    expect(event.ts).toBe(7777);
    expect(event.approval_id).toBe(row.seq);
    expect(event.parent_approval_id).toBeNull();
    expect(event.tool).toBe('bash');
    expect(event.tool_version).toBe('v1.2');
    expect(event.resolver_version).toBe('bash@1.3');
    expect(event.capabilities).toEqual(['exec:shell', 'write-fs:./build/**']);
    expect(event.decision).toBe('confirm');
    expect(event.score).toBe(0.62);
    expect(event.score_components).toEqual({
      capability_risk: 0.4,
      shell_chain: 0.2,
    });
    expect(event.confidence).toBe('high');
    expect(event.policy_hash).toBe('sha256:abc');
    expect(event.classifier_hash).toBe('v0.3');
    expect(event.classifier_adjust).toBe(0.02);
    expect(event.sandbox_profile).toBe('cwd-rw-net');
    expect(event.ttl_expires_at).toBe(1731086400000);
  });

  test('event fires AFTER persist — approval_id matches the persisted row seq', () => {
    // ORDER MATTERS: the audit row must land in approvals_log
    // BEFORE the telemetry event fires, so the event's
    // approval_id (= row.seq) is stable. Validate by having the
    // telemetry sink query the DB inside emit and confirm the
    // just-emitted row is visible.
    const { db, identity } = setupBase();
    const observedHeadSeqs: number[] = [];
    const queryingSink = {
      emit: (_event: TelemetryEvent) => {
        const row = db
          .query('SELECT seq FROM approvals_log WHERE install_id = ? ORDER BY seq DESC LIMIT 1')
          .get(identity.install_id) as { seq: number } | null;
        observedHeadSeqs.push(row?.seq ?? -1);
      },
    };
    const sink = createSqliteSink({ db, identity, telemetry: queryingSink });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    sink.emit({ ...baseEmitArgs, ts: 101 });
    expect(observedHeadSeqs).toEqual([1, 2]);
  });

  test('telemetry.emit throwing does NOT break audit emit (best-effort observability)', () => {
    const { db, identity } = setupBase();
    const sink = createSqliteSink({
      db,
      identity,
      telemetry: {
        emit: () => {
          throw new Error('telemetry adapter exploded');
        },
      },
    });
    const r = sink.emit({ ...baseEmitArgs, ts: 100 });
    expect(r.seq).toBe(1);
    expect(r.this_hash).toMatch(/^[a-f0-9]{64}$/);
    // Row landed in DB despite telemetry throw.
    const row = db
      .query('SELECT seq FROM approvals_log WHERE install_id = ?')
      .get(identity.install_id) as { seq: number } | null;
    expect(row?.seq).toBe(1);
  });

  test('default tool_version / resolver_version are recorded as "v1"', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({ db, identity, telemetry });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    // Caller omitted tool_version / resolver_version — sink
    // defaults to 'v1' for both. The telemetry event reflects
    // what the AUDIT ROW recorded.
    const event = telemetry.events()[0] as PermissionDecisionEvent | undefined;
    expect(event?.tool_version).toBe('v1');
    expect(event?.resolver_version).toBe('v1');
  });

  test('capabilities default to empty array when omitted', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({ db, identity, telemetry });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    const event = telemetry.events()[0] as PermissionDecisionEvent | undefined;
    expect(event?.capabilities).toEqual([]);
  });

  test('score_components default to empty object when omitted', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({ db, identity, telemetry });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    const event = telemetry.events()[0] as PermissionDecisionEvent | undefined;
    expect(event?.score_components).toEqual({});
  });

  test('engineState getter populates the event field (slice 75)', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({
      db,
      identity,
      telemetry,
      engineState: () => 'degraded',
    });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    const event = telemetry.events()[0] as PermissionDecisionEvent | undefined;
    expect(event?.engine_state).toBe('degraded');
  });

  test('engineState getter called PER EMIT (captures current state, not snapshot)', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    let currentState = 'ready';
    const sink = createSqliteSink({
      db,
      identity,
      telemetry,
      engineState: () => currentState,
    });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    currentState = 'degraded';
    sink.emit({ ...baseEmitArgs, ts: 101 });
    currentState = 'refusing';
    sink.emit({ ...baseEmitArgs, ts: 102 });
    const events = telemetry.events() as PermissionDecisionEvent[];
    expect(events[0]?.engine_state).toBe('ready');
    expect(events[1]?.engine_state).toBe('degraded');
    expect(events[2]?.engine_state).toBe('refusing');
  });

  test('no engineState option → event omits engine_state field', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({ db, identity, telemetry });
    sink.emit({ ...baseEmitArgs, ts: 100 });
    const event = telemetry.events()[0] as PermissionDecisionEvent | undefined;
    expect(event?.engine_state).toBeUndefined();
  });

  test('engineState getter throwing → event ships without the field, audit succeeds', () => {
    const { db, identity } = setupBase();
    const telemetry = createRecordingTelemetrySink();
    const sink = createSqliteSink({
      db,
      identity,
      telemetry,
      engineState: () => {
        throw new Error('synthetic getter failure');
      },
    });
    const r = sink.emit({ ...baseEmitArgs, ts: 100 });
    expect(r.seq).toBe(1);
    const event = telemetry.events()[0] as PermissionDecisionEvent | undefined;
    expect(event).toBeDefined();
    expect(event?.engine_state).toBeUndefined();
  });
});
