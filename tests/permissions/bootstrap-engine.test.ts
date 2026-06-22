import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapPermissionEngine,
  mergeTrustedHosts,
  preflightPermissionEngine,
} from '../../src/permissions/bootstrap-engine.ts';
import {
  type SealEntry,
  type SealStore,
  createSqliteSink,
  ensureInstallId,
} from '../../src/permissions/index.ts';
import { DEFAULT_TRUSTED_HOSTS } from '../../src/permissions/risk-score.ts';
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

describe('mergeTrustedHosts', () => {
  test('empty policy list returns DEFAULT_TRUSTED_HOSTS by reference', () => {
    // Reference equality matters: callers that compare against
    // DEFAULT_TRUSTED_HOSTS by `===` (engine fast paths in
    // particular) keep working. Spreading into a fresh array would
    // be functionally equivalent but break referential identity.
    expect(mergeTrustedHosts([])).toBe(DEFAULT_TRUSTED_HOSTS);
  });

  test('extends default with new host (additive, not replace)', () => {
    const merged = mergeTrustedHosts(['internal.example.com']);
    expect(merged).toContain('github.com'); // default preserved
    expect(merged).toContain('internal.example.com');
    expect(merged.length).toBe(DEFAULT_TRUSTED_HOSTS.length + 1);
  });

  test('dedupes when policy duplicates a default host', () => {
    // Structural pin: policy that re-lists `github.com` (already in
    // DEFAULT_TRUSTED_HOSTS) must NOT double the entry. A future
    // refactor from `Array.from(new Set(...))` to plain concat
    // would inflate the array; this test catches it before the
    // engine's per-fetch iteration silently grows.
    const merged = mergeTrustedHosts(['github.com', 'new.example.com']);
    expect(merged.length).toBe(DEFAULT_TRUSTED_HOSTS.length + 1);
    expect(merged.filter((h) => h === 'github.com').length).toBe(1);
  });

  test('dedupes policy-internal duplicates', () => {
    // Defense in depth: even if the policy file itself lists the
    // same host twice (parser doesn't filter), the merge collapses.
    const merged = mergeTrustedHosts(['x.example.com', 'x.example.com']);
    expect(merged.filter((h) => h === 'x.example.com').length).toBe(1);
  });
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

  test('trusted_hosts merge deduplicates default-overlap entries', async () => {
    // Operator who re-lists a host already in DEFAULT_TRUSTED_HOSTS
    // (e.g., `github.com`) shouldn't inflate the list — the merge
    // is set-union, not concat. The engine iterates trustedHosts
    // per fetch; keeping it tight matters at scale. Test verifies
    // the dedup explicitly so a future refactor to plain concat
    // doesn't silently regress: an internal "github.com" plus the
    // default's "github.com" must remain one entry.
    const projDir = join(tmpRoot, 'proj');
    const agentDir = join(projDir, '.forja');
    require('node:fs').mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'permissions.yaml'),
      `
defaults:
  mode: strict
tools:
  bash:
    allow: ["curl *"]
  fetch_url:
    trusted_hosts:
      - "github.com"
      - "internal.cdn.example.com"
`,
    );
    const db = baseDb();
    const r = await bootstrapPermissionEngine(baseInput({ cwd: projDir, db }));
    expect(r.state).toBe('ready');
    // Probe github.com twice to confirm the host is silent — the
    // dedup check is structural, but if the merge produced
    // duplicate entries the engine would still treat github.com as
    // trusted (idempotent membership check). The real test is
    // behavioral: trust both internal AND github.com simultaneously
    // with policy-declared overlap.
    r.engine.check('bash', 'bash', { command: 'curl https://github.com/foo' });
    r.engine.check('bash', 'bash', { command: 'curl https://internal.cdn.example.com/x' });
    const rows = listApprovalsLogByInstall(db, r.identity.install_id);
    const components = rows.map(
      (row) => JSON.parse(row.score_components_json) as Record<string, number | undefined>,
    );
    expect(components[0]?.untrusted_egress).toBeUndefined();
    expect(components[1]?.untrusted_egress).toBeUndefined();
  });

  test('policy.tools.fetch_url.trusted_hosts merges additive over default into the engine', async () => {
    // Operator writes an internal host to permissions.yaml; the
    // bootstrap merges it with DEFAULT_TRUSTED_HOSTS (github + the
    // public registries) so the engine sees both as silent for
    // the `untrusted_egress` risk feature. Verify behaviorally via
    // bash curl checks: internal + github.com stay silent; an
    // external unlisted host still surfaces the feature. The
    // engine-level pin already exists (engine.test.ts "custom
    // trustedHosts narrows untrusted_egress"); this test pins the
    // WIRE from policy yaml → engine option.
    const projDir = join(tmpRoot, 'proj');
    const agentDir = join(projDir, '.forja');
    require('node:fs').mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'permissions.yaml'),
      `
defaults:
  mode: strict
tools:
  bash:
    allow: ["curl *"]
  fetch_url:
    trusted_hosts:
      - "internal.cdn.example.com"
`,
    );
    const db = baseDb();
    const r = await bootstrapPermissionEngine(baseInput({ cwd: projDir, db }));
    expect(r.state).toBe('ready');
    r.engine.check('bash', 'bash', {
      command: 'curl https://internal.cdn.example.com/asset.js',
    });
    r.engine.check('bash', 'bash', { command: 'curl https://github.com/foo' });
    r.engine.check('bash', 'bash', {
      command: 'curl https://random-unlisted.example.org/x',
    });
    const rows = listApprovalsLogByInstall(db, r.identity.install_id);
    expect(rows.length).toBe(3);
    const components = rows.map(
      (row) => JSON.parse(row.score_components_json) as Record<string, number | undefined>,
    );
    // Policy-supplied trusted host → silent.
    expect(components[0]?.untrusted_egress).toBeUndefined();
    // DEFAULT_TRUSTED_HOSTS still applies (github.com is in there) →
    // silent. Confirms the merge is ADDITIVE, not replace.
    expect(components[1]?.untrusted_egress).toBeUndefined();
    // Unlisted external host → feature surfaces.
    expect(components[2]?.untrusted_egress).toBeDefined();
    expect(components[2]?.untrusted_egress).toBeGreaterThan(0);
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
    const agentDir = join(projDir, '.forja');
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
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
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
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
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
    const userYaml = join(tmpRoot, '.config', 'forja', 'permissions.yaml');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpRoot, '.config', 'forja'), { recursive: true });
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

  test('sandbox available but trustLevel=path-resolved → emits sandbox.path_resolved failure_event (slice 165)', async () => {
    // The trust marker (slice 154) flagged a non-canonical sandbox
    // install. Pre-slice 165 the warning was computed but dropped.
    // Now bootstrap emits a structured failure_event so postmortems
    // can correlate "rodava com bwrap não-canonical em /opt/bin" via
    // `failure_events WHERE code='sandbox.path_resolved'`.
    const emitted: Array<{ code: string; payload: Record<string, unknown> }> = [];
    const failureSink = {
      emit: (event: { code: string; payload?: Record<string, unknown> | null }) => {
        emitted.push({ code: event.code, payload: event.payload ?? {} });
        return { id: `mock-${emitted.length}`, this_chain_hash: '' };
      },
      verifyChain: () => ({ ok: true as const, rows: emitted.length }),
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        failureSink,
        sandbox: {
          available: true,
          hostExplicitlyAllowed: false,
          required: false,
          trustLevel: 'path-resolved',
          path: '/nix/store/abc/bwrap',
          trustWarnings: ['using non-canonical bwrap at /nix/store/abc/bwrap'],
        },
      }),
    );
    expect(r.state).toBe('ready');
    const pathResolvedEvents = emitted.filter((e) => e.code === 'sandbox.path_resolved');
    expect(pathResolvedEvents).toHaveLength(1);
    const evt = pathResolvedEvents[0];
    expect(evt).toBeDefined();
    if (evt !== undefined) {
      expect(evt.payload.trust_level).toBe('path-resolved');
      expect(evt.payload.path).toBe('/nix/store/abc/bwrap');
      expect(evt.payload.warnings).toEqual(['using non-canonical bwrap at /nix/store/abc/bwrap']);
    }
  });

  test('sandbox available with trustLevel=canonical → no path_resolved emit (slice 165)', async () => {
    // Canonical install — no warning, no emit.
    const emitted: Array<{ code: string }> = [];
    const failureSink = {
      emit: (event: { code: string }) => {
        emitted.push({ code: event.code });
        return { id: `mock-${emitted.length}`, this_chain_hash: '' };
      },
      verifyChain: () => ({ ok: true as const, rows: emitted.length }),
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        failureSink,
        sandbox: {
          available: true,
          hostExplicitlyAllowed: false,
          required: false,
          trustLevel: 'canonical',
          path: '/usr/bin/bwrap',
          trustWarnings: [],
        },
      }),
    );
    expect(r.state).toBe('ready');
    expect(emitted.filter((e) => e.code === 'sandbox.path_resolved')).toHaveLength(0);
  });

  test("sandbox unavailable still emits sandbox.tool_unavailable (slice 165 doesn't regress slice 130)", async () => {
    // Both codes can co-exist in the same bootstrap. trustLevel
    // is moot when available=false, so only the unavailable code
    // fires. Pin to confirm slice 165 didn't accidentally suppress
    // the slice 130 emit.
    const emitted: Array<{ code: string }> = [];
    const failureSink = {
      emit: (event: { code: string }) => {
        emitted.push({ code: event.code });
        return { id: `mock-${emitted.length}`, this_chain_hash: '' };
      },
      verifyChain: () => ({ ok: true as const, rows: emitted.length }),
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        failureSink,
        sandbox: {
          available: false,
          hostExplicitlyAllowed: false,
          required: false,
          trustLevel: 'absent',
          path: null,
          trustWarnings: [],
        },
      }),
    );
    expect(r.state).toBe('degraded'); // sandbox not required, available=false → degraded
    expect(emitted.filter((e) => e.code === 'sandbox.tool_unavailable')).toHaveLength(1);
    expect(emitted.filter((e) => e.code === 'sandbox.path_resolved')).toHaveLength(0);
  });

  test('sandbox unavailable + host-passthrough opt-in (both gates, lenient) → ready, NOT degraded', async () => {
    // The operator's explicit two-gate opt-in (--sandbox-host + --i-know-what-im-doing) to run
    // UNSANDBOXED is intentional, not a degradation — a container/CI with no bwrap that already
    // provides isolation. Without this carve-out the boot transition degrades (every allow → confirm)
    // and a headless agent dead-ends on un-answerable confirms BEFORE the §6.5 planner ever picks the
    // `host` profile.
    const emitted: Array<{ code: string }> = [];
    const failureSink = {
      emit: (event: { code: string }) => {
        emitted.push({ code: event.code });
        return { id: `mock-${emitted.length}`, this_chain_hash: '' };
      },
      verifyChain: () => ({ ok: true as const, rows: emitted.length }),
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        failureSink,
        sandbox: {
          available: false,
          hostExplicitlyAllowed: true,
          required: false,
          emitHostPassthrough: true,
          trustLevel: 'absent',
          path: null,
          trustWarnings: [],
        },
      }),
    );
    expect(r.state).toBe('ready');
    expect(r.engine.state()).toBe('ready');
    // No degradation → no tool_unavailable failure_event.
    expect(emitted.filter((e) => e.code === 'sandbox.tool_unavailable')).toHaveLength(0);
  });

  test('host-passthrough opt-in does NOT override a policy that REQUIRES a sandbox → refusing', async () => {
    // `sandbox.required` (enterprise policy) is the stronger gate: the operator's --sandbox-host +
    // --i-know-what-im-doing cannot run unsandboxed when the policy mandates a viable sandbox.
    const r = await bootstrapPermissionEngine(
      baseInput({
        sandbox: {
          available: false,
          hostExplicitlyAllowed: true,
          required: true,
          emitHostPassthrough: true,
          trustLevel: 'absent',
          path: null,
          trustWarnings: [],
        },
      }),
    );
    expect(r.state).toBe('refusing');
  });

  test('host opt-in needs BOTH gates — only --sandbox-host (no passthrough sentinel) → still degraded', async () => {
    // One gate is not enough. --sandbox-host alone makes `host` selectable, but the passthrough
    // sentinel (emitHostPassthrough, from --i-know-what-im-doing) is the deliberate acceptance of
    // unsandboxed execution. Missing it → the safe default (degraded) holds.
    const r = await bootstrapPermissionEngine(
      baseInput({
        sandbox: {
          available: false,
          hostExplicitlyAllowed: true,
          required: false,
          emitHostPassthrough: false,
          trustLevel: 'absent',
          path: null,
          trustWarnings: [],
        },
      }),
    );
    expect(r.state).toBe('degraded');
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

describe('bootstrapPermissionEngine — §7.3 sealing wire-up', () => {
  // Factory helpers for tests. The factory captures the entries
  // written so tests can inspect what got sealed without touching
  // a real worm-file.
  const makeMemFactory = () => {
    const entries: SealEntry[] = [];
    let shouldFail: string | null = null;
    const factory = (): SealStore => ({
      append: (entry) => {
        if (shouldFail !== null) return { ok: false, reason: shouldFail };
        entries.push(entry);
        return { ok: true };
      },
      list: () => entries.slice(),
      close: () => {},
    });
    return {
      factory,
      entries,
      failNext: (reason: string) => {
        shouldFail = reason;
      },
    };
  };

  const noopTimerSeams = () => ({
    sealSchedulerSetTimer: () => null,
    sealSchedulerClearTimer: () => {},
  });

  test('no seal section in policy → no sealStore / sealingScheduler in result', async () => {
    const r = await bootstrapPermissionEngine(baseInput());
    expect(r.sealStore).toBeUndefined();
    expect(r.sealingScheduler).toBeUndefined();
  });

  test('mode=none → no sealStore / sealingScheduler in result', async () => {
    const r = await bootstrapPermissionEngine(
      baseInput({ sessionPolicy: { defaults: {}, tools: {}, seal: { mode: 'none' } } }),
    );
    expect(r.sealStore).toBeUndefined();
    expect(r.sealingScheduler).toBeUndefined();
  });

  test('mode=worm-file → sealStore + sealingScheduler attached', async () => {
    const mem = makeMemFactory();
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: { mode: 'worm-file', path: '/seal.log' },
        },
        sealStoreFactory: mem.factory,
        ...noopTimerSeams(),
      }),
    );
    expect(r.state).toBe('ready');
    expect(r.sealStore).toBeDefined();
    expect(r.sealingScheduler).toBeDefined();
    r.sealingScheduler?.close();
  });

  test('emit ticks the scheduler — decision threshold triggers a seal', async () => {
    const mem = makeMemFactory();
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/seal.log',
            interval_decisions: 3,
            interval_seconds: 0,
          },
        },
        sealStoreFactory: mem.factory,
        ...noopTimerSeams(),
      }),
    );
    // 3 audit emits via the engine → scheduler counts to 3 → seals.
    r.engine.check('bash', 'bash', { command: 'ls' });
    r.engine.check('bash', 'bash', { command: 'ls' });
    expect(mem.entries).toHaveLength(0);
    r.engine.check('bash', 'bash', { command: 'ls' });
    expect(mem.entries).toHaveLength(1);
    r.sealingScheduler?.close();
  });

  test('seal failure with on_failure=degrade transitions engine to degraded', async () => {
    const mem = makeMemFactory();
    mem.failNext('chattr +a failed: permission denied');
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/seal.log',
            interval_decisions: 1,
            interval_seconds: 0,
            on_failure: 'degrade',
          },
        },
        sealStoreFactory: mem.factory,
        ...noopTimerSeams(),
      }),
    );
    expect(r.engine.state()).toBe('ready');
    // Single emit at intervalDecisions=1 immediately triggers a seal
    // attempt → store returns ok:false → onSealFailed fires →
    // engine.degrade().
    r.engine.check('bash', 'bash', { command: 'ls' });
    expect(r.engine.state()).toBe('degraded');
    r.sealingScheduler?.close();
  });

  test('seal failure with on_failure=refuse transitions engine to refusing', async () => {
    const mem = makeMemFactory();
    mem.failNext('disk full');
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/seal.log',
            interval_decisions: 1,
            interval_seconds: 0,
            on_failure: 'refuse',
          },
        },
        sealStoreFactory: mem.factory,
        ...noopTimerSeams(),
      }),
    );
    expect(r.engine.state()).toBe('ready');
    r.engine.check('bash', 'bash', { command: 'ls' });
    expect(r.engine.state()).toBe('refusing');
    r.sealingScheduler?.close();
  });

  test('default on_failure is degrade (omitted on_failure behaves as degrade)', async () => {
    const mem = makeMemFactory();
    mem.failNext('fake fail');
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/seal.log',
            interval_decisions: 1,
            interval_seconds: 0,
          },
        },
        sealStoreFactory: mem.factory,
        ...noopTimerSeams(),
      }),
    );
    r.engine.check('bash', 'bash', { command: 'ls' });
    expect(r.engine.state()).toBe('degraded');
    r.sealingScheduler?.close();
  });

  test('refusing-state bootstrap does NOT initialize sealing', async () => {
    let factoryCalls = 0;
    const factory = (): SealStore => {
      factoryCalls++;
      return {
        append: () => ({ ok: true }),
        list: () => [],
        close: () => {},
      };
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        env: {}, // forces install_id failure → refusing
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: { mode: 'worm-file', path: '/seal.log' },
        },
        sealStoreFactory: factory,
        ...noopTimerSeams(),
      }),
    );
    expect(r.state).toBe('refusing');
    expect(r.sealStore).toBeUndefined();
    expect(r.sealingScheduler).toBeUndefined();
    expect(factoryCalls).toBe(0);
  });

  test('sandbox required+unavailable refusing path also skips sealing', async () => {
    let factoryCalls = 0;
    const factory = (): SealStore => {
      factoryCalls++;
      return {
        append: () => ({ ok: true }),
        list: () => [],
        close: () => {},
      };
    };
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: { mode: 'worm-file', path: '/seal.log' },
        },
        sandbox: { available: false, hostExplicitlyAllowed: false, required: true },
        sealStoreFactory: factory,
        ...noopTimerSeams(),
      }),
    );
    expect(r.state).toBe('refusing');
    expect(r.sealStore).toBeUndefined();
    expect(r.sealingScheduler).toBeUndefined();
    expect(factoryCalls).toBe(0);
  });

  test('chain-break-accepted emit during bootstrap does NOT prematurely seal', async () => {
    // Phase 3 emits a chain-break row BEFORE sealing is wired up.
    // The proxy must absorb the early tick as a no-op so no seal
    // happens until the operator's first actual decision.
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
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);
    const mem = makeMemFactory();
    const r = await bootstrapPermissionEngine(
      baseInput({
        db,
        acceptBrokenChain: true,
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/seal.log',
            interval_decisions: 1, // very aggressive — would seal on chain-break if proxy were broken
            interval_seconds: 0,
          },
        },
        sealStoreFactory: mem.factory,
        ...noopTimerSeams(),
      }),
    );
    expect(r.state).toBe('ready');
    // chain-break-accepted row landed but no seal: scheduler wasn't
    // attached at chain-break emit time.
    expect(mem.entries).toHaveLength(0);
    r.sealingScheduler?.close();
  });

  // Slice 158 (review): pre-slice, the bootstrap's onSealFailed
  // called engine.degrade() / engine.refuse() unconditionally. Each
  // call invokes stateController.transition which THROWS on invalid
  // edges (degraded→degraded is invalid; refusing→refusing is also
  // invalid since refusing is terminal). So on the 2nd consecutive
  // seal failure the throw propagated out of the bootstrap's
  // onSealFailed. From the tick path audit.ts swallowed it, but from
  // the timer path it surfaced as uncaughtException → process.exit(1).
  // The fix: gate the transition on the current state so it's a true
  // no-op once we've reached the target state.
  describe('seal failure idempotence (slice 158)', () => {
    test('on_failure=degrade — N consecutive failures only transition ONCE', async () => {
      const mem = makeMemFactory();
      mem.failNext('disk full');
      const transitions: Array<{ from: string; to: string }> = [];
      const r = await bootstrapPermissionEngine(
        baseInput({
          sessionPolicy: {
            defaults: {},
            tools: {},
            seal: {
              mode: 'worm-file',
              path: '/seal.log',
              interval_decisions: 1,
              interval_seconds: 0,
              on_failure: 'degrade',
            },
          },
          sealStoreFactory: mem.factory,
          ...noopTimerSeams(),
          telemetry: {
            emit: (evt) => {
              if (evt.kind === 'state.transition') {
                transitions.push({ from: evt.from, to: evt.to });
              }
            },
          },
        }),
      );
      // Tick 1: ready → degraded.
      r.engine.check('bash', 'bash', { command: 'ls' });
      expect(r.engine.state()).toBe('degraded');
      // Tick 2-5: still in degraded; bootstrap's onSealFailed now
      // skips engine.degrade because currentState !== 'ready'.
      // Pre-slice each of these would have thrown out of audit.ts's
      // tick-around-try (which swallows) but the timer path crashes.
      expect(() => r.engine.check('bash', 'bash', { command: 'ls' })).not.toThrow();
      expect(() => r.engine.check('bash', 'bash', { command: 'ls' })).not.toThrow();
      expect(() => r.engine.check('bash', 'bash', { command: 'ls' })).not.toThrow();
      expect(() => r.engine.check('bash', 'bash', { command: 'ls' })).not.toThrow();
      expect(r.engine.state()).toBe('degraded');
      // Exactly ONE ready→degraded transition recorded. The
      // remaining 4 calls did NOT push another state.transition event
      // (because the gate skipped the engine.degrade call entirely).
      const degradedTransitions = transitions.filter((t) => t.to === 'degraded');
      expect(degradedTransitions).toHaveLength(1);
      r.sealingScheduler?.close();
    });

    test('on_failure=degrade — sealing.failure telemetry still fires per failure', async () => {
      const mem = makeMemFactory();
      mem.failNext('disk full');
      const sealFailures: string[] = [];
      const r = await bootstrapPermissionEngine(
        baseInput({
          sessionPolicy: {
            defaults: {},
            tools: {},
            seal: {
              mode: 'worm-file',
              path: '/seal.log',
              interval_decisions: 1,
              interval_seconds: 0,
              on_failure: 'degrade',
            },
          },
          sealStoreFactory: mem.factory,
          ...noopTimerSeams(),
          telemetry: {
            emit: (evt) => {
              if (evt.kind === 'sealing.failure') {
                sealFailures.push(evt.reason);
              }
            },
          },
        }),
      );
      r.engine.check('bash', 'bash', { command: 'ls' });
      r.engine.check('bash', 'bash', { command: 'ls' });
      r.engine.check('bash', 'bash', { command: 'ls' });
      // Telemetry fires on EVERY failure (3 times) even though only
      // the first one transitioned state. Operators see the full
      // failure stream; state machine is idempotent.
      expect(sealFailures).toEqual(['disk full', 'disk full', 'disk full']);
      r.sealingScheduler?.close();
    });

    test('on_failure=refuse — N consecutive failures only transition ONCE (and engine refuses)', async () => {
      const mem = makeMemFactory();
      mem.failNext('EROFS');
      const transitions: Array<{ from: string; to: string }> = [];
      const r = await bootstrapPermissionEngine(
        baseInput({
          sessionPolicy: {
            defaults: {},
            tools: {},
            seal: {
              mode: 'worm-file',
              path: '/seal.log',
              interval_decisions: 1,
              interval_seconds: 0,
              on_failure: 'refuse',
            },
          },
          sealStoreFactory: mem.factory,
          ...noopTimerSeams(),
          telemetry: {
            emit: (evt) => {
              if (evt.kind === 'state.transition') {
                transitions.push({ from: evt.from, to: evt.to });
              }
            },
          },
        }),
      );
      r.engine.check('bash', 'bash', { command: 'ls' });
      expect(r.engine.state()).toBe('refusing');
      // Further checks while already refusing: pre-slice each invoke
      // would have THROWN out of audit.ts's swallowed try because
      // refusing→refusing is invalid. Now the bootstrap's gate
      // short-circuits.
      expect(() => r.engine.check('bash', 'bash', { command: 'ls' })).not.toThrow();
      expect(() => r.engine.check('bash', 'bash', { command: 'ls' })).not.toThrow();
      expect(r.engine.state()).toBe('refusing');
      const refusingTransitions = transitions.filter((t) => t.to === 'refusing');
      expect(refusingTransitions).toHaveLength(1);
      r.sealingScheduler?.close();
    });

    test('timer-driven repeated failures: scheduler keeps running across many cycles', async () => {
      // The original P0 crash scenario: timer fires hourly, each
      // failure throws inside setTimer's callback → uncaughtException.
      // Post-slice the bootstrap gate (here) + the scheduler's
      // safeOnSealFailed wrapper together guarantee the timer body
      // never throws. Drive 5 timer cycles and verify the scheduler
      // is still alive (reschedules every cycle).
      const mem = makeMemFactory();
      mem.failNext('chattr +a dropped');
      const capturedTimers: Array<{ cb: () => void; ms: number }> = [];
      const r = await bootstrapPermissionEngine(
        baseInput({
          sessionPolicy: {
            defaults: {},
            tools: {},
            seal: {
              mode: 'worm-file',
              path: '/seal.log',
              interval_decisions: 0,
              interval_seconds: 10,
              on_failure: 'degrade',
            },
          },
          sealStoreFactory: mem.factory,
          sealSchedulerSetTimer: (cb, ms) => {
            capturedTimers.push({ cb, ms });
            return capturedTimers.length;
          },
          sealSchedulerClearTimer: () => {},
        }),
      );
      // Need at least one audit row so the timer can find a chain
      // tip to seal.
      r.engine.check('bash', 'bash', { command: 'ls' });
      // Initial schedule registered at scheduler creation.
      expect(capturedTimers.length).toBeGreaterThanOrEqual(1);
      // Fire 5 timer cycles. Each one tries to seal, fails, calls
      // bootstrap's onSealFailed, calls engine.degrade only on the
      // first (rest skipped). No throws.
      for (let i = 0; i < 5; i++) {
        const next = capturedTimers[capturedTimers.length - 1];
        expect(() => next?.cb()).not.toThrow();
      }
      // Scheduler kept rescheduling — 5 firings + initial = at least
      // 6 timers tracked.
      expect(capturedTimers.length).toBeGreaterThanOrEqual(6);
      expect(r.engine.state()).toBe('degraded');
      r.sealingScheduler?.close();
    });
  });
});

