// transitionMemoryState end-to-end tests (MEMORY.md §6.5 +
// EVICTION.md §3-§5).
//
// Real filesystem + SQLite — each test materializes a tmpdir
// with the user/shared/local layout, creates a memory db, and
// runs the transition helper. Tests assert ALL three outputs:
// (a) file/index state on disk, (b) eviction_events row in db,
// (c) memory_events row in db.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookChainResult, HookEventPayload } from '../../src/hooks/types.ts';
import { parseMemoryFile } from '../../src/memory/frontmatter.ts';
import { findLatestTombstone, transitionMemoryState } from '../../src/memory/index.ts';
import { type ScopeRoots, indexFilePath, memoryFilePath } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { getLastEvictionForObject } from '../../src/storage/repos/eviction-events.ts';
import {
  type MemoryEvent,
  createMemoryEvent,
  listMemoryEventsByName,
} from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let workdir: string;
let db: DB;
let sessionId: string;

const makeRoots = (): ScopeRoots => ({
  user: join(workdir, 'user'),
  projectShared: join(workdir, 'shared'),
  projectLocal: join(workdir, 'local'),
});

const writeIndex = (dir: string, name: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), `# Memory index\n\n- [${name}](${name}.md) - hook\n`);
};

const seedActiveMemory = (
  root: string,
  name: string,
  body = 'body content',
  state?: string,
): void => {
  mkdirSync(root, { recursive: true });
  const stateLine = state !== undefined ? `state: ${state}\n` : '';
  writeFileSync(
    join(root, `${name}.md`),
    `---\nname: ${name}\ndescription: hook for ${name}\ntype: feedback\nsource: user_explicit\n${stateLine}---\n\n${body}\n`,
  );
  writeIndex(root, name);
};

const baseRegistry = () =>
  createMemoryRegistry({
    roots: makeRoots(),
    db,
    sessionId,
    cwd: workdir,
  });

// Minimum evidence shape per motivo so transitionMemoryState calls
// pass §6.1 schema validation. Tests that exercise the evidence
// validator directly override `evidence` explicitly. Outcomes that
// don't represent a real transition (blocked_by_hook, same-state
// trigger_fired_no_action) skip validation in the repo, so this
// helper is only load-bearing for `applied` outcomes — but
// including it everywhere keeps the test calls uniform.
const validEvidence = (motivo: string): Record<string, unknown> => {
  switch (motivo) {
    case 'conflict':
      return { failures: 3 };
    case 'low_roi':
      return { tokens_consumed: 0, load_bearing_count: 0, ratio: 0 };
    case 'irrelevant':
      return { usage_count: 0, sample_size: 20 };
    case 'shift':
      return { shift_score: 0.5 };
    case 'expired':
      return { expires: '2024-01-01' };
    case 'quota':
      return { slot_budget: 100, item_cost: 200 };
    case 'user_purge':
      return {};
    case 'security':
      return { trigger_source: 'hook' };
    default:
      return {};
  }
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-mem-trans-'));
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'test/m', cwd: workdir }).id;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ── happy path: active → quarantined ────────────────────────────────

describe('transitionMemoryState: active → quarantined', () => {
  test('updates frontmatter state, keeps index entry, emits paired audit', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'commit-style');
    const registry = baseRegistry();

    const result = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      evidence: { ...validEvidence('conflict'), reason: 'fs mismatch' },
      sessionId,
      cwd: workdir,
    });

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.fromState).toBe('active');
    expect(result.toState).toBe('quarantined');

    // File still in scope root, with state=quarantined.
    const bodyPath = memoryFilePath(roots, 'user', 'commit-style');
    expect(existsSync(bodyPath)).toBe(true);
    const file = parseMemoryFile(readFileSync(bodyPath, 'utf-8'));
    expect(file.frontmatter.state).toBe('quarantined');

    // Index entry preserved.
    const idx = readFileSync(indexFilePath(roots, 'user'), 'utf-8');
    expect(idx).toContain('commit-style');

    // Audit pair lands.
    const evictionEv = getLastEvictionForObject(db, 'memory', 'commit-style', 'user');
    expect(evictionEv?.toState).toBe('quarantined');
    expect(evictionEv?.outcome).toBe('applied');
    expect(evictionEv?.motivo).toBe('conflict');

    const memEvents = listMemoryEventsByName(db, 'commit-style');
    const quarantinedEv = memEvents.find((e: MemoryEvent) => e.action === 'quarantined');
    expect(quarantinedEv).toBeDefined();
    expect(quarantinedEv?.details).toMatchObject({
      from_state: 'active',
      to_state: 'quarantined',
      motivo: 'conflict',
    });
  });
});

