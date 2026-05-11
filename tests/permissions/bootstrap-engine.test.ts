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
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.state).toBe('ready');
    expect(r.events.map((e) => e.to)).toEqual(['loading-policy', 'validating-chain', 'ready']);
    expect(r.refusingReason).toBeUndefined();
  });

  test('engine produced is in ready state', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.engine.state()).toBe('ready');
  });

  test('chain verifies clean on fresh install', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.chain.ok).toBe(true);
  });

  test('identity is created and persisted', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.identity.install_id).toBe('boot-uuid-aaaa-bbbb');
    expect(r.identity.created_at_ms).toBe(1);
  });

  test('audit sink is wired — engine emits to the same DB', async () => {
    const db = baseDb();
    const r = await bootstrapPermissionEngine(baseInput({ db }));
    // Hit the engine with one check; the audit row must land in
    // the shared DB.
    r.engine.check('bash', 'bash', { command: 'ls' });
    const rows = listApprovalsLogByInstall(db, r.identity.install_id);
    expect(rows.length).toBe(1);
    expect(rows[0]?.tool_name).toBe('bash');
  });

  test('returns layers, lockConflicts, provenance from resolver', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.layers).toEqual([]); // no policy files → default
    expect(r.lockConflicts).toEqual([]);
    expect(r.provenance.defaults).toBe('default');
  });
});

describe('bootstrapPermissionEngine — refusing paths', () => {
  test('install_id failure → refusing', async () => {
    const r = await bootstrapPermissionEngine(
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
    const r = await bootstrapPermissionEngine(baseInput({ cwd: projDir }));
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

    const r = await bootstrapPermissionEngine(baseInput({ db }));
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

    const r = await bootstrapPermissionEngine(baseInput({ db, acceptBrokenChain: true }));
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
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.events.length).toBe(3); // → loading → validating → ready
    expect(r.events[0]?.from).toBe('init');
    expect(r.events[r.events.length - 1]?.to).toBe('ready');
  });

  test('subsequent engine.degrade flows through the same controller', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    r.engine.degrade('test_signal');
    expect(r.engine.state()).toBe('degraded');
    // The new transition shows up in the events list because the
    // controller and the engine share the same listener pipeline.
    // We don't assert on r.events here because the events array is
    // captured pre-engine — the spec is "controller is shared", so
    // checking engine.state() is what proves it.
  });
});

describe('bootstrapPermissionEngine — policy_archive (§17 prerequisite)', () => {
  // Roundtrip invariant: the archived bytes regenerate the row's
  // policy_hash. Without this, replay can't reconstruct the policy
  // from the hash and the §17 modes would be non-deterministic.
  test('archives the active policy with bytes that roundtrip the hash', async () => {
    const db = baseDb();
    const r = await bootstrapPermissionEngine(baseInput({ db }));
    const { canonicalHash } = await import('../../src/permissions/canonical.ts');
    const { listPolicyArchive } = await import('../../src/storage/repos/policy-archive.ts');
    const archive = listPolicyArchive(db);
    expect(archive.length).toBe(1);
    const row = archive[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const parsed = JSON.parse(row.canonical_json);
    expect(`sha256:${canonicalHash(parsed)}`).toBe(row.policy_hash);
    // The engine's emit path tags audit rows with the SAME hash —
    // pin that linkage so a future divergence (e.g. engine stops
    // including a field in the canonical form) trips immediately.
    expect(r.engine.policy()).toEqual(parsed);
  });

  test('rebooting under the same policy upserts (no duplicates)', async () => {
    const db = baseDb();
    await bootstrapPermissionEngine(baseInput({ db, now: () => 1000 }));
    await bootstrapPermissionEngine(baseInput({ db, now: () => 2000 }));
    const { countPolicyArchive, listPolicyArchive } = await import(
      '../../src/storage/repos/policy-archive.ts'
    );
    expect(countPolicyArchive(db)).toBe(1);
    const row = listPolicyArchive(db)[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    // first_seen stays anchored at the first boot; last_seen advances.
    expect(row.first_seen_ms).toBe(1000);
    expect(row.last_seen_ms).toBe(2000);
  });

  test('refusing-state bootstrap does NOT archive (no replay-worthy decisions follow)', async () => {
    // Force a refusing bootstrap via malformed user policy.
    const userYaml = join(tmpRoot, '.config', 'agent', 'permissions.yaml');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpRoot, '.config', 'agent'), { recursive: true });
    writeFileSync(userYaml, 'this is: not :: valid: :: yaml: :');

    const db = baseDb();
    const r = await bootstrapPermissionEngine(baseInput({ db, userPath: userYaml }));
    expect(r.state).toBe('refusing');
    const { countPolicyArchive } = await import('../../src/storage/repos/policy-archive.ts');
    expect(countPolicyArchive(db)).toBe(0);
  });
});

