// Cascading detector tests (EVICTION §6.4 — memory × memory).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectMemoryDependents } from '../../src/memory/dependents.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

let workdir: string;
let db: DB;
let sessionId: string;

const makeRoots = (): ScopeRoots => ({
  user: join(workdir, 'user'),
  projectShared: join(workdir, 'shared'),
  projectLocal: join(workdir, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeBody = (dir: string, name: string, body: string, type = 'feedback'): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: hook\ntype: ${type}\nsource: inferred\n---\n\n${body}\n`,
  );
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-deps-'));
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: workdir }).id;
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('detectMemoryDependents', () => {
  test('finds wiki-style [[target]] references in other memories', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [Ref](ref.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'the canonical mem entry');
    writeBody(roots.projectLocal, 'ref', 'see also [[mem]] for context');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toHaveLength(1);
    expect(deps[0]?.scope).toBe('project_local');
    expect(deps[0]?.name).toBe('ref');
    expect(deps[0]?.refKind).toBe('wiki');
  });

  test('finds markdown-link [link](target.md) references', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [Ref](ref.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'canonical');
    writeBody(roots.projectLocal, 'ref', 'see [the other doc](mem.md) for more');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toHaveLength(1);
    expect(deps[0]?.name).toBe('ref');
    expect(deps[0]?.refKind).toBe('md_link');
  });

  test('skips the evicted memory itself (self-reference)', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'this is [[mem]] referencing itself');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toEqual([]);
  });

  test('returns empty when no memory references the target', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [Other](other.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'standalone');
    writeBody(roots.projectLocal, 'other', 'unrelated body content');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toEqual([]);
  });

  test('cross-scope detection: user scope referencing project_local memory', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'project body');
    writeIndex(roots.user, '- [UserRef](user-ref.md) — h\n');
    writeBody(roots.user, 'user-ref', 'this user memory cites [[mem]]', 'user');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toHaveLength(1);
    expect(deps[0]?.scope).toBe('user');
    expect(deps[0]?.name).toBe('user-ref');
  });

  test('dedupes a single dependent that uses both wiki and md_link', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [Ref](ref.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'canonical');
    writeBody(roots.projectLocal, 'ref', 'first ref [[mem]] then again [also here](mem.md)');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toHaveLength(1);
    // Wiki takes precedence when both kinds are present.
    expect(deps[0]?.refKind).toBe('wiki');
  });

  test('multiple distinct dependents each get their own entry', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [A](a.md) — h\n- [B](b.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'canonical');
    writeBody(roots.projectLocal, 'a', 'a uses [[mem]] here');
    writeBody(roots.projectLocal, 'b', 'b also [uses](mem.md) it');
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toHaveLength(2);
    expect(deps.find((d) => d.name === 'a')?.refKind).toBe('wiki');
    expect(deps.find((d) => d.name === 'b')?.refKind).toBe('md_link');
  });

  test('ignores non-memory wiki refs (different names)', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [Other](other.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'canonical');
    writeBody(roots.projectLocal, 'other', 'this refs [[unrelated]] not [[mem]]'); // 'mem' SHOULD be detected here
    const reg = createMemoryRegistry({ roots, db, sessionId });

    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    // 'other' body references both [[unrelated]] and [[mem]];
    // detector should find the [[mem]] ref.
    expect(deps).toHaveLength(1);
    expect(deps[0]?.name).toBe('other');
  });

  test('ignores fully-qualified md links (./, /, http://)', () => {
    const roots = makeRoots();
    writeIndex(roots.projectLocal, '- [Mem](mem.md) — h\n- [Ref](ref.md) — h\n');
    writeBody(roots.projectLocal, 'mem', 'canonical');
    writeBody(
      roots.projectLocal,
      'ref',
      'see [path](./mem.md) and [absolute](/repo/mem.md) and [external](http://example.com/mem.md)',
    );
    const reg = createMemoryRegistry({ roots, db, sessionId });

    // None of these match because the md_link regex requires the
    // capture to be a bare name (no path separators).
    const deps = detectMemoryDependents(reg, 'project_local', 'mem');
    expect(deps).toEqual([]);
  });
});