// ── happy path: active → evicted ─────────────────────────────────────

describe('transitionMemoryState: active → evicted (NOT legal — should refuse)', () => {
  // EVICTION §4.1 doesn't list active → evicted directly. Callers
  // intending /memory delete go through quarantined first (see
  // 1.3.c3). This test pins that the state machine refuses the
  // direct path so a future shortcut doesn't slip through.
  test('illegal_transition without quarantined intermediate', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'commit-style');
    const registry = baseRegistry();

    const result = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      sessionId,
      cwd: workdir,
    });

    expect(result.kind).toBe('illegal_transition');
    if (result.kind !== 'illegal_transition') return;
    expect(result.reason).toContain('illegal');
  });
});

describe('transitionMemoryState: quarantined → evicted', () => {
  test('moves body to .tombstones/, removes index, emits audit pair', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'commit-style', 'body-content', 'quarantined');
    const registry = baseRegistry();

    const result = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      now: () => 5_000,
      sessionId,
      cwd: workdir,
    });

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.tombstoneTs).toBe(5_000);
    expect(result.tombstonePath).toBe(join(roots.user, '.tombstones', 'commit-style.5000.md'));

    // Body moved.
    expect(existsSync(memoryFilePath(roots, 'user', 'commit-style'))).toBe(false);
    expect(existsSync(result.tombstonePath ?? '')).toBe(true);

    // Tombstone has state=evicted in frontmatter.
    if (result.tombstonePath === undefined) throw new Error('missing tombstonePath');
    const tombFile = parseMemoryFile(readFileSync(result.tombstonePath, 'utf-8'));
    expect(tombFile.frontmatter.state).toBe('evicted');

    // Index entry removed.
    const idx = readFileSync(indexFilePath(roots, 'user'), 'utf-8');
    expect(idx).not.toContain('commit-style.md');

    // Audit.
    const evictionEv = getLastEvictionForObject(db, 'memory', 'commit-style', 'user');
    expect(evictionEv?.toState).toBe('evicted');

    const evictedMemEv = listMemoryEventsByName(db, 'commit-style').find(
      (e) => e.action === 'evicted',
    );
    expect(evictedMemEv).toBeDefined();
  });
});

// ── restore: evicted → active ───────────────────────────────────────

describe('transitionMemoryState: evicted → active (restore from tombstone)', () => {
  test('reads tombstone, writes body back, removes tombstone, re-adds index', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'commit-style', 'restored body', 'quarantined');
    const registry = baseRegistry();

    // First evict.
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      now: () => 1_000,
      sessionId,
      cwd: workdir,
    });
    expect(findLatestTombstone(roots, 'user', 'commit-style')).not.toBeNull();

    // Then restore.
    const result = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'active',
      motivo: 'irrelevant',
      trigger: 'manual',
      actor: 'user',
      evidence: validEvidence('irrelevant'),
      sessionId,
      cwd: workdir,
    });

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.fromState).toBe('evicted');
    expect(result.toState).toBe('active');

    // Body restored, state field stripped (default active).
    const restored = parseMemoryFile(
      readFileSync(memoryFilePath(roots, 'user', 'commit-style'), 'utf-8'),
    );
    expect(restored.frontmatter.state).toBeUndefined();
    expect(restored.body).toContain('restored body');

    // Tombstone gone.
    expect(findLatestTombstone(roots, 'user', 'commit-style')).toBeNull();

    // Index entry back.
    const idx = readFileSync(indexFilePath(roots, 'user'), 'utf-8');
    expect(idx).toContain('commit-style');

    // memory_events records the restore.
    const restoredEv = listMemoryEventsByName(db, 'commit-style').find(
      (e) => e.action === 'restored',
    );
    expect(restoredEv).toBeDefined();
  });
});

