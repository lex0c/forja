import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapPermissionEngine } from '../../src/permissions/bootstrap-engine.ts';
import { createSqliteSink, ensureInstallId } from '../../src/permissions/index.ts';
import { type DB, MIGRATIONS, migrate, openMemoryDb } from '../../src/storage/index.ts';
import { listApprovalsLogByInstall } from '../../src/storage/repos/approvals-log.ts';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'forja-boot-eng-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const baseDb = (): DB => {
  const db = openMemoryDb();
  migrate(db, MIGRATIONS);
  return db;
};

const baseInput = (overrides: Partial<Parameters<typeof bootstrapPermissionEngine>[0]> = {}) => ({
  cwd: '/work/proj',
  home: tmpRoot,
  env: { HOME: tmpRoot },
  db: overrides.db ?? baseDb(),
  sessionId: 'sess-boot',
  enterprisePath: null,
  userPath: null,
  now: () => 1,
  uuid: () => 'boot-uuid-aaaa-bbbb',
  ...overrides,
});

describe('bootstrapPermissionEngine — happy path', () => {
  test('walks init → loading-policy → validating-chain → ready', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    expect(r.state).toBe('ready');
    expect(r.events.map((e) => e.to)).toEqual(['loading-policy', 'validating-chain', 'ready']);
    expect(r.refusingReason).toBeUndefined();
  });

  test('engine produced is in ready state', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    expect(r.engine.state()).toBe('ready');
  });

  test('chain verifies clean on fresh install', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    expect(r.chain.ok).toBe(true);
  });

  test('identity is created and persisted', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    expect(r.identity.install_id).toBe('boot-uuid-aaaa-bbbb');
    expect(r.identity.created_at_ms).toBe(1);
  });

  test('audit sink is wired — engine emits to the same DB', async () => {
    const db = baseDb();
    const r = bootstrapPermissionEngine(baseInput({ db }));
    // Hit the engine with one check; the audit row must land in
    // the shared DB.
    r.engine.check('bash', 'bash', { command: 'ls' });
    const rows = listApprovalsLogByInstall(db, r.identity.install_id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tool_name).toBe('bash');
  });

  test('returns layers, lockConflicts, provenance from resolver', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    expect(r.layers).toEqual([]); // no policy files → default
    expect(r.lockConflicts).toEqual([]);
    expect(r.provenance.defaults).toBe('default');
  });
});

describe('bootstrapPermissionEngine — refusing paths', () => {
  test('install_id failure → refusing', async () => {
    const r = bootstrapPermissionEngine(
      baseInput({ env: {} }), // no HOME / XDG / APPDATA → install_id throws
    );
    expect(r.state).toBe('refusing');
    expect(r.refusingReason).toContain('install_id_failed');
    // engine denies every check
    const d = r.engine.check('bash', 'bash', { command: 'ls' });
    expect(d.kind).toBe('deny');
  });

  test('malformed policy → refusing', async () => {
    // Write a project policy that violates §11 (rejected at parse).
    const projDir = join(tmpRoot, 'proj');
    const agentDir = join(projDir, '.agent');
    require('node:fs').mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'permissions.yaml'),
      `
defaults:
  mode: strict
tools:
  write_file:
    allow_paths:
      - "/etc/hosts"
`,
    );
    const r = bootstrapPermissionEngine(baseInput({ cwd: projDir }));
    expect(r.state).toBe('refusing');
    expect(r.refusingReason).toContain('policy_load_failed');
    expect(r.refusingReason).toContain('redefines a protected path');
  });

  test('broken chain + no override → refusing', async () => {
    const db = baseDb();
    // Bootstrap a chain row, then tamper.
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'boot-uuid-aaaa-bbbb',
    });
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'pre',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:x',
      reason_chain: [],
      ts: 1,
    });
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);

    const r = bootstrapPermissionEngine(baseInput({ db }));
    expect(r.state).toBe('refusing');
    expect(r.refusingReason).toContain('chain_broken');
    expect(r.chain.ok).toBe(false);
  });

  test('broken chain + acceptBrokenChain → ready, audit-loud', async () => {
    const db = baseDb();
    const identity = ensureInstallId({
      env: { HOME: tmpRoot },
      now: () => 1,
      uuid: () => 'boot-uuid-aaaa-bbbb',
    });
    const sink = createSqliteSink({ db, identity });
    sink.emit({
      session_id: 'pre',
      tool_name: 'bash',
      args: {},
      decision: 'allow',
      policy_hash: 'sha256:x',
      reason_chain: [],
      ts: 1,
    });
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);

    const r = bootstrapPermissionEngine(baseInput({ db, acceptBrokenChain: true }));
    expect(r.state).toBe('ready');
    // A `chain-break-accepted` audit row landed BEFORE the engine
    // started accepting decisions.
    const rows = listApprovalsLogByInstall(db, identity.install_id);
    const acceptedRow = rows.find((row) => row.reason_chain_json.includes('chain-break-accepted'));
    expect(acceptedRow).toBeDefined();
    expect(acceptedRow?.tool_name).toBe('permission-engine');
    expect(acceptedRow?.decision).toBe('allow');
  });
});

describe('bootstrapPermissionEngine — engine.state() honored after boot', () => {
  test('every transition is recorded in events', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    expect(r.events.length).toBe(3); // → loading → validating → ready
    expect(r.events[0]?.from).toBe('init');
    expect(r.events[r.events.length - 1]?.to).toBe('ready');
  });

  test('subsequent engine.degrade flows through the same controller', async () => {
    const r = bootstrapPermissionEngine(baseInput());
    r.engine.degrade('test_signal');
    expect(r.engine.state()).toBe('degraded');
    // The new transition shows up in the events list because the
    // controller and the engine share the same listener pipeline.
    // We don't assert on r.events here because the events array is
    // captured pre-engine — the spec is "controller is shared", so
    // checking engine.state() is what proves it.
  });
});