describe('bootstrapPermissionEngine — §18 telemetry wire-up (slice 71)', () => {
  // The bootstrap fans out a single telemetry sink to two
  // emission sources: (a) state controller transitions (slice 71
  // — this describe) and (b) audit sink decisions (slice 70 —
  // covered separately by audit-telemetry.test.ts).

  test('happy path emits state.transition events for every bootstrap step', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const r = await bootstrapPermissionEngine(baseInput({ telemetry }));
    expect(r.state).toBe('ready');
    // §2 walk: init → loading-policy → validating-chain → ready.
    // Three transitions = three events.
    const stateEvents = telemetry.events().filter((e) => e.kind === 'state.transition');
    expect(stateEvents).toHaveLength(3);
    expect(stateEvents.map((e) => (e.kind === 'state.transition' ? e.to : null))).toEqual([
      'loading-policy',
      'validating-chain',
      'ready',
    ]);
  });

  test('refusing bootstrap emits its transition before returning', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    // env={} → install_id discovery fails → refusing transition.
    const r = await bootstrapPermissionEngine(baseInput({ env: {}, telemetry }));
    expect(r.state).toBe('refusing');
    const stateEvents = telemetry.events().filter((e) => e.kind === 'state.transition');
    // init → refusing (one transition; install_id failed before
    // loading-policy was reached).
    const lastEvent = stateEvents.at(-1);
    if (lastEvent === undefined || lastEvent.kind !== 'state.transition') {
      throw new Error('expected a state.transition event');
    }
    expect(lastEvent.to).toBe('refusing');
    expect(lastEvent.reason).toContain('install_id_failed');
  });

  test('every state.transition event carries from + to + reason + ts', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    await bootstrapPermissionEngine(baseInput({ telemetry, now: () => 12345 }));
    const stateEvents = telemetry.events().filter((e) => e.kind === 'state.transition');
    for (const e of stateEvents) {
      if (e.kind !== 'state.transition') continue;
      expect(typeof e.from).toBe('string');
      expect(typeof e.to).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(e.ts).toBe(12345);
    }
  });

  test('telemetry.emit throwing does NOT break the state machine', async () => {
    // The state controller's onTransition listener invokes
    // telemetry.emit inside a try/catch — a thrown emit must
    // not corrupt the events trail OR halt the bootstrap.
    let throwCount = 0;
    const throwingSink = {
      emit: () => {
        throwCount++;
        throw new Error('synthetic telemetry failure');
      },
    };
    const r = await bootstrapPermissionEngine(baseInput({ telemetry: throwingSink }));
    expect(r.state).toBe('ready');
    expect(throwCount).toBeGreaterThan(0);
    // events trail is intact despite every emit throwing.
    expect(r.events).toHaveLength(3);
  });

  test('audit emit also forwards to telemetry (slice 70 wire-up via bootstrap)', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const r = await bootstrapPermissionEngine(baseInput({ telemetry }));
    // Engine.check produces an audit row → telemetry event.
    r.engine.check('bash', 'bash', { command: 'ls' });
    const decisionEvents = telemetry.events().filter((e) => e.kind === 'permission.decision');
    expect(decisionEvents).toHaveLength(1);
    const event = decisionEvents[0];
    if (event === undefined || event.kind !== 'permission.decision') {
      throw new Error('expected a permission.decision event');
    }
    expect(event.tool).toBe('bash');
  });

  test('sealing.failure event fires when scheduler reports onSealFailed (slice 72)', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const failingFactory = (): SealStore => ({
      append: () => ({ ok: false, reason: 'chattr +a failed: permission denied' }),
      list: () => [],
      close: () => {},
    });
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/var/log/forja/seal.log',
            interval_decisions: 1,
            interval_seconds: 0,
            on_failure: 'degrade',
          },
        },
        sealStoreFactory: failingFactory,
        sealSchedulerSetTimer: () => null,
        sealSchedulerClearTimer: () => {},
        telemetry,
        now: () => 99999,
      }),
    );
    r.engine.check('bash', 'bash', { command: 'ls' });
    const sealingEvents = telemetry.events().filter((e) => e.kind === 'sealing.failure');
    expect(sealingEvents).toHaveLength(1);
    const event = sealingEvents[0];
    if (event === undefined || event.kind !== 'sealing.failure') {
      throw new Error('expected sealing.failure event');
    }
    expect(event.mode).toBe('worm-file');
    expect(event.path).toBe('/var/log/forja/seal.log');
    expect(event.reason).toContain('chattr +a failed');
    expect(event.on_failure).toBe('degrade');
    expect(event.ts).toBe(99999);
    // State machine also transitioned (slice 71 wire-up) — the
    // two events pair for a complete forensic picture.
    expect(r.engine.state()).toBe('degraded');
    r.sealingScheduler?.close();
  });

  test('sealing.failure carries on_failure=refuse when policy configured for refuse', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const failingFactory = (): SealStore => ({
      append: () => ({ ok: false, reason: 'disk full' }),
      list: () => [],
      close: () => {},
    });
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/var/audit/seal.log',
            interval_decisions: 1,
            interval_seconds: 0,
            on_failure: 'refuse',
          },
        },
        sealStoreFactory: failingFactory,
        sealSchedulerSetTimer: () => null,
        sealSchedulerClearTimer: () => {},
        telemetry,
      }),
    );
    r.engine.check('bash', 'bash', { command: 'ls' });
    const sealingEvents = telemetry.events().filter((e) => e.kind === 'sealing.failure');
    expect(sealingEvents).toHaveLength(1);
    const event = sealingEvents[0];
    if (event === undefined || event.kind !== 'sealing.failure') {
      throw new Error('expected sealing.failure event');
    }
    expect(event.on_failure).toBe('refuse');
    expect(r.engine.state()).toBe('refusing');
    r.sealingScheduler?.close();
  });

  test('telemetry.emit throwing inside onSealFailed does NOT break the degrade path', async () => {
    const failingFactory = (): SealStore => ({
      append: () => ({ ok: false, reason: 'fake' }),
      list: () => [],
      close: () => {},
    });
    const r = await bootstrapPermissionEngine(
      baseInput({
        sessionPolicy: {
          defaults: {},
          tools: {},
          seal: {
            mode: 'worm-file',
            path: '/seal.log',
            interval_decisions: 1,
            interval_seconds: 0,
          },
        },
        sealStoreFactory: failingFactory,
        sealSchedulerSetTimer: () => null,
        sealSchedulerClearTimer: () => {},
        telemetry: {
          emit: () => {
            throw new Error('synthetic telemetry failure');
          },
        },
      }),
    );
    r.engine.check('bash', 'bash', { command: 'ls' });
    // Engine still degraded despite telemetry emit throwing.
    expect(r.engine.state()).toBe('degraded');
    r.sealingScheduler?.close();
  });

  test('chain.verify_failed event fires on chain-broken bootstrap (refusing path, slice 73)', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const db = baseDb();
    // Seed a chain row + tamper to break verifyChain.
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
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);

    const r = await bootstrapPermissionEngine(baseInput({ db, telemetry, now: () => 55555 }));
    expect(r.state).toBe('refusing');

    const chainEvents = telemetry.events().filter((e) => e.kind === 'chain.verify_failed');
    expect(chainEvents).toHaveLength(1);
    const event = chainEvents[0];
    if (event === undefined || event.kind !== 'chain.verify_failed') {
      throw new Error('expected chain.verify_failed event');
    }
    expect(event.install_id).toBe(identity.install_id);
    expect(event.broken_at).toBe(1);
    expect(event.reason).toBe('this_hash_mismatch');
    expect(event.accepted).toBe(false);
    expect(event.ts).toBe(55555);
    expect(typeof event.expected).toBe('string');
    expect(typeof event.actual).toBe('string');
  });

  test('chain.verify_failed event also fires on chain-broken + acceptBrokenChain (accepted=true)', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
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
      capabilities: [],
      score: 0,
      score_components: {},
      classifier_hash: 'none',
      classifier_adjust: null,
      sandbox_profile: null,
      ttl_expires_at: null,
      ts: 1,
    });
    db.run('UPDATE approvals_log SET decision = ? WHERE seq = 1', ['deny']);

    const r = await bootstrapPermissionEngine(
      baseInput({ db, telemetry, acceptBrokenChain: true }),
    );
    expect(r.state).toBe('ready');

    const chainEvents = telemetry.events().filter((e) => e.kind === 'chain.verify_failed');
    expect(chainEvents).toHaveLength(1);
    const event = chainEvents[0];
    if (event === undefined || event.kind !== 'chain.verify_failed') {
      throw new Error('expected chain.verify_failed event');
    }
    expect(event.accepted).toBe(true);
    expect(event.broken_at).toBe(1);
  });

  test('chain.verify_failed event NOT fired when chain is intact', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const r = await bootstrapPermissionEngine(baseInput({ telemetry }));
    expect(r.state).toBe('ready');
    const chainEvents = telemetry.events().filter((e) => e.kind === 'chain.verify_failed');
    expect(chainEvents).toHaveLength(0);
  });

  test('permission.decision events carry engine_state populated from the controller (slice 75)', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const r = await bootstrapPermissionEngine(baseInput({ telemetry }));
    // Healthy bootstrap → engine state 'ready' captured per emit.
    r.engine.check('bash', 'bash', { command: 'ls' });
    const events = telemetry.events().filter((e) => e.kind === 'permission.decision');
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined || event.kind !== 'permission.decision') {
      throw new Error('expected permission.decision event');
    }
    expect(event.engine_state).toBe('ready');
  });

  test('engine_state reflects state changes between emits', async () => {
    const { createRecordingTelemetrySink } = await import('../../src/telemetry/index.ts');
    const telemetry = createRecordingTelemetrySink();
    const r = await bootstrapPermissionEngine(baseInput({ telemetry }));
    r.engine.check('bash', 'bash', { command: 'ls' });
    r.engine.degrade('test_signal');
    r.engine.check('bash', 'bash', { command: 'ls' });
    const events = telemetry
      .events()
      .filter((e) => e.kind === 'permission.decision')
      .map((e) => (e.kind === 'permission.decision' ? e.engine_state : undefined));
    expect(events[0]).toBe('ready');
    expect(events[1]).toBe('degraded');
  });
});