// ── evicted → purged (GC sweep path) ────────────────────────────────

describe('transitionMemoryState: evicted → purged', () => {
  test('removes tombstone; preserves eviction_events row', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'commit-style', 'doomed', 'quarantined');
    const registry = baseRegistry();

    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      // Distinct timestamps for the two transitions so
      // getLastEvictionForObject's ORDER BY recorded_at DESC has
      // an unambiguous winner. Without this, both rows can land
      // at the same millisecond on a fast CI box and the id-DESC
      // tiebreaker (random UUID) yields non-deterministic order.
      now: () => 1_000,
      sessionId,
      cwd: workdir,
    });

    const purgeResult = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'commit-style',
      toState: 'purged',
      motivo: 'expired',
      trigger: 'expired_at',
      actor: 'startup_probe',
      evidence: validEvidence('expired'),
      now: () => 2_000,
      sessionId,
      cwd: workdir,
    });

    expect(purgeResult.kind).toBe('applied');
    expect(findLatestTombstone(roots, 'user', 'commit-style')).toBeNull();

    // eviction_events row for purge lands.
    const last = getLastEvictionForObject(db, 'memory', 'commit-style', 'user');
    expect(last?.toState).toBe('purged');

    // memory_events row for purge lands.
    const purgedEv = listMemoryEventsByName(db, 'commit-style').find((e) => e.action === 'purged');
    expect(purgedEv).toBeDefined();
  });
});

// ── illegal transitions surface kind: illegal_transition ────────────

describe('transitionMemoryState: illegal transitions', () => {
  test('refuses active → proposed (proposed is admission-only)', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x');
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'proposed',
      motivo: 'user_purge',
      trigger: 'user_purge',
      actor: 'user',
      sessionId,
      cwd: workdir,
    });
    expect(r.kind).toBe('illegal_transition');
  });

  test('refuses wrong motivo for the (from, to) pair', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x');
    const registry = baseRegistry();

    // active → quarantined is gated on conflict | low_roi; security
    // is not allowed.
    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'quarantined',
      motivo: 'security',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      sessionId,
      cwd: workdir,
    });
    expect(r.kind).toBe('illegal_transition');
  });
});

// ── unknown memory ──────────────────────────────────────────────────

describe('transitionMemoryState: unknown memory', () => {
  test('returns kind=unknown when neither body nor tombstone exist', async () => {
    const roots = makeRoots();
    mkdirSync(roots.user, { recursive: true });
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'never-existed',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      sessionId,
      cwd: workdir,
    });
    expect(r.kind).toBe('unknown');
  });
});

// ── same-state pseudo-transition ────────────────────────────────────

describe('transitionMemoryState: same-state pseudo-transition', () => {
  test('records trigger_fired_no_action with no file/audit pair', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x', 'body', 'quarantined');
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      sessionId,
      cwd: workdir,
    });
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.fromState).toBe('quarantined');
    expect(r.toState).toBe('quarantined');

    // The eviction_events row is recorded as trigger_fired_no_action.
    const last = getLastEvictionForObject(db, 'memory', 'x', 'user');
    expect(last?.outcome).toBe('trigger_fired_no_action');

    // No memory_events lifecycle row (same-state doesn't have a
    // canonical action — only the eviction-events trail).
    const memActions = listMemoryEventsByName(db, 'x').map((e) => e.action);
    expect(memActions).not.toContain('quarantined');
  });

  test('io_error surfaces when appendEvictionEvent throws (same-state path)', async () => {
    // Force the same-state append to throw by closing the db before
    // the call. transitionMemoryState should catch the throw and
    // surface kind=io_error so callers can render the right copy
    // without crashing the harness loop.
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x', 'body', 'quarantined');
    const registry = baseRegistry();

    db.close();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      sessionId,
      cwd: workdir,
    });
    expect(r.kind).toBe('io_error');
    if (r.kind !== 'io_error') return;
    expect(r.reason.length).toBeGreaterThan(0);

    // Re-open so afterEach's cleanup doesn't trip on a closed handle.
    db = openMemoryDb();
    migrate(db);
  });
});

