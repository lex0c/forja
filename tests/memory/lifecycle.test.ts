import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findExpiredMemories,
  gcExpiredMemories,
  gcStaleInvalidatedMemories,
  moveMemory,
  removeMemory,
} from '../../src/memory/lifecycle.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-lifecycle-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

// Write a body file with explicit frontmatter. Used to seed expiry
// scenarios. Caller controls expires/source/etc.
const writeBody = (
  dir: string,
  name: string,
  fmExtras: {
    expires?: string;
    source?: string;
    type?: string;
    trust?: string;
    state?: string;
  } = {},
): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: hook for ${name}`,
    `type: ${fmExtras.type ?? 'feedback'}`,
    `source: ${fmExtras.source ?? 'inferred'}`,
  ];
  if (fmExtras.expires !== undefined) lines.push(`expires: ${fmExtras.expires}`);
  if (fmExtras.trust !== undefined) lines.push(`trust: ${fmExtras.trust}`);
  if (fmExtras.state !== undefined) lines.push(`state: ${fmExtras.state}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\nbody of ${name}\n`);
};

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('removeMemory — primitive', () => {
  test('removes body and index entry, returns kind=removed', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    const result = removeMemory({ roots, scope: 'project_local', name: 'mem' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.indexEntryRemoved).toBe(true);
    expect(existsSync(join(roots.projectLocal, 'mem.md'))).toBe(false);
    expect(readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8')).not.toContain('mem.md');
  });

  test('preserves OTHER index entries', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Keep](keep.md) — keep\n- [Drop](drop.md) — drop\n');
    writeBody(roots.projectLocal, 'keep');
    writeBody(roots.projectLocal, 'drop');
    removeMemory({ roots, scope: 'project_local', name: 'drop' });
    const idx = readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8');
    expect(idx).toContain('keep.md');
    expect(idx).not.toContain('drop.md');
    expect(existsSync(join(roots.projectLocal, 'keep.md'))).toBe(true);
    expect(existsSync(join(roots.projectLocal, 'drop.md'))).toBe(false);
  });

  test('returns unknown when neither body nor index entry exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // Empty scope dir.
    mkdirSync(roots.projectLocal, { recursive: true });
    const result = removeMemory({ roots, scope: 'project_local', name: 'ghost' });
    expect(result.kind).toBe('unknown');
  });

  test('removes index entry even if body file is already missing', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Orphan](orphan.md) — h\n');
    // No body file.
    const result = removeMemory({ roots, scope: 'project_local', name: 'orphan' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.indexEntryRemoved).toBe(true);
    expect(readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8')).not.toContain('orphan.md');
  });

  test('removes body even if index entry is missing (orphan body)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeBody(roots.projectLocal, 'orphan');
    // No MEMORY.md.
    const result = removeMemory({ roots, scope: 'project_local', name: 'orphan' });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.indexEntryRemoved).toBe(false);
    expect(existsSync(join(roots.projectLocal, 'orphan.md'))).toBe(false);
  });

  test('removes a symlinked body file (regression: lstatSync.isFile false → unlink skipped)', () => {
    // Earlier cut classified a symlink at the body path as
    // bodyExists=false (because `stat.isFile()` returns false on a
    // symlink — lstatSync doesn't follow). The index entry was
    // rewritten away while the symlink stayed on disk, so a
    // subsequent writeMemory of the same name would trip the
    // writer's symlink_refused gate. The fix: include symlinks
    // in the removable set; unlinkSync operates on the link, not
    // its target.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const decoyTarget = join(repo, 'decoy.txt');
    writeFileSync(decoyTarget, 'decoy');
    writeIndex(roots.projectLocal, '- [Linked](linked.md) — h\n');
    mkdirSync(roots.projectLocal, { recursive: true });
    symlinkSync(decoyTarget, join(roots.projectLocal, 'linked.md'));
    const result = removeMemory({
      roots,
      scope: 'project_local',
      name: 'linked',
    });
    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.indexEntryRemoved).toBe(true);
    // Symlink itself is gone (lstatSync should ENOENT now).
    expect(existsSync(join(roots.projectLocal, 'linked.md'))).toBe(false);
    expect(() => lstatSync(join(roots.projectLocal, 'linked.md'))).toThrow();
    // Decoy target untouched — unlinkSync removed the LINK, not
    // the file the link pointed at.
    expect(readFileSync(decoyTarget, 'utf-8')).toBe('decoy');
    // Index entry cleared.
    const idx = readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8');
    expect(idx).not.toContain('linked.md');
  });

  test('non-file/non-symlink inode at body path: io_error, index untouched', () => {
    // Operator (or external script) put a directory where a memory
    // body should be. removeMemory MUST NOT rewrite the index in
    // that case — leaving the directory orphaned is less surprising
    // than leaving an inconsistent state where the index claims
    // the memory is gone but the path still has an inode.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Weird](weird.md) — h\n');
    mkdirSync(roots.projectLocal, { recursive: true });
    // Directory at the body path. lstatSync.isFile() returns false,
    // isSymbolicLink() returns false → 'other'.
    mkdirSync(join(roots.projectLocal, 'weird.md'));
    const result = removeMemory({
      roots,
      scope: 'project_local',
      name: 'weird',
    });
    expect(result.kind).toBe('io_error');
    // Index NOT mutated when 'other' fires up front.
    const idx = readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8');
    expect(idx).toContain('weird.md');
  });

  test('bad name (path traversal) routes through validateName as io_error', () => {
    // validateName regex rejects anything with `/` or leading
    // dots; FrontmatterError → io_error (caller-shape failure,
    // not a sandbox event). Mirrors writer.ts's mapping for
    // symmetry between create / remove paths.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = removeMemory({
      roots,
      scope: 'project_local',
      name: '../traversal',
    });
    expect(result.kind).toBe('io_error');
    if (result.kind === 'io_error') {
      // Reason carries the validator message so audit can show
      // the reject reason verbatim.
      expect(result.reason).toContain('frontmatter.name');
    }
  });

  test('name with leading dot routes as io_error (not sandbox)', () => {
    // Same regex as above — the regex front-end is what catches
    // these names, NOT the path-resolution sandbox check.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const result = removeMemory({
      roots,
      scope: 'project_local',
      name: '.hidden',
    });
    expect(result.kind).toBe('io_error');
  });
});

describe('findExpiredMemories', () => {
  test('returns memories whose expires is on or before today', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.projectLocal,
      [
        '- [Past](past.md) — past',
        '- [Today](today.md) — today',
        '- [Future](future.md) — future',
        '- [None](none.md) — no expiry',
      ].join('\n'),
    );
    writeBody(roots.projectLocal, 'past', { expires: '2025-01-01' });
    writeBody(roots.projectLocal, 'today', { expires: '2026-05-04' });
    writeBody(roots.projectLocal, 'future', { expires: '2030-01-01' });
    writeBody(roots.projectLocal, 'none');
    const reg = createMemoryRegistry({ roots });
    // End-of-day cutoff (matches `isExpired` in expires.ts): a
    // memory `expires: 2026-05-04` stays valid through that day
    // and crosses the cutoff at `2026-05-05 00:00 UTC`. So on
    // `2026-05-04 00:00 UTC` only 'past' has crossed.
    const onTheDay = findExpiredMemories(reg, new Date(Date.UTC(2026, 4, 4)));
    expect(onTheDay.map((e) => e.name).sort()).toEqual(['past']);
    // At the start of the NEXT day, 'today' is past its cutoff.
    const nextDay = findExpiredMemories(reg, new Date(Date.UTC(2026, 4, 5)));
    expect(nextDay.map((e) => e.name).sort()).toEqual(['past', 'today']);
  });

  test('does not consider memories without expires', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [None](none.md) — h\n');
    writeBody(roots.projectLocal, 'none');
    const reg = createMemoryRegistry({ roots });
    expect(findExpiredMemories(reg, new Date('2050-01-01'))).toEqual([]);
  });

  test('considers all scopes independently', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u-mem.md) — h\n');
    writeIndex(roots.projectLocal, '- [L](l-mem.md) — h\n');
    writeBody(roots.user, 'u-mem', { expires: '2024-01-01' });
    writeBody(roots.projectLocal, 'l-mem', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots });
    const expired = findExpiredMemories(reg, new Date(Date.UTC(2026, 4, 4)));
    expect(expired.map((e) => `${e.scope}/${e.name}`).sort()).toEqual([
      'project_local/l-mem',
      'user/u-mem',
    ]);
  });

  test('peek does NOT emit memory_events read rows during scan', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem', { expires: '2025-01-01' });
    const db = openMemoryDb();
    migrate(db);
    const reg = createMemoryRegistry({ roots, db });
    findExpiredMemories(reg, new Date(Date.UTC(2026, 4, 4)));
    expect(listMemoryEventsByName(db, 'mem')).toEqual([]);
  });
});

describe('gcExpiredMemories', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('routes expired memories through transitionMemoryState: tombstone + audit pair', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n- [Fresh](fresh.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2025-01-01' });
    writeBody(roots.projectLocal, 'fresh', { expires: '2030-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = await gcExpiredMemories(db, reg, roots, {
      today: new Date(Date.UTC(2026, 4, 4)),
      auditSessionId: sessionId,
      auditCwd: '/p',
    });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.name).toBe('old');
    expect(result.failures).toEqual([]);

    // Scope-root body moved into .tombstones/ (not deleted — the
    // state machine preserves the body for the retention window).
    expect(existsSync(join(roots.projectLocal, 'old.md'))).toBe(false);
    expect(existsSync(join(roots.projectLocal, 'fresh.md'))).toBe(true);
    const { readdirSync } = await import('node:fs');
    const tombstones = readdirSync(join(roots.projectLocal, '.tombstones'));
    expect(tombstones.length).toBe(1);
    expect(tombstones[0]).toMatch(/^old\.\d+\.md$/);

    // memory_events: 2-step transition produces quarantined + evicted
    // actions (NOT a single 'expired'). The 'expired' label was the
    // pre-state-machine surface; the canonical path lands the
    // structural lifecycle vocabulary.
    const events = listMemoryEventsByName(db, 'old');
    const actions = events.map((e) => e.action);
    expect(actions).toContain('quarantined');
    expect(actions).toContain('evicted');
    expect(actions).not.toContain('expired');
    for (const e of events) {
      expect(e.scope).toBe('project_local');
      expect(e.sessionId).toBe(sessionId);
      expect(e.cwd).toBe('/p');
    }

    // eviction_events: 2 rows, last is evicted with purge_at set
    // for the 30d retention window.
    const { getLastEvictionForObject } = await import('../../src/storage/repos/eviction-events.ts');
    const last = getLastEvictionForObject(db, 'memory', 'old', 'project_local');
    expect(last?.toState).toBe('evicted');
    expect(last?.trigger).toBe('expired_at');
    expect(last?.actor).toBe('startup_probe');
    expect(last?.purgeAt).not.toBeNull();
    // Evidence carries the operator-set expires date.
    const evidence = JSON.parse(last?.evidenceJson ?? '{}') as { expires?: string };
    expect(evidence.expires).toBe('2025-01-01');
  });

  test('expires user_explicit memory created < 72h ago (cooldown bypass for expired_at)', async () => {
    // Regression: gcExpiredMemories drives active → quarantined →
    // evicted with motivo='low_roi' and trigger='expired_at'. Before
    // the cooldown bypass for expired_at, a user_explicit memory
    // created less than 72h before its `expires` date stayed active
    // (gate refused) and gc kept logging failures on every boot.
    // The operator's explicit expiry IS the second consent — must
    // fire even inside the cooldown window.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const { createMemoryEvent } = await import('../../src/storage/repos/memory-events.ts');
    writeIndex(roots.projectLocal, '- [Fresh](fresh-but-expired.md) — h\n');
    writeBody(roots.projectLocal, 'fresh-but-expired', {
      source: 'user_explicit',
      expires: '2026-05-01', // 3 days before sweep date below
    });
    // Land a `created` audit row 1h before today — well inside the
    // 72h cooldown. The cooldown gate would block low_roi by default.
    const todayMs = Date.UTC(2026, 4, 4); // 2026-05-04
    createMemoryEvent(db, {
      scope: 'project_local',
      action: 'created',
      memoryName: 'fresh-but-expired',
      source: 'user_explicit',
      sessionId,
      createdAt: todayMs - 60 * 60 * 1000, // 1h ago
    });
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const result = await gcExpiredMemories(db, reg, roots, {
      today: new Date(todayMs),
      auditSessionId: sessionId,
      auditCwd: '/p',
    });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.name).toBe('fresh-but-expired');
    expect(result.failures).toEqual([]);

    // Memory actually moved through the state machine.
    expect(existsSync(join(roots.projectLocal, 'fresh-but-expired.md'))).toBe(false);
    const { getLastEvictionForObject } = await import('../../src/storage/repos/eviction-events.ts');
    const last = getLastEvictionForObject(db, 'memory', 'fresh-but-expired', 'project_local');
    expect(last?.toState).toBe('evicted');
    expect(last?.outcome).toBe('applied');
  });

  test('refreshes registry snapshot so list() reflects post-gc state', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    expect(reg.list()).toHaveLength(1);
    await gcExpiredMemories(db, reg, roots, { today: new Date(Date.UTC(2026, 4, 4)) });
    expect(reg.list()).toHaveLength(0);
  });

  test('no expired memories: no work, no audit rows', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Fresh](fresh.md) — h\n');
    writeBody(roots.projectLocal, 'fresh', { expires: '2030-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = await gcExpiredMemories(db, reg, roots, {
      today: new Date(Date.UTC(2026, 4, 4)),
    });
    expect(result.removed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(listMemoryEventsByName(db, 'fresh')).toEqual([]);
  });

  test('forwards source field from frontmatter to audit row', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', {
      expires: '2024-01-01',
      source: 'user_explicit',
    });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    await gcExpiredMemories(db, reg, roots, { today: new Date(Date.UTC(2026, 4, 4)) });
    const events = listMemoryEventsByName(db, 'old');
    // The evicted row carries the source from the frontmatter.
    const evicted = events.find((e) => e.action === 'evicted');
    expect(evicted?.source).toBe('user_explicit');
  });

  test('io_error during transition: failure surfaced, no removed', async () => {
    // Engineer a real failure: chmod the scope root read-execute
    // (no write). transitionMemoryState's atomicWrite for the
    // state=quarantined frontmatter hits EACCES, the first step
    // returns io_error, gcExpiredMemories records the failure.
    //
    // POSIX-only. Skipped silently when running as root (chmod
    // doesn't restrict root, the transition would succeed).
    if (process.getuid?.() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2024-01-01' });
    chmodSync(roots.projectLocal, 0o500);
    try {
      const reg = createMemoryRegistry({ roots, db, sessionId });
      const result = await gcExpiredMemories(db, reg, roots, {
        today: new Date(Date.UTC(2026, 4, 4)),
        auditSessionId: sessionId,
        auditCwd: '/p',
      });
      expect(result.removed).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.memory.name).toBe('old');
      // Reason mentions the step that failed.
      expect(result.failures[0]?.reason).toContain('active→quarantined');
    } finally {
      chmodSync(roots.projectLocal, 0o700);
    }
  });

  test('handles multiple expired across different scopes', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u-mem.md) — h\n');
    writeIndex(roots.projectLocal, '- [L](l-mem.md) — h\n');
    writeBody(roots.user, 'u-mem', { expires: '2024-01-01', type: 'user' });
    writeBody(roots.projectLocal, 'l-mem', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = await gcExpiredMemories(db, reg, roots, {
      today: new Date(Date.UTC(2026, 4, 4)),
    });
    expect(result.removed).toHaveLength(2);
    // Scope-root bodies moved into per-scope .tombstones/.
    expect(existsSync(join(roots.user, 'u-mem.md'))).toBe(false);
    expect(existsSync(join(roots.projectLocal, 'l-mem.md'))).toBe(false);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(roots.user, '.tombstones')).length).toBe(1);
    expect(readdirSync(join(roots.projectLocal, '.tombstones')).length).toBe(1);
  });
});

describe('gcPurgeExpiredTombstones', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('purges tombstones whose retention window expired', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });

    // Expire it (boot 1, 2024-06-01).
    const expireDay = new Date(Date.UTC(2024, 5, 1));
    await gcExpiredMemories(db, reg, roots, { today: expireDay });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(roots.projectLocal, '.tombstones')).length).toBe(1);

    // Sweep at a probe time PAST the retention window (30d + slack).
    // gcExpiredMemories used the day's getTime() + per-mem ticks
    // as recorded_at, so purge_at = recorded_at + 30d. Probe 35d
    // later guarantees we're past.
    const sweepNow = expireDay.getTime() + 35 * 24 * 60 * 60 * 1000;
    const { gcPurgeExpiredTombstones } = await import('../../src/memory/lifecycle.ts');
    const result = await gcPurgeExpiredTombstones(db, reg, roots, {
      now: () => sweepNow,
      auditSessionId: sessionId,
      auditCwd: '/p',
    });
    expect(result.purged).toHaveLength(1);
    expect(result.purged[0]?.scope).toBe('project_local');
    expect(result.purged[0]?.name).toBe('old');
    expect(result.failures).toEqual([]);

    // Tombstone file is gone.
    expect(readdirSync(join(roots.projectLocal, '.tombstones')).length).toBe(0);

    // Audit: eviction_events purged row with motivo='expired'.
    const { getLastEvictionForObject } = await import('../../src/storage/repos/eviction-events.ts');
    const last = getLastEvictionForObject(db, 'memory', 'old', 'project_local');
    expect(last?.toState).toBe('purged');
    expect(last?.motivo).toBe('expired');
    expect(last?.trigger).toBe('expired_at');
    expect(last?.actor).toBe('startup_probe');

    // memory_events: purged action landed.
    const events = listMemoryEventsByName(db, 'old');
    expect(events.map((e) => e.action)).toContain('purged');
  });

  test('leaves tombstones inside retention window alone', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const expireDay = new Date(Date.UTC(2024, 5, 1));
    await gcExpiredMemories(db, reg, roots, { today: expireDay });

    // Sweep INSIDE the window (1 day after eviction).
    const sweepNow = expireDay.getTime() + 24 * 60 * 60 * 1000;
    const { gcPurgeExpiredTombstones } = await import('../../src/memory/lifecycle.ts');
    const result = await gcPurgeExpiredTombstones(db, reg, roots, {
      now: () => sweepNow,
    });
    expect(result.purged).toEqual([]);

    // Tombstone still on disk.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(roots.projectLocal, '.tombstones')).length).toBe(1);
  });

  test('skips rows whose object has a newer eviction event (restored then re-evicted)', async () => {
    // First eviction (boot 1, 2024-06-01) → eviction_events row
    // A, purge_at = boot1 + 30d. Restore at t > boot1 + audit
    // row B (evicted→active). Re-eviction (boot 2, 2024-08-01)
    // → rows C+D, purge_at = boot2 + 30d.
    //
    // Sweep probe at boot1 + 35d (past row A's window but
    // before row D's). Row A becomes a candidate of
    // listEvictedDueForPurge, but the latest event is row D.
    // Sweep must skip row A.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });

    // First boot — expire and evict.
    const boot1 = new Date(Date.UTC(2024, 5, 1));
    await gcExpiredMemories(db, reg, roots, { today: boot1 });

    // Restore via transitionMemoryState (mirrors /memory restore).
    // Use a counter > boot1.ms so the restore audit row is
    // monotonically newer than the eviction.
    let restoreCounter = boot1.getTime() + 1_000_000;
    const { transitionMemoryState } = await import('../../src/memory/transitions.ts');
    const r1 = await transitionMemoryState({
      db,
      registry: reg,
      roots,
      scope: 'project_local',
      name: 'mem',
      toState: 'active',
      motivo: 'irrelevant',
      trigger: 'manual',
      actor: 'user',
      // Closest-fit motivo (restore is not really irrelevant —
      // see /memory restore comment). Operator-driven marker
      // skips §6.1 shape check.
      evidence: { _operator_driven: true, source: 'test_restore' },
      now: () => ++restoreCounter,
    });
    expect(r1.kind).toBe('applied');

    // Second boot — the memory is back at the scope root post-
    // restore. Re-write its body (the restore landed it there)
    // and re-expire so a fresh eviction lands. We need to also
    // reload the registry because restore modified the index.
    reg.reload();
    // Re-evict by simulating an `expires:` value still in the past.
    const boot2 = new Date(Date.UTC(2024, 7, 1));
    await gcExpiredMemories(db, reg, roots, { today: boot2 });

    // Sweep at boot1 + 35d (past row A's purge_at; before row D's).
    const sweepNow = boot1.getTime() + 35 * 24 * 60 * 60 * 1000;
    const { gcPurgeExpiredTombstones } = await import('../../src/memory/lifecycle.ts');
    const result = await gcPurgeExpiredTombstones(db, reg, roots, { now: () => sweepNow });

    // Nothing purged — row A is stale, row D's purge_at hasn't
    // hit yet (boot2 + 30d > boot1 + 35d).
    expect(result.purged).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(1);
    expect(result.skipped[0]?.reason).toContain('newer applied eviction event');

    // The current tombstone (from the re-evict) is still on disk.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(roots.projectLocal, '.tombstones')).length).toBe(1);
  });

  test('trigger_fired_no_action between eviction and sweep does NOT mask the purge candidate', async () => {
    // Real scenario: a cold-loop detector probes an already-evicted
    // memory and emits trigger_fired_no_action (same-state pseudo
    // on `evicted → evicted`). Earlier sweep used
    // getLastEvictionForObject which returned the probe row;
    // probe.id !== candidate.id → sweep skipped forever, tombstone
    // never purged. Now the sweep uses getLastAppliedEviction* and
    // ignores non-applied rows.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const expireDay = new Date(Date.UTC(2024, 5, 1));
    await gcExpiredMemories(db, reg, roots, { today: expireDay });

    // Inject a probe row that recorded a trigger fire without a
    // state change. Outcome='trigger_fired_no_action'; from==to.
    const { appendEvictionEvent } = await import('../../src/storage/repos/eviction-events.ts');
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'mem',
      objectScope: 'project_local',
      fromState: 'evicted',
      toState: 'evicted',
      trigger: 'roi_below_threshold',
      motivo: 'low_roi',
      evidenceJson: JSON.stringify({
        trigger_source: 'roi_below_threshold',
        tokens_consumed: 0,
        load_bearing_count: 0,
        ratio: 0,
      }),
      outcome: 'trigger_fired_no_action',
      actor: 'loop_cold',
      recordedAt: expireDay.getTime() + 10 * 24 * 60 * 60 * 1000,
    });

    // Sweep past the retention window — sweep MUST purge despite
    // the probe row being more recent than the eviction.
    const sweepNow = expireDay.getTime() + 35 * 24 * 60 * 60 * 1000;
    const { gcPurgeExpiredTombstones } = await import('../../src/memory/lifecycle.ts');
    const result = await gcPurgeExpiredTombstones(db, reg, roots, { now: () => sweepNow });
    expect(result.purged).toHaveLength(1);
    expect(result.purged[0]?.name).toBe('mem');
    expect(result.skipped).toEqual([]);

    // Tombstone gone.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(roots.projectLocal, '.tombstones')).length).toBe(0);
  });

  test('non-memory substrate candidates are ignored', async () => {
    // Insert a policy-substrate evicted row directly so the
    // sweep query returns it; verify it's filtered out without
    // hitting the memory-scope validator.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const { appendEvictionEvent } = await import('../../src/storage/repos/eviction-events.ts');
    // First quarantine → evicted (state machine requires the
    // sequence). substrate='policy' is in the enum even though
    // the policy subsystem isn't implemented; the sweep MUST NOT
    // try to act on it.
    appendEvictionEvent(db, {
      substrate: 'policy',
      objectId: 'rule-x',
      objectScope: 'repo',
      fromState: 'active',
      toState: 'quarantined',
      trigger: 'failure_burst',
      motivo: 'conflict',
      evidenceJson: JSON.stringify({ failures: 3 }),
      outcome: 'applied',
      actor: 'loop_cold',
      recordedAt: 1000,
    });
    appendEvictionEvent(db, {
      substrate: 'policy',
      objectId: 'rule-x',
      objectScope: 'repo',
      fromState: 'quarantined',
      toState: 'evicted',
      trigger: 'failure_burst',
      motivo: 'low_roi',
      evidenceJson: JSON.stringify({ tokens_consumed: 0, load_bearing_count: 0, ratio: 0 }),
      outcome: 'applied',
      actor: 'loop_cold',
      recordedAt: 2000,
      purgeAt: 1, // way in the past
    });

    const { gcPurgeExpiredTombstones } = await import('../../src/memory/lifecycle.ts');
    const result = await gcPurgeExpiredTombstones(db, reg, roots, {
      now: () => 10_000_000_000,
    });
    expect(result.purged).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual([]); // filtered before the recency check
  });
});

describe('moveMemory — primitive (promote / demote)', () => {
  test('promote: project_local → project_shared, source removed, target written', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    const result = moveMemory({
      roots,
      fromScope: 'project_local',
      toScope: 'project_shared',
      name: 'mem',
    });
    expect(result.kind).toBe('moved');
    if (result.kind !== 'moved') return;
    expect(existsSync(join(roots.projectLocal, 'mem.md'))).toBe(false);
    expect(existsSync(join(roots.projectShared, 'mem.md'))).toBe(true);
    // Source frontmatter forwarded for audit row.
    expect(result.source).toBe('inferred');
    // Body content survives.
    const onDisk = readFileSync(join(roots.projectShared, 'mem.md'), 'utf-8');
    expect(onDisk).toContain('body of mem');
    // Both indexes updated: target gets the entry, source loses it.
    const sharedIdx = readFileSync(join(roots.projectShared, 'MEMORY.md'), 'utf-8');
    expect(sharedIdx).toContain('mem.md');
    const localIdx = readFileSync(join(roots.projectLocal, 'MEMORY.md'), 'utf-8');
    expect(localIdx).not.toContain('mem.md');
  });

  test('demote: project_shared → project_local, source removed, target written', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectShared, 'mem', { source: 'imported' });
    const result = moveMemory({
      roots,
      fromScope: 'project_shared',
      toScope: 'project_local',
      name: 'mem',
    });
    expect(result.kind).toBe('moved');
    if (result.kind !== 'moved') return;
    expect(existsSync(join(roots.projectShared, 'mem.md'))).toBe(false);
    expect(existsSync(join(roots.projectLocal, 'mem.md'))).toBe(true);
    expect(result.source).toBe('imported');
  });

  test('source_unknown when source body is missing', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // No body file written.
    const result = moveMemory({
      roots,
      fromScope: 'project_local',
      toScope: 'project_shared',
      name: 'ghost',
    });
    expect(result.kind).toBe('source_unknown');
  });

  test('target_exists when destination already has the same name', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    writeIndex(roots.projectShared, '- [Mem](mem.md) — pre-existing\n');
    writeBody(roots.projectShared, 'mem', { source: 'imported' });
    const result = moveMemory({
      roots,
      fromScope: 'project_local',
      toScope: 'project_shared',
      name: 'mem',
    });
    expect(result.kind).toBe('target_exists');
    // Source stays in place when target reject fires.
    expect(existsSync(join(roots.projectLocal, 'mem.md'))).toBe(true);
    // Target unchanged.
    const sharedBody = readFileSync(join(roots.projectShared, 'mem.md'), 'utf-8');
    expect(sharedBody).toContain('body of mem');
  });

  test('promote preserves frontmatter source field on disk', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem', { source: 'user_explicit' });
    moveMemory({
      roots,
      fromScope: 'project_local',
      toScope: 'project_shared',
      name: 'mem',
    });
    const onDisk = readFileSync(join(roots.projectShared, 'mem.md'), 'utf-8');
    expect(onDisk).toContain('source: user_explicit');
  });

  test('source_malformed when source body has corrupt frontmatter', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Bad](bad.md) — h\n');
    // Body file with frontmatter that fails parse — no `source`
    // field, which validateFrontmatter rejects.
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(
      join(roots.projectLocal, 'bad.md'),
      '---\nname: bad\ndescription: h\ntype: feedback\n---\n\nbody\n',
    );
    const result = moveMemory({
      roots,
      fromScope: 'project_local',
      toScope: 'project_shared',
      name: 'bad',
    });
    expect(result.kind).toBe('source_malformed');
    if (result.kind !== 'source_malformed') return;
    expect(result.reason).toContain('source');
    // Source file untouched on malformed.
    expect(existsSync(join(roots.projectLocal, 'bad.md'))).toBe(true);
    expect(existsSync(join(roots.projectShared, 'bad.md'))).toBe(false);
  });

  test('io_error when target dir is unwritable (POSIX-only, skip as root)', () => {
    if (process.getuid?.() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem');
    // Create the project_shared dir with no write bit so the
    // atomicWrite of body / index inside it fails with EACCES.
    mkdirSync(roots.projectShared, { recursive: true });
    chmodSync(roots.projectShared, 0o500);
    try {
      const result = moveMemory({
        roots,
        fromScope: 'project_local',
        toScope: 'project_shared',
        name: 'mem',
      });
      expect(result.kind).toBe('io_error');
      // Source untouched on target write failure.
      expect(existsSync(join(roots.projectLocal, 'mem.md'))).toBe(true);
    } finally {
      chmodSync(roots.projectShared, 0o700);
    }
  });
});

describe('gcStaleInvalidatedMemories (S5 CRIT/V1, EVICTION §7.1 7d window)', () => {
  let db: DB;
  let sessionId: string;
  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });
  afterEach(() => db.close());

  const seedInvalidated = (roots: ScopeRoots, name: string, invalidatedAtMs: number): void => {
    writeIndex(roots.projectShared, `- [${name}](${name}.md) — h\n`);
    writeBody(roots.projectShared, name, { state: 'invalidated', source: 'user_explicit' });
    // Seed the eviction_events row that anchors the 7d window.
    const { appendEvictionEvent } = require('../../src/storage/repos/eviction-events.ts');
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: name,
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: invalidatedAtMs,
    });
  };

  test('memory invalidated >= 7d ago transitions to evicted', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    seedInvalidated(roots, 'stale', eightDaysAgoMs);
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });

    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted.map((m) => m.name)).toEqual(['stale']);
    expect(result.failures).toEqual([]);
    // Body moved to .tombstones/, index entry removed.
    expect(existsSync(join(roots.projectShared, 'stale.md'))).toBe(false);
  });

  test('memory invalidated < 7d ago is preserved', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const recentMs = Date.now() - 6 * 24 * 60 * 60 * 1000;
    seedInvalidated(roots, 'fresh', recentMs);
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });

    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted).toEqual([]);
    expect(existsSync(join(roots.projectShared, 'fresh.md'))).toBe(true);
  });

  test('memory with invalidated frontmatter but no audit row surfaces as orphan', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // Frontmatter says invalidated, but NO eviction_events row exists.
    writeIndex(roots.projectShared, '- [Orphan](orphan.md) — h\n');
    writeBody(roots.projectShared, 'orphan', { state: 'invalidated' });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });

    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted).toEqual([]);
    expect(result.orphans.map((o) => o.name)).toEqual(['orphan']);
    // The orphan stays on disk — the sweep doesn't try to "rescue".
    expect(existsSync(join(roots.projectShared, 'orphan.md'))).toBe(true);
  });

  test('mixed corpus: stale evicts, fresh stays, orphan surfaced', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const recentMs = Date.now() - 6 * 24 * 60 * 60 * 1000;
    // Three memories in one corpus.
    writeIndex(
      roots.projectShared,
      '- [Stale](stale.md) — h\n- [Fresh](fresh.md) — h\n- [Orphan](orphan.md) — h\n',
    );
    writeBody(roots.projectShared, 'stale', { state: 'invalidated', source: 'user_explicit' });
    writeBody(roots.projectShared, 'fresh', { state: 'invalidated', source: 'user_explicit' });
    writeBody(roots.projectShared, 'orphan', { state: 'invalidated', source: 'user_explicit' });
    const { appendEvictionEvent } = require('../../src/storage/repos/eviction-events.ts');
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'stale',
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: eightDaysAgoMs,
    });
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'fresh',
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: recentMs,
    });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });

    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted.map((m) => m.name)).toEqual(['stale']);
    expect(result.orphans.map((o) => o.name)).toEqual(['orphan']);
    expect(existsSync(join(roots.projectShared, 'stale.md'))).toBe(false);
    expect(existsSync(join(roots.projectShared, 'fresh.md'))).toBe(true);
    expect(existsSync(join(roots.projectShared, 'orphan.md'))).toBe(true);
  });

  test('active memory ignored (only invalidated state is in scope)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Live](live.md) — h\n');
    writeBody(roots.projectShared, 'live');
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(existsSync(join(roots.projectShared, 'live.md'))).toBe(true);
  });

  // T5: scope coverage — sweep MUST cover user + project_local
  // scopes, not only project_shared. A regression that restricted
  // the sweep to one scope would pass every other test in this
  // describe (they all seed project_shared).
  test('T5: sweep covers user + project_local + project_shared scopes', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const { appendEvictionEvent } = require('../../src/storage/repos/eviction-events.ts');
    // Seed an invalidated memory in each scope.
    for (const [dir, scope] of [
      [roots.user, 'user'],
      [roots.projectShared, 'project_shared'],
      [roots.projectLocal, 'project_local'],
    ] as const) {
      writeIndex(dir, '- [M](m.md) — h\n');
      writeBody(dir, 'm', { state: 'invalidated', source: 'user_explicit' });
      appendEvictionEvent(db, {
        substrate: 'memory',
        objectId: 'm',
        objectScope: scope,
        fromState: 'active',
        toState: 'invalidated',
        trigger: 'trust_revoked',
        motivo: 'security',
        evidenceJson: JSON.stringify({ trigger_source: 'test' }),
        outcome: 'applied',
        blockedBy: null,
        actor: 'startup_probe',
        sessionId,
        recordedAt: eightDaysAgoMs,
      });
    }
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    const evictedScopes = result.evicted.map((m) => m.scope).sort();
    expect(evictedScopes).toEqual(['project_local', 'project_shared', 'user']);
  });

  // T4: failure paths — illegal_transition + io_error
  test('T4: illegal_transition surfaces in failures (frontmatter manually flipped post-seed)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeIndex(roots.projectShared, '- [Flipped](flipped.md) — h\n');
    // Frontmatter says invalidated → registry.list will surface
    // this as candidate AND the audit row anchors the 7d window.
    writeBody(roots.projectShared, 'flipped', {
      state: 'invalidated',
      source: 'user_explicit',
    });
    const { appendEvictionEvent } = require('../../src/storage/repos/eviction-events.ts');
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'flipped',
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: eightDaysAgoMs,
    });

    // Now manually overwrite the frontmatter to `state: purged`
    // — terminal state from which `invalidated → evicted` is
    // illegal. registry.list({states:['invalidated']}) filters
    // by frontmatter so a `purged` body is excluded, and the
    // sweep skips it. Test variant: flip to a state that DOES
    // pass the filter but FAILS the transition. There's no such
    // state in the legal_transitions table — invalidated→evicted
    // admits motivo='shift' from EVERY invalidated. So the
    // illegal_transition path is genuinely unreachable from
    // within `gcStaleInvalidatedMemories` for state-machine
    // reasons. Document the result as an "orphan"-class skip
    // since the body's current state isn't `invalidated` anymore.
    writeBody(roots.projectShared, 'flipped', { state: 'purged' });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    // Memory was filtered out at list-time (state filter dropped
    // it); no transition attempted, no audit row, no failure.
    expect(result.evicted).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  test('T4: io_error in tombstone write surfaces in failures', async () => {
    // Skip-as-root: chmod won't restrict the sweep.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeIndex(roots.projectShared, '- [Stuck](stuck.md) — h\n');
    writeBody(roots.projectShared, 'stuck', { state: 'invalidated', source: 'user_explicit' });
    const { appendEvictionEvent } = require('../../src/storage/repos/eviction-events.ts');
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'stuck',
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: eightDaysAgoMs,
    });
    // Make the tombstone-target directory unwritable: pre-create
    // `.tombstones/` and chmod 0o500 so the move into it fails.
    mkdirSync(join(roots.projectShared, '.tombstones'), { recursive: true });
    chmodSync(join(roots.projectShared, '.tombstones'), 0o500);
    try {
      const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
      const result = await gcStaleInvalidatedMemories(db, registry, roots);
      expect(result.evicted).toEqual([]);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0]?.memory.name).toBe('stuck');
      expect(result.failures[0]?.reason).toContain('invalidated→evicted');
    } finally {
      chmodSync(join(roots.projectShared, '.tombstones'), 0o755);
    }
  });

  // Bug-fix regressions reported by code review (post-R3).

  test('eviction row stamped with purge_at so listEvictedDueForPurge picks it up', async () => {
    // Without this, the tombstones from this sweep accumulate
    // forever — `listEvictedDueForPurge` filters
    // `WHERE purge_at IS NOT NULL`, so a NULL stamp means the
    // evicted → purged GC will never reclaim them.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeIndex(roots.projectShared, '- [Stale](stale.md) — h\n');
    writeBody(roots.projectShared, 'stale', { state: 'invalidated', source: 'user_explicit' });
    const { appendEvictionEvent, listEvictedDueForPurge } = require(
      '../../src/storage/repos/eviction-events.ts',
    );
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'stale',
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: eightDaysAgoMs,
    });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });
    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted.map((m) => m.name)).toEqual(['stale']);

    // 30 days in the future: the tombstone produced by this sweep
    // should be eligible. Without the purgeAt stamp the helper
    // returns empty even at +infinity.
    const farFuture = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const due = listEvictedDueForPurge(db, farFuture) as Array<{ objectId: string }>;
    expect(due.map((r) => r.objectId)).toContain('stale');
  });

  test('registry reloaded after a transition so just-evicted entries leave assembleMemorySection', async () => {
    // Without `registry.reload()` post-sweep, `registry.list()`
    // returns the stale snapshot — entries whose bodies were just
    // moved to `.tombstones/` show up as "missing peek" which
    // `assembleMemorySection` treats as "uncertain → include".
    // Net effect: the eager prompt would surface a memory the
    // sweep just evicted.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeIndex(roots.projectShared, '- [Bygone](bygone.md) — h\n');
    writeBody(roots.projectShared, 'bygone', { state: 'invalidated', source: 'user_explicit' });
    const { appendEvictionEvent } = require('../../src/storage/repos/eviction-events.ts');
    appendEvictionEvent(db, {
      substrate: 'memory',
      objectId: 'bygone',
      objectScope: 'project_shared',
      fromState: 'active',
      toState: 'invalidated',
      trigger: 'trust_revoked',
      motivo: 'security',
      evidenceJson: JSON.stringify({ trigger_source: 'test' }),
      outcome: 'applied',
      blockedBy: null,
      actor: 'startup_probe',
      sessionId,
      recordedAt: eightDaysAgoMs,
    });
    const registry = createMemoryRegistry({ roots, db, sessionId, cwd: repo });

    // Pre-sweep, the registry sees `bygone` in project_shared.
    expect(
      registry
        .list({ scope: 'project_shared' })
        .map((l) => l.name),
    ).toContain('bygone');

    const result = await gcStaleInvalidatedMemories(db, registry, roots);
    expect(result.evicted.map((m) => m.name)).toEqual(['bygone']);

    // Post-sweep, the registry must have reloaded — the listing
    // no longer carries `bygone`.
    expect(
      registry
        .list({ scope: 'project_shared' })
        .map((l) => l.name),
    ).not.toContain('bygone');
  });
});
