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
  fmExtras: { expires?: string; source?: string; type?: string; trust?: string } = {},
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
    const expired = findExpiredMemories(reg, new Date(Date.UTC(2026, 4, 4)));
    const names = expired.map((e) => e.name).sort();
    expect(names).toEqual(['past', 'today']);
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

  test('removes each expired memory and emits expired audit row', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n- [Fresh](fresh.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2025-01-01' });
    writeBody(roots.projectLocal, 'fresh', { expires: '2030-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = gcExpiredMemories(reg, roots, {
      today: new Date(Date.UTC(2026, 4, 4)),
      auditSessionId: sessionId,
      auditCwd: '/p',
    });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.name).toBe('old');
    expect(result.failures).toEqual([]);

    expect(existsSync(join(roots.projectLocal, 'old.md'))).toBe(false);
    expect(existsSync(join(roots.projectLocal, 'fresh.md'))).toBe(true);

    const events = listMemoryEventsByName(db, 'old');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('expired');
    expect(events[0]?.scope).toBe('project_local');
    expect(events[0]?.sessionId).toBe(sessionId);
    expect(events[0]?.cwd).toBe('/p');
    expect(events[0]?.details?.expires).toBe('2025-01-01');
  });

  test('refreshes registry snapshot so list() reflects post-gc state', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    expect(reg.list()).toHaveLength(1);
    gcExpiredMemories(reg, roots, { today: new Date(Date.UTC(2026, 4, 4)) });
    expect(reg.list()).toHaveLength(0);
  });

  test('no expired memories: no work, no audit rows', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Fresh](fresh.md) — h\n');
    writeBody(roots.projectLocal, 'fresh', { expires: '2030-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = gcExpiredMemories(reg, roots, { today: new Date(Date.UTC(2026, 4, 4)) });
    expect(result.removed).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(listMemoryEventsByName(db, 'fresh')).toEqual([]);
  });

  test('forwards source field from frontmatter to audit row', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', {
      expires: '2024-01-01',
      source: 'user_explicit',
    });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    gcExpiredMemories(reg, roots, { today: new Date(Date.UTC(2026, 4, 4)) });
    const events = listMemoryEventsByName(db, 'old');
    expect(events[0]?.source).toBe('user_explicit');
  });

  test('audits `refused` row with stage=lifecycle_gc on remove failure', () => {
    // Engineer a real failure: write the expired body + index,
    // then chmod the scope root read-execute (no write). The
    // index rewrite hits EACCES, removeMemory returns io_error,
    // gcExpiredMemories should emit the audit row.
    //
    // POSIX-only. Bun tests run on Linux/macOS in practice; we
    // restore the mode in finally so afterEach can clean the
    // tmpdir. Skipped silently when running as root (chmod
    // doesn't restrict root, removeMemory would succeed).
    if (process.getuid?.() === 0) return; // can't trigger EACCES as root
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Old](old.md) — h\n');
    writeBody(roots.projectLocal, 'old', { expires: '2024-01-01' });
    chmodSync(roots.projectLocal, 0o500);
    try {
      const reg = createMemoryRegistry({ roots, db, sessionId });
      const result = gcExpiredMemories(reg, roots, {
        today: new Date(Date.UTC(2026, 4, 4)),
        auditSessionId: sessionId,
        auditCwd: '/p',
      });
      expect(result.removed).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.memory.name).toBe('old');

      const events = listMemoryEventsByName(db, 'old');
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe('refused');
      expect(events[0]?.details?.stage).toBe('lifecycle_gc');
      expect(events[0]?.details?.expires).toBe('2024-01-01');
      // The kind is `io_error` — failure came from the disk
      // write, not from a sandbox check.
      expect(events[0]?.details?.kind).toBe('io_error');
    } finally {
      // Restore so afterEach's rmSync can clean the tree.
      chmodSync(roots.projectLocal, 0o700);
    }
  });

  test('handles multiple expired across different scopes', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [U](u-mem.md) — h\n');
    writeIndex(roots.projectLocal, '- [L](l-mem.md) — h\n');
    writeBody(roots.user, 'u-mem', { expires: '2024-01-01', type: 'user' });
    writeBody(roots.projectLocal, 'l-mem', { expires: '2024-01-01' });
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = gcExpiredMemories(reg, roots, {
      today: new Date(Date.UTC(2026, 4, 4)),
    });
    expect(result.removed).toHaveLength(2);
    expect(existsSync(join(roots.user, 'u-mem.md'))).toBe(false);
    expect(existsSync(join(roots.projectLocal, 'l-mem.md'))).toBe(false);
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