// ── hook blocks the transition ──────────────────────────────────────

describe('transitionMemoryState: Eviction hook blocks', () => {
  test('blocked_by_hook: file/index unchanged, paired refused audit', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x');
    const registry = baseRegistry();

    const fireHook = async (payload: HookEventPayload): Promise<HookChainResult | null> => {
      expect(payload.event).toBe('Eviction');
      return {
        blockedBy: {
          spec: {
            layer: 'enterprise',
            sourcePath: '/etc/agent/hooks.toml',
            event: 'Eviction',
            matcher: {},
            entryIndex: 0,
            command: 'audit.sh',
            timeoutMs: 5000,
            failClosed: false,
            locked: false,
          },
          reason: 'message',
          message: 'security policy refused',
        },
        runs: [],
        additionalContext: '',
      };
    };

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      evidence: validEvidence('conflict'),
      sessionId,
      cwd: workdir,
      fireHook,
    });
    expect(r.kind).toBe('blocked_by_hook');
    if (r.kind !== 'blocked_by_hook') return;
    expect(r.blockedBy).toContain('/etc/agent/hooks.toml');
    expect(r.reason).toBe('security policy refused');

    // File unchanged.
    const file = parseMemoryFile(readFileSync(memoryFilePath(roots, 'user', 'x'), 'utf-8'));
    expect(file.frontmatter.state).toBeUndefined(); // still default-active

    // Audit: eviction_events with outcome=blocked_by_hook.
    const last = getLastEvictionForObject(db, 'memory', 'x', 'user');
    expect(last?.outcome).toBe('blocked_by_hook');
    expect(last?.blockedBy).toContain('/etc/agent/hooks.toml');

    // memory_events refused row landed.
    const refused = listMemoryEventsByName(db, 'x').find((e) => e.action === 'refused');
    expect(refused).toBeDefined();
    expect(refused?.details?.stage).toBe('eviction_hook');
  });
});

// ── hook blocks the restore path (evicted → active) ─────────────────

describe('transitionMemoryState: Eviction hook blocks restore', () => {
  test('blocked_by_hook on evicted → active: tombstone stays put, refused audit', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x');
    const registry = baseRegistry();

    // Step 1: evict it through the 2-step canonical path so the
    // tombstone exists.
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      evidence: validEvidence('conflict'),
      sessionId,
      cwd: workdir,
      now: () => 1_000,
    });
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'user_purge',
      actor: 'user',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 2_000,
    });
    const tomb = findLatestTombstone(roots, 'user', 'x');
    expect(tomb).not.toBeNull();

    // Step 2: try to restore with a hook that blocks the transition.
    const fireHook = async (payload: HookEventPayload): Promise<HookChainResult | null> => {
      expect(payload.event).toBe('Eviction');
      const data = payload.data as { fromState?: string; toState?: string };
      expect(data.fromState).toBe('evicted');
      expect(data.toState).toBe('active');
      return {
        blockedBy: {
          spec: {
            layer: 'enterprise',
            sourcePath: '/etc/agent/hooks.toml',
            event: 'Eviction',
            matcher: {},
            entryIndex: 0,
            command: 'audit.sh',
            timeoutMs: 5000,
            failClosed: false,
            locked: false,
          },
          reason: 'message',
          message: 'restore disallowed',
        },
        runs: [],
        additionalContext: '',
      };
    };

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'active',
      motivo: 'irrelevant',
      trigger: 'manual',
      actor: 'user',
      evidence: validEvidence('irrelevant'),
      sessionId,
      cwd: workdir,
      fireHook,
      now: () => 3_000,
    });
    expect(r.kind).toBe('blocked_by_hook');

    // Tombstone still present; no scope-root body materialized.
    expect(findLatestTombstone(roots, 'user', 'x')).not.toBeNull();
    expect(existsSync(memoryFilePath(roots, 'user', 'x'))).toBe(false);

    // memory_events refused row landed.
    const refused = listMemoryEventsByName(db, 'x').find((e) => e.action === 'refused');
    expect(refused).toBeDefined();
    expect((refused as MemoryEvent | undefined)?.details?.stage).toBe('eviction_hook');
  });
});

