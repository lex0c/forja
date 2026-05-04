import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import type { DB } from '../../src/storage/db.ts';
import { openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { listMemoryEventsByName } from '../../src/storage/repos/memory-events.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-mem-reg-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

const writeMemory = (dir: string, name: string, frontmatter: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}---\n\n${body}`);
};

const fmUser = (name: string, source = 'user_explicit'): string =>
  `name: ${name}\ndescription: hook for ${name}\ntype: user\nsource: ${source}\n`;

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createMemoryRegistry — list', () => {
  test('returns empty when no scope has an index', () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    expect(reg.list()).toEqual([]);
  });

  test('returns entries from all three scopes in precedence order', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [User](user-only.md) — user\n');
    writeIndex(roots.projectShared, '- [Shared](shared-only.md) — shared\n');
    writeIndex(roots.projectLocal, '- [Local](local-only.md) — local\n');
    const reg = createMemoryRegistry({ roots });
    const list = reg.list();
    expect(list.map((l) => `${l.scope}/${l.name}`)).toEqual([
      'project_local/local-only',
      'project_shared/shared-only',
      'user/user-only',
    ]);
  });

  test('filters by scope when requested', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — a\n');
    writeIndex(roots.projectLocal, '- [B](b.md) — b\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.list({ scope: 'project_local' })).toHaveLength(1);
    expect(reg.list({ scope: 'project_local' })[0]?.name).toBe('b');
  });

  test('dedupeByName collapses shadowed entries to most-specific', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — user-a\n');
    writeIndex(roots.projectShared, '- [A](a.md) — shared-a\n');
    writeIndex(roots.projectLocal, '- [A](a.md) — local-a\n');
    const reg = createMemoryRegistry({ roots });
    const all = reg.list();
    expect(all).toHaveLength(3);
    const dedup = reg.list({ deduplicateByName: true });
    expect(dedup).toHaveLength(1);
    expect(dedup[0]?.scope).toBe('project_local');
    expect(dedup[0]?.entry.hook).toBe('local-a');
  });
});

describe('createMemoryRegistry — lookup', () => {
  test('returns null for unknown name', () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    expect(reg.lookup('nope')).toBeNull();
  });

  test('returns most-specific scope when name is shadowed', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — user-a\n');
    writeIndex(roots.projectLocal, '- [A](a.md) — local-a\n');
    const reg = createMemoryRegistry({ roots });
    const hit = reg.lookup('a');
    expect(hit?.scope).toBe('project_local');
  });

  test('strict scope match does NOT fall back', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — user-a\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.lookup('a', { scope: 'project_local' })).toBeNull();
    expect(reg.lookup('a', { scope: 'user' })?.scope).toBe('user');
  });
});

describe('createMemoryRegistry — read with audit', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('reads body and emits a `read` audit event', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'Body of role.\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const result = reg.read('role');
    if (result.kind !== 'present') throw new Error(`expected present, got ${result.kind}`);
    expect(result.scope).toBe('project_local');
    expect(result.file.body).toBe('Body of role.\n');
    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('read');
    expect(events[0]?.scope).toBe('project_local');
    expect(events[0]?.sessionId).toBe(sessionId);
    expect(events[0]?.cwd).toBe('/p');
    expect(events[0]?.source).toBe('user_explicit');
  });

  test('does NOT emit audit on missing body', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    // No body file written.
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = reg.read('role');
    expect(result.kind).toBe('missing');
    expect(listMemoryEventsByName(db, 'role')).toEqual([]);
  });

  test('does NOT emit audit on malformed body', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', 'name: role\ntype: bogus\nsource: user_explicit\n', '');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = reg.read('role');
    expect(result.kind).toBe('malformed');
    expect(listMemoryEventsByName(db, 'role')).toEqual([]);
  });

  test('returns unknown when name not in any scope', () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    expect(reg.read('nope').kind).toBe('unknown');
    expect(listMemoryEventsByName(db, 'nope')).toEqual([]);
  });

  test('does not emit audit when constructed without DB', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'b');
    const reg = createMemoryRegistry({ roots });
    const result = reg.read('role');
    expect(result.kind).toBe('present');
    // No db handle, so no events table to query — just exercise
    // the no-throw path.
  });
});

describe('createMemoryRegistry — search', () => {
  test('matches name (case-insensitive)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Commit Style](commit-style.md) — commit conventions\n');
    const reg = createMemoryRegistry({ roots });
    const hits = reg.search('COMMIT');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedIn).toBe('name');
  });

  test('matches description', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Q2](q2.md) — workshop deadline 2026-08-15\n');
    const reg = createMemoryRegistry({ roots });
    const hits = reg.search('workshop');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedIn).toBe('description');
    expect(hits[0]?.snippet).toContain('workshop');
  });

  test('does NOT match body without deep flag', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface text\n');
    writeMemory(roots.user, 'a', fmUser('a'), 'body containing zebra keyword\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.search('zebra')).toHaveLength(0);
  });

  test('matches body when deep=true', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface text\n');
    writeMemory(roots.user, 'a', fmUser('a'), 'body containing zebra keyword\n');
    const reg = createMemoryRegistry({ roots });
    const hits = reg.search('zebra', { deep: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedIn).toBe('body');
    expect(hits[0]?.snippet).toContain('zebra');
  });

  test('respects limit', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`- [E${i}](e${i}.md) — entry ${i} matches\n`);
    }
    writeIndex(roots.user, lines.join(''));
    const reg = createMemoryRegistry({ roots });
    expect(reg.search('matches', { limit: 3 })).toHaveLength(3);
  });

  test('returns empty for empty query', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — a\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.search('   ')).toEqual([]);
    expect(reg.search('')).toEqual([]);
  });

  test('filters by scope', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — alpha\n');
    writeIndex(roots.projectLocal, '- [B](b.md) — alpha\n');
    const reg = createMemoryRegistry({ roots });
    const all = reg.search('alpha');
    expect(all).toHaveLength(2);
    const local = reg.search('alpha', { scope: 'project_local' });
    expect(local).toHaveLength(1);
    expect(local[0]?.scope).toBe('project_local');
  });
});

describe('createMemoryRegistry — per-call audit override (regression: bootstrap session-id)', () => {
  let db: DB;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
  });

  test('per-call auditSessionId wins over constructor (constructor undefined)', () => {
    // The bootstrap path: constructor builds the registry BEFORE
    // the harness creates the session, so constructor.sessionId
    // is undefined. Tools forward ctx.sessionId via the per-call
    // override so audit rows attribute correctly.
    const session = createSession(db, { model: 'm', cwd: '/p' });
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'body\n');
    // Constructor without sessionId — mirrors bootstrap.ts.
    const reg = createMemoryRegistry({ roots, db, cwd: '/p' });
    const result = reg.read('role', { auditSessionId: session.id, auditCwd: '/p' });
    expect(result.kind).toBe('present');
    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    // Pre-fix this would have been null.
    expect(events[0]?.sessionId).toBe(session.id);
    expect(events[0]?.cwd).toBe('/p');
  });

  test('constructor sessionId is the fallback when override absent', () => {
    // Subagent-child path: constructor knows the session id.
    // Calls without explicit override use the captured value.
    const session = createSession(db, { model: 'm', cwd: '/p' });
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'body\n');
    const reg = createMemoryRegistry({ roots, db, sessionId: session.id, cwd: '/p' });
    reg.read('role'); // no override
    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe(session.id);
  });

  test('per-call override beats constructor when both set', () => {
    const constructorSession = createSession(db, { model: 'm', cwd: '/c' });
    const callSession = createSession(db, { model: 'm', cwd: '/p' });
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'body\n');
    const reg = createMemoryRegistry({
      roots,
      db,
      sessionId: constructorSession.id,
      cwd: '/c',
    });
    reg.read('role', { auditSessionId: callSession.id, auditCwd: '/p' });
    const events = listMemoryEventsByName(db, 'role');
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe(callSession.id);
    expect(events[0]?.cwd).toBe('/p');
  });

  test('search deep-body audit uses per-call override too', () => {
    const session = createSession(db, { model: 'm', cwd: '/p' });
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface\n');
    writeMemory(roots.user, 'a', fmUser('a'), 'body has zebra inside\n');
    const reg = createMemoryRegistry({ roots, db, cwd: '/p' });
    const hits = reg.search('zebra', {
      deep: true,
      auditSessionId: session.id,
      auditCwd: '/p',
    });
    expect(hits).toHaveLength(1);
    const events = listMemoryEventsByName(db, 'a');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('read');
    expect(events[0]?.sessionId).toBe(session.id);
  });
});

describe('createMemoryRegistry — search-deep audit (regression: S1)', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('deep body match emits a read audit event', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface text\n');
    writeMemory(roots.user, 'a', fmUser('a'), 'body has zebra inside\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const hits = reg.search('zebra', { deep: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedIn).toBe('body');
    const events = listMemoryEventsByName(db, 'a');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('read');
    expect(events[0]?.sessionId).toBe(sessionId);
  });

  test('shallow match does NOT emit a read event', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Commit](commit-style.md) — verbs\n');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const hits = reg.search('commit');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedIn).toBe('name');
    expect(listMemoryEventsByName(db, 'commit-style')).toEqual([]);
  });

  test('deep match that does not hit body still does NOT emit', () => {
    // Body is read from disk during deep mode but no match found.
    // No `read` event should fire — the model never sees the body.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface\n');
    writeMemory(roots.user, 'a', fmUser('a'), 'body without the keyword\n');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const hits = reg.search('zebra', { deep: true });
    expect(hits).toEqual([]);
    expect(listMemoryEventsByName(db, 'a')).toEqual([]);
  });
});

describe('createMemoryRegistry — malformed href tolerance (regression: C1)', () => {
  test('list / search skip entries whose href is not a .md file instead of crashing', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // Operator hand-edited an index entry to point at an external
    // URL (parser accepts arbitrary non-paren content per
    // index-file SECURITY CONTRACT).
    writeIndex(
      roots.user,
      [
        '- [Bad](https://evil.example.com) — external pointer\n',
        '- [Good](good.md) — valid entry\n',
        '- [AlsoBad](broken-no-suffix) — another bad one\n',
      ].join(''),
    );
    const reg = createMemoryRegistry({ roots });
    // Pre-fix this throws; post-fix only the .md entry is exposed.
    expect(reg.list().map((l) => l.name)).toEqual(['good']);
    expect(reg.search('valid').map((h) => h.name)).toEqual(['good']);
    expect(reg.lookup('good')?.scope).toBe('user');
    expect(reg.lookup('https://evil.example.com')).toBeNull();
  });
});

describe('createMemoryRegistry — audit drift tolerance (regression: M1)', () => {
  test('read returns body even if audit DB write throws', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'body content\n');

    // Build a real DB but close it so any insert raises.
    const broken = openMemoryDb();
    migrate(broken);
    broken.close();

    const reg = createMemoryRegistry({ roots, db: broken, sessionId: 's-1', cwd: '/p' });

    // Capture stderr writes to assert the AUDIT DRIFT warning.
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = reg.read('role');
      expect(result.kind).toBe('present');
      if (result.kind === 'present') {
        expect(result.file.body).toBe('body content\n');
      }
    } finally {
      process.stderr.write = original;
    }
    expect(captured.join('')).toMatch(/AUDIT DRIFT/);
  });
});

describe('createMemoryRegistry — reload', () => {
  test('picks up index changes after construction', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — first\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.list()).toHaveLength(1);
    writeIndex(roots.user, '- [A](a.md) — first\n- [B](b.md) — second\n');
    // No reload yet — stale view.
    expect(reg.list()).toHaveLength(1);
    reg.reload();
    expect(reg.list()).toHaveLength(2);
  });
});

describe('createMemoryRegistry — peek', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('returns the file body without emitting a read audit row', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'Body of role.\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const result = reg.peek('role');
    if (result.kind !== 'present') throw new Error(`expected present, got ${result.kind}`);
    expect(result.scope).toBe('project_local');
    expect(result.file.body).toBe('Body of role.\n');
    // Crucially: NO audit row.
    expect(listMemoryEventsByName(db, 'role')).toEqual([]);
  });

  test('returns unknown for missing name (no audit)', () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    expect(reg.peek('nope').kind).toBe('unknown');
    expect(listMemoryEventsByName(db, 'nope')).toEqual([]);
  });

  test('strict scope opt-in (no fallback)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — user-scope\n');
    writeMemory(roots.user, 'role', fmUser('role'), 'b');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    expect(reg.peek('role', { scope: 'project_local' }).kind).toBe('unknown');
    expect(reg.peek('role').kind).toBe('present');
  });
});

describe('createMemoryRegistry — write', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  test('persists, emits `created` audit, and refreshes snapshot', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const before = reg.list();
    expect(before).toHaveLength(0);

    const result = reg.write({
      scope: 'project_local',
      frontmatter: {
        name: 'no-console-log',
        description: 'no console.log in src/',
        type: 'feedback',
        source: 'inferred',
      },
      body: 'Body content here.',
    });
    expect(result.kind).toBe('created');

    // Snapshot refreshed automatically.
    const after = reg.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe('no-console-log');

    const events = listMemoryEventsByName(db, 'no-console-log');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('created');
    expect(events[0]?.scope).toBe('project_local');
    expect(events[0]?.source).toBe('inferred');
    expect(events[0]?.sessionId).toBe(sessionId);
    expect(events[0]?.cwd).toBe('/p');
    expect(events[0]?.details?.type).toBe('feedback');
  });

  test('emits `refused` with reason for shared_forbidden', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = reg.write({
      scope: 'project_shared',
      frontmatter: {
        name: 'team-mem',
        description: 'd',
        type: 'feedback',
        source: 'inferred',
      },
      body: 'b',
    });
    expect(result.kind).toBe('shared_forbidden');
    const events = listMemoryEventsByName(db, 'team-mem');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('refused');
    expect(events[0]?.details?.kind).toBe('shared_forbidden');
    expect(events[0]?.details?.reason).toContain('promote');
  });

  test('emits `refused` for exists collision', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.projectLocal, { recursive: true });
    writeFileSync(join(roots.projectLocal, 'dup.md'), 'something');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const result = reg.write({
      scope: 'project_local',
      frontmatter: {
        name: 'dup',
        description: 'd',
        type: 'feedback',
        source: 'inferred',
      },
      body: 'b',
    });
    expect(result.kind).toBe('exists');
    const events = listMemoryEventsByName(db, 'dup');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('refused');
    expect(events[0]?.details?.kind).toBe('exists');
  });

  test('per-call audit override wins over constructor-captured ids', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const otherSession = createSession(db, { model: 'm2', cwd: '/q' }).id;
    reg.write({
      scope: 'user',
      frontmatter: {
        name: 'pref-x',
        description: 'd',
        type: 'user',
        source: 'inferred',
      },
      body: 'b',
      auditSessionId: otherSession,
      auditCwd: '/q',
    });
    const events = listMemoryEventsByName(db, 'pref-x');
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe(otherSession);
    expect(events[0]?.cwd).toBe('/q');
  });

  test('does not emit audit when constructed without DB', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const reg = createMemoryRegistry({ roots });
    const result = reg.write({
      scope: 'project_local',
      frontmatter: {
        name: 'no-db',
        description: 'd',
        type: 'feedback',
        source: 'inferred',
      },
      body: 'b',
    });
    expect(result.kind).toBe('created');
    // No db handle to assert on — just exercise the no-throw path.
  });
});