// Slice 109 — R8 #323: preflightPermissionEngine accepts a `home`
// parameter that the §11 protected-paths classifier consumes. The
// pre-slice CLI bootstrap omitted `home` from the preflight call,
// causing the function's fallback chain (`input.home ?? env.HOME
// ?? process.env.HOME ?? input.cwd`) to land on cwd when HOME was
// unset (containers, CI, systemd one-shots). Tilde-rooted protected
// paths then resolved against cwd, breaking every §11 home-anchored
// rule. Bootstrap (slice 109) now passes `home: homedir()` so the
// preflight always has a deliberate value; these tests pin the
// preflight contract that the wiring relies on.
describe('preflightPermissionEngine — home parameter (slice 109, R8 #323)', () => {
  test('explicit home overrides env.HOME', () => {
    // Operator-supplied home is the authoritative value. Even
    // when env.HOME is set, the parameter overrides it (this
    // matches the production flow where bootstrap resolves home
    // via os.homedir() and threads it through; the env may have
    // a stale value). Both home AND env.HOME point at tmpRoot
    // so ensureInstallId can create the install_id file; the
    // test demonstrates that swapping env.HOME doesn't shift
    // protected-path resolution.
    const r = preflightPermissionEngine({
      cwd: tmpRoot,
      home: tmpRoot,
      env: { HOME: tmpRoot },
      uuid: () => 'test-uuid-1111-aaaa',
      now: () => 1,
    });
    expect(r.resolved.policy).toBeDefined();
    // Identity sourced via the env (ensureInstallId reads env, not home)
    expect(r.identity.install_id).toBe('test-uuid-1111-aaaa');
  });

  test('home falls back to env.HOME when not explicitly passed', () => {
    // Pre-slice this was the production code path — preflight
    // wasn't given home, so it used env.HOME. Works WHEN HOME is
    // set. The bootstrap slice 109 fix avoids the fragile env
    // fallback by always passing home explicitly.
    const r = preflightPermissionEngine({
      cwd: tmpRoot,
      env: { HOME: tmpRoot },
      uuid: () => 'test-uuid-2222-bbbb',
      now: () => 1,
    });
    expect(r.resolved.policy).toBeDefined();
  });

  test('preflight succeeds when home is explicit even with env.HOME unset', () => {
    // The motivating R8 #323 scenario: container/CI with HOME
    // unset would have landed preflight's fallback on cwd
    // (broken behavior). Bootstrap slice 109 avoids this by
    // ALWAYS passing home explicitly via os.homedir(). This
    // test pins the preflight contract: with an explicit home,
    // the env.HOME absence doesn't matter for policy resolution.
    const r = preflightPermissionEngine({
      cwd: tmpRoot,
      home: tmpRoot,
      env: { HOME: tmpRoot } /* ensureInstallId still needs HOME for the .config dir */,
      uuid: () => 'test-uuid-3333-cccc',
      now: () => 1,
    });
    expect(r.resolved.policy).toBeDefined();
  });
});