// ── quarantined → active is a restore-without-tombstone path ────────

describe('transitionMemoryState: quarantined → active', () => {
  test('strips state field, keeps index entry, emits restored audit', async () => {
    const roots = makeRoots();
    // Seed the memory already in 'quarantined' state.
    seedActiveMemory(roots.user, 'x', 'body', 'quarantined');
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'active',
      // `quarantined → active` admits any motivo per EVICTION §4.1.
      motivo: 'irrelevant',
      trigger: 'manual',
      actor: 'user',
      evidence: validEvidence('irrelevant'),
      sessionId,
      cwd: workdir,
    });
    expect(r.kind).toBe('applied');
    if (r.kind !== 'applied') return;
    expect(r.fromState).toBe('quarantined');
    expect(r.toState).toBe('active');

    // Frontmatter `state` stripped (absence === active).
    const file = parseMemoryFile(readFileSync(memoryFilePath(roots, 'user', 'x'), 'utf-8'));
    expect(file.frontmatter.state).toBeUndefined();

    // memory_events 'restored' action landed.
    const restored = listMemoryEventsByName(db, 'x').find((e) => e.action === 'restored');
    expect(restored).toBeDefined();
  });
});

// ── protection gates (EVICTION §6.2) ────────────────────────────────

describe('transitionMemoryState: protection gates', () => {
  test('user_explicit cooldown blocks low_roi within 72h of creation', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');

    // Patch the frontmatter to say source=user_explicit.
    const path = memoryFilePath(roots, 'user', 'fresh');
    const raw = readFileSync(path, 'utf-8').replace(
      'source: user_explicit',
      'source: user_explicit',
    ); // already user_explicit
    writeFileSync(path, raw);

    // Land a `created` audit row 1h ago — well within the 72h
    // cooldown window. Without this row, getEarliestMemoryCreatedAt
    // returns null and the gate doesn't fire.
    const oneHourMs = 60 * 60 * 1000;
    const createdAt = 1_000_000 - oneHourMs;
    const registry = baseRegistry();
    // Use createMemoryEvent directly — registry.recordEvent doesn't
    // forward createdAt, defaulting to Date.now() which would race
    // the test's `now: () => 1_000_000` and never trigger the gate.
    createMemoryEvent(db, {
      scope: 'user',
      action: 'created',
      memoryName: 'fresh',
      source: 'user_explicit',
      sessionId,
      createdAt,
    });

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000,
    });

    expect(r.kind).toBe('blocked_by_protection');
    if (r.kind !== 'blocked_by_protection') return;
    expect(r.protection).toBe('user_explicit_cooldown');
    expect(r.reason).toContain('72h cooldown');

    // File state didn't change.
    const file = parseMemoryFile(readFileSync(path, 'utf-8'));
    expect(file.frontmatter.state).toBeUndefined();

    // Audit: eviction_events row with outcome=blocked_by_protection.
    const last = getLastEvictionForObject(db, 'memory', 'fresh', 'user');
    expect(last?.outcome).toBe('blocked_by_protection');
    expect(last?.blockedBy).toBe('user_explicit_cooldown');

    // memory_events refused row with stage=eviction_protection.
    const refused = listMemoryEventsByName(db, 'fresh').find((e) => e.action === 'refused');
    expect(refused).toBeDefined();
    expect(refused?.details?.stage).toBe('eviction_protection');
    expect(refused?.details?.protection).toBe('user_explicit_cooldown');
  });

  test('user_explicit cooldown SKIPS when no `created` audit row exists (legacy fallback)', async () => {
    // Legacy registry pickup: memory file on disk with
    // source: user_explicit but no memory_events `created` row
    // (pre-audit-chain era). The cooldown gate must NOT block —
    // age can't be computed, so the operator override path is
    // the only way to delete; gating on absent evidence would
    // permanently block low_roi/irrelevant evictions for those
    // memories.
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'legacy');
    // Note: no createMemoryEvent(db, ...) call — no `created` row.
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'legacy',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000,
    });

    expect(r.kind).toBe('applied');
  });

  test('user_explicit cooldown does NOT block after 72h', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'aged');

    // Created 100h ago — past the cooldown window.
    const hundredHoursMs = 100 * 60 * 60 * 1000;
    const createdAt = 1_000_000 - hundredHoursMs;
    const registry = baseRegistry();
    createMemoryEvent(db, {
      scope: 'user',
      action: 'created',
      memoryName: 'aged',
      source: 'user_explicit',
      sessionId,
      createdAt,
    });

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'aged',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000,
    });

    expect(r.kind).toBe('applied');
  });

  test('actor=user bypasses cooldown (operator override)', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');

    const createdAt = 1_000_000 - 60 * 60 * 1000; // 1h ago
    const registry = baseRegistry();
    // Use createMemoryEvent directly — registry.recordEvent doesn't
    // forward createdAt, defaulting to Date.now() which would race
    // the test's `now: () => 1_000_000` and never trigger the gate.
    createMemoryEvent(db, {
      scope: 'user',
      action: 'created',
      memoryName: 'fresh',
      source: 'user_explicit',
      sessionId,
      createdAt,
    });

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'user_purge',
      actor: 'user',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000,
    });

    expect(r.kind).toBe('applied');
  });

  test('security motivo bypasses cooldown', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');

    const createdAt = 1_000_000 - 60 * 60 * 1000; // 1h ago
    const registry = baseRegistry();
    // Use createMemoryEvent directly — registry.recordEvent doesn't
    // forward createdAt, defaulting to Date.now() which would race
    // the test's `now: () => 1_000_000` and never trigger the gate.
    createMemoryEvent(db, {
      scope: 'user',
      action: 'created',
      memoryName: 'fresh',
      source: 'user_explicit',
      sessionId,
      createdAt,
    });

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'invalidated',
      motivo: 'security',
      trigger: 'security_purge',
      actor: 'hook',
      evidence: validEvidence('security'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000,
    });

    expect(r.kind).toBe('applied');
  });

  test('quarantine min TTL blocks evict from a different actor/trigger chain', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');
    const registry = baseRegistry();

    // First quarantine via loop_cold / verify_failed.
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      evidence: validEvidence('conflict'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000,
    });

    // Different actor (compaction) tries to evict 1h later —
    // different chain, TTL applies.
    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'token_pressure',
      actor: 'compaction',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000_000 + 60 * 60 * 1000, // 1h later
    });

    expect(r.kind).toBe('blocked_by_protection');
    if (r.kind !== 'blocked_by_protection') return;
    expect(r.protection).toBe('quarantine_min_ttl');
    expect(r.reason).toContain('7d min TTL');
  });

  test('quarantine min TTL bypassed for same-chain (boot GC pipeline)', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');
    const registry = baseRegistry();

    // Boot GC: quarantine + evict by same actor + trigger.
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'expired_at',
      actor: 'startup_probe',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000,
    });

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'expired_at',
      actor: 'startup_probe',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 2_000,
    });

    expect(r.kind).toBe('applied');
  });
});