describe('bootstrapPermissionEngine — §12.3 watchPolicy wire-up', () => {
  // The watcher itself is exhaustively tested in policy-watcher.test.ts;
  // these tests pin the bootstrap-side INTEGRATION: opt-in plumbing,
  // audit emission on reload events, and the refusing-state guard.

  test('watchPolicy omitted → result.policyWatcher is undefined', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.policyWatcher).toBeUndefined();
  });

  test('watchPolicy=false → result.policyWatcher is undefined', async () => {
    const r = await bootstrapPermissionEngine(baseInput({ watchPolicy: false }));
    expect(r.policyWatcher).toBeUndefined();
  });

  test('watchPolicy=true → policyWatcher attached, close() is a no-throw', async () => {
    let closeCalls = 0;
    const fakeWatcher = () => ({
      close: () => {
        closeCalls++;
      },
    });
    const r = await bootstrapPermissionEngine(
      baseInput({
        watchPolicy: true,
        policyWatcherExists: () => true,
        policyWatcherWatcher: fakeWatcher,
        policyWatcherSetTimer: () => null,
        policyWatcherClearTimer: () => {},
      }),
    );
    expect(r.policyWatcher).toBeDefined();
    expect(() => r.policyWatcher?.close()).not.toThrow();
    expect(closeCalls).toBeGreaterThan(0);
  });

  test('successful reload emits a policy-reloaded audit row with old/new hashes', async () => {
    // Write a USER policy that the bootstrap will load + the
    // watchAndReload will re-read after we mutate it.
    const userYaml = join(tmpRoot, 'user-permissions.yaml');
    writeFileSync(userYaml, 'defaults:\n  mode: strict\n');

    const db = baseDb();
    const captured: { cb: (() => void) | null } = { cb: null };
    const fakeWatcher = (_path: string, cb: () => void) => {
      captured.cb = cb;
      return { close: () => {} };
    };
    // Synchronous timer — the watcher's debounce becomes a no-op so
    // the reload happens during the captured-callback invocation.
    const syncTimer = (cb: () => void, _ms: number) => {
      cb();
      return null;
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        db,
        userPath: userYaml,
        watchPolicy: true,
        policyWatcherExists: () => true,
        policyWatcherWatcher: fakeWatcher,
        policyWatcherSetTimer: syncTimer,
        policyWatcherClearTimer: () => {},
      }),
    );
    expect(r.state).toBe('ready');
    expect(captured.cb).not.toBeNull();

    // Mutate the policy on disk and fire the captured fs event. The
    // engine will swap to the new policy and emit policy-reloaded.
    writeFileSync(userYaml, 'defaults:\n  mode: acceptEdits\n');
    captured.cb?.();

    const rows = listApprovalsLogByInstall(db, r.identity.install_id);
    const reloadRow = rows.find((row) => row.reason_chain_json.includes('policy-reloaded'));
    expect(reloadRow).toBeDefined();
    expect(reloadRow?.tool_name).toBe('permission-engine');
    expect(reloadRow?.decision).toBe('allow');
    expect(reloadRow?.reason_chain_json).toContain('old_hash=sha256:');
    expect(reloadRow?.reason_chain_json).toContain('new_hash=sha256:');
    // old_hash !== new_hash (the bytes really changed).
    if (reloadRow === undefined) return;
    const reasonChain = JSON.parse(reloadRow.reason_chain_json) as Array<{ note: string }>;
    const note = reasonChain[0]?.note ?? '';
    const old = /old_hash=(sha256:[a-f0-9]+)/.exec(note)?.[1];
    const next = /new_hash=(sha256:[a-f0-9]+)/.exec(note)?.[1];
    expect(old).toBeDefined();
    expect(next).toBeDefined();
    expect(old).not.toBe(next);
  });

  test('failed reload (malformed file) emits a policy-reload-failed audit row', async () => {
    const userYaml = join(tmpRoot, 'user-permissions.yaml');
    writeFileSync(userYaml, 'defaults:\n  mode: strict\n');

    const db = baseDb();
    const captured: { cb: (() => void) | null } = { cb: null };
    const fakeWatcher = (_path: string, cb: () => void) => {
      captured.cb = cb;
      return { close: () => {} };
    };
    const syncTimer = (cb: () => void, _ms: number) => {
      cb();
      return null;
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        db,
        userPath: userYaml,
        watchPolicy: true,
        policyWatcherExists: () => true,
        policyWatcherWatcher: fakeWatcher,
        policyWatcherSetTimer: syncTimer,
        policyWatcherClearTimer: () => {},
      }),
    );
    expect(r.state).toBe('ready');

    // Corrupt the policy: schema-invalid mode trips parsePolicy.
    writeFileSync(userYaml, 'defaults:\n  mode: not_a_real_mode\n');
    captured.cb?.();

    const rows = listApprovalsLogByInstall(db, r.identity.install_id);
    const failRow = rows.find((row) => row.reason_chain_json.includes('policy-reload-failed'));
    expect(failRow).toBeDefined();
    expect(failRow?.tool_name).toBe('permission-engine');
    expect(failRow?.decision).toBe('deny');
    // policy_hash on the failed row IS the still-authoritative
    // (pre-reload-attempt) hash — the engine never swapped.
    expect(failRow?.policy_hash).toBe(
      `sha256:${(await import('../../src/permissions/canonical.ts')).canonicalHash(r.engine.policy())}`,
    );
  });

  test('watchPolicy=true is skipped when bootstrap ends refusing', async () => {
    let watcherCalls = 0;
    const fakeWatcher = () => {
      watcherCalls++;
      return { close: () => {} };
    };
    // Force the install_id failure path → buildRefusingResult →
    // bootstrap returns BEFORE reaching the watcher wire-up.
    const r = await bootstrapPermissionEngine(
      baseInput({
        env: {},
        watchPolicy: true,
        policyWatcherExists: () => true,
        policyWatcherWatcher: fakeWatcher,
        policyWatcherSetTimer: () => null,
        policyWatcherClearTimer: () => {},
      }),
    );
    expect(r.state).toBe('refusing');
    expect(r.policyWatcher).toBeUndefined();
    expect(watcherCalls).toBe(0);
  });

  test('watchPolicy=true skipped when sandbox required+unavailable forces late refusing', async () => {
    // This is the SECOND refusing path — the late transition AFTER
    // archive but inside the same bootstrap body. The wire-up's
    // `archiveState !== 'refusing'` guard catches it before any
    // watcher attaches.
    let watcherCalls = 0;
    const fakeWatcher = () => {
      watcherCalls++;
      return { close: () => {} };
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        watchPolicy: true,
        sandbox: { available: false, hostExplicitlyAllowed: false, required: true },
        policyWatcherExists: () => true,
        policyWatcherWatcher: fakeWatcher,
        policyWatcherSetTimer: () => null,
        policyWatcherClearTimer: () => {},
      }),
    );
    expect(r.state).toBe('refusing');
    expect(r.policyWatcher).toBeUndefined();
    expect(watcherCalls).toBe(0);
  });
});