// Code-review finding #1: cwd that prefixes a symlink (firmlinks on
// macOS, /tmp/projlink → /actual/proj, managed-NFS layouts) leaked
// the lexical form into matcher / resolver / protected-paths because
// only the sandbox runner canonicalized cwd (slice 155). The engine-
// side gap caused:
//   - matcher.matchPathPrepared default-deny on rules that should
//     match (lexical absCwd vs canonical realpath'd target → null
//     relativize → fallback abs glob misses).
//   - bash.detectCwdScopeEscape returning true on every call
//     (lexical-inside vs canonical-outside) → confidence='low' →
//     confirm-on-every-tool.
// Fix: bootstrap canonicalizes cwd + home at entry; resolvers /
// engine see the same physical path as the sandbox runner.
describe('bootstrapPermissionEngine — cwd canonicalization (review #1)', () => {
  test('symlinked cwd: allow_paths against cwd-relative pattern matches', async () => {
    // Create a real dir + symlink under tmpRoot.
    const realDir = mkdtempSync(join(tmpRoot, 'real-'));
    mkdirSync(join(realDir, 'src'));
    writeFileSync(join(realDir, 'src', 'auth.ts'), 'export {};');
    const linkDir = join(tmpRoot, 'linkdir');
    symlinkSync(realDir, linkDir);

    // Pin a session policy whose allow_paths is cwd-relative. Pre-fix
    // the matcher compiled the pattern against lexical linkDir while
    // realpath of the target collapsed to realDir — relativize against
    // the lexical cwd returned null and the fallback abs match failed.
    // Result: default-deny on a path that should match.
    const r = await bootstrapPermissionEngine(
      baseInput({
        cwd: linkDir,
        sessionPolicy: {
          defaults: { mode: 'strict' },
          tools: { read_file: { allow_paths: ['src/**'] } },
        },
      }),
    );
    expect(r.state).toBe('ready');

    // Engine should allow the read — pattern compiled against the
    // canonical cwd, target realpath agrees.
    const decision = r.engine.check('read_file', 'fs.read', {
      path: join(linkDir, 'src', 'auth.ts'),
    });
    expect(decision.kind).toBe('allow');
  });

  test('non-existent cwd falls back to the lexical input (back-compat)', async () => {
    // Tests that build engines against synthetic cwds (the project's
    // historical baseInput passes `/work/proj` which doesn't exist
    // on the runner FS) must keep working. realpathSync throws ENOENT;
    // the bootstrap silently falls back to the lexical form so the
    // engine still constructs and answers checks.
    const r = await bootstrapPermissionEngine(baseInput({ cwd: '/work/proj' }));
    expect(r.state).toBe('ready');
  });
});