// ── pre-flight evidence validation (§6.1) ───────────────────────────

describe('transitionMemoryState: invalid_evidence pre-flight', () => {
  test('refuses with kind=invalid_evidence BEFORE any disk mutation', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');
    const registry = baseRegistry();

    // motivo=low_roi requires {tokens_consumed, load_bearing_count,
    // ratio}; passing empty evidence triggers pre-flight refusal.
    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: {},
      sessionId,
      cwd: workdir,
    });

    expect(r.kind).toBe('invalid_evidence');
    if (r.kind !== 'invalid_evidence') return;
    expect(r.reason).toContain('low_roi');
    expect(r.fromState).toBe('active');
    expect(r.toState).toBe('quarantined');

    // CRITICAL: file/index unchanged. Earlier shape (validation
    // inside appendEvictionEvent at stage 5) would have moved the
    // body to .tombstones/ before catching the failure — producing
    // a real audit_drift. Pre-flight refuses before applyTransition.
    const file = parseMemoryFile(readFileSync(memoryFilePath(roots, 'user', 'fresh'), 'utf-8'));
    expect(file.frontmatter.state).toBeUndefined();

    // NO eviction_events row landed — the pre-flight short-
    // circuits before any DB write.
    expect(getLastEvictionForObject(db, 'memory', 'fresh', 'user')).toBeNull();
  });

  test('accepts well-formed evidence', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: { tokens_consumed: 100, load_bearing_count: 0, ratio: 0 },
      sessionId,
      cwd: workdir,
    });

    expect(r.kind).toBe('applied');
  });

  test('operator-driven marker bypasses pre-flight', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'fresh');
    const registry = baseRegistry();

    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'fresh',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'user_purge',
      actor: 'user',
      // Closest-fit motivo + operator marker — same shape /memory
      // delete uses for the operator path.
      evidence: { _operator_driven: true, source: 'slash_delete' },
      sessionId,
      cwd: workdir,
    });

    expect(r.kind).toBe('applied');
  });
});

// ── cascading detector (EVICTION §6.4) ──────────────────────────────

describe('transitionMemoryState: dependents_json on *→evicted', () => {
  test('records dependents in eviction_events when other memories reference the evicted one', async () => {
    const roots = makeRoots();
    // Two memories: 'target' (will be evicted) and 'dependent'
    // (body references [[target]]).
    seedActiveMemory(roots.user, 'target', 'body of target');
    mkdirSync(join(roots.user), { recursive: true });
    writeFileSync(
      join(roots.user, 'dependent.md'),
      '---\nname: dependent\ndescription: hook\ntype: feedback\nsource: inferred\n---\n\nuse [[target]] here\n',
    );
    // Re-write index so registry picks both up.
    writeFileSync(
      indexFilePath(roots, 'user'),
      '# Memory index\n\n- [Target](target.md) - hook\n- [Dep](dependent.md) - hook\n',
    );
    const registry = baseRegistry();

    // Evict target via the canonical 2-step path. Same
    // (actor, trigger) on both steps so the quarantine min TTL
    // gate's same-chain bypass kicks in.
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'target',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000,
    });
    const r = await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'target',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 2_000,
    });
    expect(r.kind).toBe('applied');

    // The latest eviction event for 'target' has dependents_json
    // listing the dependent memory.
    const last = getLastEvictionForObject(db, 'memory', 'target', 'user');
    expect(last?.toState).toBe('evicted');
    expect(last?.dependentsJson).not.toBeNull();
    const dependents = JSON.parse(last?.dependentsJson ?? '[]') as {
      scope: string;
      name: string;
      refKind: string;
    }[];
    expect(dependents).toHaveLength(1);
    expect(dependents[0]?.name).toBe('dependent');
    expect(dependents[0]?.refKind).toBe('wiki');
  });

  test('dependents_json is null when no dependents reference the evicted memory', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'standalone');
    const registry = baseRegistry();

    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'standalone',
      toState: 'quarantined',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 1_000,
    });
    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'standalone',
      toState: 'evicted',
      motivo: 'low_roi',
      trigger: 'roi_below_threshold',
      actor: 'loop_cold',
      evidence: validEvidence('low_roi'),
      sessionId,
      cwd: workdir,
      now: () => 2_000,
    });

    const last = getLastEvictionForObject(db, 'memory', 'standalone', 'user');
    expect(last?.dependentsJson).toBeNull();
  });
});

// ── evidence_json redaction round-trips (delegated to repo) ─────────

describe('transitionMemoryState: evidence_json is scrubbed by repo', () => {
  test('credential-shaped evidence string is redacted in the persisted row', async () => {
    const roots = makeRoots();
    seedActiveMemory(roots.user, 'x');
    const registry = baseRegistry();

    await transitionMemoryState({
      db,
      registry,
      roots,
      scope: 'user',
      name: 'x',
      toState: 'quarantined',
      motivo: 'conflict',
      trigger: 'verify_failed',
      actor: 'loop_cold',
      evidence: {
        ...validEvidence('conflict'),
        detail: 'log shipped sk-ant-aaaaaaaaaaaaaaaaaaaa via webhook',
      },
      sessionId,
      cwd: workdir,
    });

    const last = getLastEvictionForObject(db, 'memory', 'x', 'user');
    expect(last?.evidenceJson).not.toContain('sk-ant-aaaaaaaaaaaaaaaaaaaa');
  });
});
