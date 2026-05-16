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
import { listProvenanceForMemory } from '../../src/storage/repos/memory-provenance.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall } from '../../src/storage/repos/tool-calls.ts';

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

describe('createMemoryRegistry — list states + expires filter (H1+H6)', () => {
  const fmWithState = (name: string, state?: string, expires?: string): string => {
    const lines = [
      `name: ${name}`,
      `description: hook for ${name}`,
      'type: user',
      'source: user_explicit',
    ];
    if (state !== undefined) lines.push(`state: ${state}`);
    if (expires !== undefined) lines.push(`expires: ${expires}`);
    return `${lines.join('\n')}\n`;
  };

  test('states filter excludes non-allowed states (default returns all)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — a\n- [B](b.md) — b\n- [C](c.md) — c\n');
    writeMemory(roots.user, 'a', fmWithState('a', 'active'), 'body\n');
    writeMemory(roots.user, 'b', fmWithState('b', 'quarantined'), 'body\n');
    writeMemory(roots.user, 'c', fmWithState('c'), 'body\n'); // no state → active
    const reg = createMemoryRegistry({ roots });
    // Default: every state returned.
    expect(reg.list()).toHaveLength(3);
    // states=['active'] excludes b; c (no state → 'active') passes.
    const active = reg.list({ states: ['active'] });
    expect(active.map((l) => l.name).sort()).toEqual(['a', 'c']);
    // Explicit broader allow-list passes all.
    const allStates = reg.list({ states: ['active', 'quarantined'] });
    expect(allStates).toHaveLength(3);
  });

  test('orphaned listing (missing body file) is excluded by states filter', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Phantom](phantom.md) — referenced but no body\n');
    // Deliberately no writeMemory call.
    const reg = createMemoryRegistry({ roots });
    expect(reg.list()).toHaveLength(1); // default: index says it exists
    expect(reg.list({ states: ['active'] })).toEqual([]); // state unknown → out
  });

  test('includeExpired=false excludes past-expiry memories', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Stale](stale.md) — old\n- [Fresh](fresh.md) — new\n');
    writeMemory(roots.user, 'stale', fmWithState('stale', undefined, '2024-01-01'), 'body\n');
    writeMemory(roots.user, 'fresh', fmWithState('fresh', undefined, '2099-12-31'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    // nowMs pinned to 2026-05-16 — stale is past, fresh is future.
    const nowMs = Date.UTC(2026, 4, 16); // month is 0-indexed
    const fresh = reg.list({ includeExpired: false, nowMs });
    expect(fresh.map((l) => l.name)).toEqual(['fresh']);
    // Default omits the filter, returns both.
    expect(reg.list()).toHaveLength(2);
  });

  test('end-of-day semantics: expires=YYYY-MM-DD is valid through that day', () => {
    // A memory with `expires: 2026-05-15` should be valid on
    // 2026-05-15 (any time-of-day) and expired starting
    // 2026-05-16 00:00 UTC. Mirrors operator intuition that
    // "expires today" = "valid through today".
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Edge](edge.md) — boundary\n');
    writeMemory(roots.user, 'edge', fmWithState('edge', undefined, '2026-05-15'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    // Mid-day on the expiry date — still valid.
    const midDayMs = Date.UTC(2026, 4, 15, 12, 0, 0);
    expect(reg.list({ includeExpired: false, nowMs: midDayMs })).toHaveLength(1);
    // 00:00 UTC the next day — expired.
    const nextDayMs = Date.UTC(2026, 4, 16, 0, 0, 0);
    expect(reg.list({ includeExpired: false, nowMs: nextDayMs })).toEqual([]);
  });

  test('ineligible higher-precedence shadow does NOT suppress eligible lower-precedence (regression)', () => {
    // Pre-fix: list() deduplicated by name BEFORE evaluating
    // states/includeExpired. A local quarantined `foo` would win
    // the precedence walk (local > shared > user) and then be
    // dropped by the state filter, leaving zero candidates for
    // `foo` even though shared/user had an active version that
    // should have surfaced. Filter must run BEFORE dedupe so
    // precedence operates over eligible memories only.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Foo](foo.md) — local quarantined\n');
    writeIndex(roots.projectShared, '- [Foo](foo.md) — shared active\n');
    writeIndex(roots.user, '- [Foo](foo.md) — user active\n');
    writeMemory(roots.projectLocal, 'foo', fmWithState('foo', 'quarantined'), 'local body\n');
    writeMemory(roots.projectShared, 'foo', fmWithState('foo', 'active'), 'shared body\n');
    writeMemory(roots.user, 'foo', fmWithState('foo', 'active'), 'user body\n');
    const reg = createMemoryRegistry({ roots });

    // With state filter active: local is quarantined → excluded;
    // among the remaining eligible {shared, user}, dedupe picks
    // shared (higher precedence). User stays hidden — that's
    // dedupe-by-name's purpose.
    const result = reg.list({ deduplicateByName: true, states: ['active'] });
    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe('project_shared');
    expect(result[0]?.name).toBe('foo');
  });

  test('all shadows ineligible → name absent from result (regression)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Foo](foo.md) — local\n');
    writeIndex(roots.projectShared, '- [Foo](foo.md) — shared\n');
    writeMemory(roots.projectLocal, 'foo', fmWithState('foo', 'quarantined'), 'body\n');
    writeMemory(roots.projectShared, 'foo', fmWithState('foo', 'evicted'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    const result = reg.list({ deduplicateByName: true, states: ['active'] });
    expect(result).toEqual([]);
  });

  test('expired higher-precedence shadow does NOT suppress fresh lower-precedence', () => {
    // Same precedence-aware filtering for the expires case: a
    // local memory past its expires shouldn't hide a shared/user
    // sibling that's still valid.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Bar](bar.md) — local stale\n');
    writeIndex(roots.projectShared, '- [Bar](bar.md) — shared fresh\n');
    writeMemory(roots.projectLocal, 'bar', fmWithState('bar', undefined, '2024-01-01'), 'body\n');
    writeMemory(roots.projectShared, 'bar', fmWithState('bar', undefined, '2099-12-31'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    const nowMs = Date.UTC(2026, 4, 16);
    const result = reg.list({ deduplicateByName: true, includeExpired: false, nowMs });
    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe('project_shared');
  });

  test('combined: states + expires + scope + dedupe filter compose', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [A](a.md) — local-active\n- [B](b.md) — local-stale\n');
    writeIndex(roots.user, '- [A](a.md) — user-shadow\n');
    writeMemory(roots.projectLocal, 'a', fmWithState('a', 'active'), 'body\n');
    writeMemory(roots.projectLocal, 'b', fmWithState('b', 'active', '2024-01-01'), 'body\n');
    writeMemory(roots.user, 'a', fmWithState('a', 'active'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    const nowMs = Date.UTC(2026, 4, 16);
    const result = reg.list({
      deduplicateByName: true,
      states: ['active'],
      includeExpired: false,
      nowMs,
    });
    // A: deduped to project_local. B: excluded (expired).
    expect(result.map((l) => `${l.scope}/${l.name}`)).toEqual(['project_local/a']);
  });

  test('month-end expires dates are valid (regression: prior overflow guard rejected them)', () => {
    // Prior implementation computed `Date.UTC(y, m-1, day+1)` and
    // required `round.getUTCMonth() === m - 1`, which incorrectly
    // rejected every legitimate last-day-of-month (`2026-01-31` →
    // start-of-next-day is Feb 1 → month mismatch → null). With
    // null returned, `isExpired` returned false and the memory
    // stayed visible to `list({ includeExpired: false })` past its
    // expiry. Today's two-step parse validates the date itself,
    // then adds 24h.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Jan31](jan31.md) — jan\n- [Dec31](dec31.md) — dec\n');
    writeMemory(roots.user, 'jan31', fmWithState('jan31', undefined, '2026-01-31'), 'body\n');
    writeMemory(roots.user, 'dec31', fmWithState('dec31', undefined, '2026-12-31'), 'body\n');
    const reg = createMemoryRegistry({ roots });

    // 2026-01-31 14:00 UTC — both still valid (mid-day on Jan 31
    // for jan31; far future for dec31).
    const jan31Noon = Date.UTC(2026, 0, 31, 14, 0, 0);
    expect(
      reg
        .list({ includeExpired: false, nowMs: jan31Noon })
        .map((l) => l.name)
        .sort(),
    ).toEqual(['dec31', 'jan31']);

    // 2026-02-01 00:00 UTC — Jan 31 just expired; Dec 31 unaffected.
    // This is the case the previous overflow bug HID: jan31 should
    // expire here, but with `parseExpiresEndOfDayMs` returning null
    // (rejected as malformed) `isExpired` returned false and jan31
    // stayed visible.
    const feb1Midnight = Date.UTC(2026, 1, 1, 0, 0, 0);
    expect(
      reg
        .list({ includeExpired: false, nowMs: feb1Midnight })
        .map((l) => l.name)
        .sort(),
    ).toEqual(['dec31']);

    // 2027-01-01 00:00 UTC — both expired. Year-rollover boundary.
    const jan1_2027 = Date.UTC(2027, 0, 1, 0, 0, 0);
    expect(reg.list({ includeExpired: false, nowMs: jan1_2027 })).toEqual([]);
  });

  test('leap-day expires (2024-02-29) is valid and expires correctly the next day', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Leap](leap.md) — leap day\n');
    writeMemory(roots.user, 'leap', fmWithState('leap', undefined, '2024-02-29'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    // 2024-02-29 23:00 UTC — still valid.
    const lateLeapDay = Date.UTC(2024, 1, 29, 23, 0, 0);
    expect(reg.list({ includeExpired: false, nowMs: lateLeapDay })).toHaveLength(1);
    // 2024-03-01 00:00 UTC — expired.
    const march1 = Date.UTC(2024, 2, 1, 0, 0, 0);
    expect(reg.list({ includeExpired: false, nowMs: march1 })).toEqual([]);
  });

  test('numerically-invalid expires (e.g. 2026-02-31) treated as non-expiring (defensive)', () => {
    // The frontmatter validator's EXPIRES_RE only checks the
    // YYYY-MM-DD format, not whether the date is a real calendar
    // day. A hand-edited `2026-02-31` survives parsing.
    // `parseExpiresEndOfDayMs` now refuses such inputs (returns
    // null), and `isExpired(undefined-like, …)` treats the result
    // as "no expiry set" — the memory stays visible. Operator
    // discovers the malformed date via `/memory audit`, NOT via
    // surprise eviction.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Bad](bad.md) — bad date\n');
    writeMemory(roots.user, 'bad', fmWithState('bad', undefined, '2026-02-31'), 'body\n');
    const reg = createMemoryRegistry({ roots });
    const nowMs = Date.UTC(2099, 0, 1); // far future — every real expiry would have passed
    expect(reg.list({ states: ['active'], includeExpired: false, nowMs })).toHaveLength(1);
  });

  test('malformed frontmatter (bad expires) excluded by state filter (defense in depth)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Wonky](wonky.md) — bad expires\n');
    writeMemory(
      roots.user,
      'wonky',
      'name: wonky\ndescription: hook\ntype: user\nsource: user_explicit\nexpires: not-a-date\n',
      'body\n',
    );
    const reg = createMemoryRegistry({ roots });
    // The validator at write time would refuse this; on read,
    // `parseMemoryFile` returns `malformed`. The state filter
    // sees `kind !== 'present'` and excludes. The operator's
    // `/memory audit` surface (broader `list()` defaults) still
    // shows the entry — that's where they fix the hand-edit.
    expect(reg.list()).toHaveLength(1); // default list still surfaces it
    expect(reg.list({ states: ['active'] })).toEqual([]); // model-facing path excludes
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

describe('createMemoryRegistry — count', () => {
  test('returns 0 when no scope has an index', () => {
    const repo = makeTmp();
    const reg = createMemoryRegistry({ roots: makeRoots(repo) });
    expect(reg.count()).toBe(0);
  });

  test('returns total entries across all scopes by default', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — h\n- [B](b.md) — h\n');
    writeIndex(roots.projectShared, '- [C](c.md) — h\n');
    writeIndex(roots.projectLocal, '- [D](d.md) — h\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.count()).toBe(4);
  });

  test('deduplicateByName collapses shadowed names', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Style](commit-style.md) — h\n');
    writeIndex(roots.projectShared, '- [Style](commit-style.md) — h\n');
    writeIndex(roots.projectLocal, '- [Style](commit-style.md) — h\n');
    const reg = createMemoryRegistry({ roots });
    expect(reg.count()).toBe(3);
    expect(reg.count({ deduplicateByName: true })).toBe(1);
  });

  test('count reflects post-write state without explicit reload', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const db = openMemoryDb();
    migrate(db);
    const sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
    const reg = createMemoryRegistry({ roots, db, sessionId });
    expect(reg.count()).toBe(0);
    reg.write({
      scope: 'project_local',
      frontmatter: {
        name: 'fresh',
        description: 'h',
        type: 'feedback',
        source: 'inferred',
      },
      body: 'b',
    });
    // write() auto-refreshes the snapshot, so count reflects it.
    expect(reg.count()).toBe(1);
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

describe('createMemoryRegistry — provenance emission (S1/T1.3)', () => {
  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  const seedToolCall = (): string => {
    const msgId = appendMessage(db, { sessionId, role: 'assistant', content: 'x' }).id;
    return createToolCall(db, { messageId: msgId, toolName: 'memory_read', input: {} }).id;
  };

  test('read with auditToolCallId emits a memory_read provenance row', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'Body of role.\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const toolCallId = seedToolCall();

    const result = reg.read('role', { auditToolCallId: toolCallId });
    expect(result.kind).toBe('present');

    const rows = listProvenanceForMemory(db, sessionId, 'project_local', 'role');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.surface).toBe('memory_read');
    expect(rows[0]?.toolCallId).toBe(toolCallId);
    expect(rows[0]?.memoryScope).toBe('project_local');
    expect(rows[0]?.memoryStateAtExposure).toBe('active');
    expect(rows[0]?.memoryContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.retrievalQueryId).toBeNull();
    expect(rows[0]?.positionInCorpus).toBeNull();
  });

  test('read WITHOUT auditToolCallId emits NO provenance row (other surfaces own their path)', () => {
    // The eager-load (T1.4) and retrieve_context (T1.5) paths
    // pass their own surface — the registry MUST stay silent
    // here so it doesn't double-emit or claim memory_read for
    // exposures that aren't tool-call-driven.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'b');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });

    reg.read('role');
    expect(listProvenanceForMemory(db, sessionId, 'project_local', 'role')).toEqual([]);
    // But memory_events DID fire — that path is independent.
    expect(listMemoryEventsByName(db, 'role')).toHaveLength(1);
  });

  test('read on missing body emits neither audit nor provenance', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Role](role.md) — role\n');
    const reg = createMemoryRegistry({ roots, db, sessionId });
    const toolCallId = seedToolCall();
    const result = reg.read('role', { auditToolCallId: toolCallId });
    expect(result.kind).toBe('missing');
    expect(listProvenanceForMemory(db, sessionId, 'user', 'role')).toEqual([]);
  });

  test('hash is stable across reads of the same content', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'Body.\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const tc1 = seedToolCall();
    const tc2 = seedToolCall();
    reg.read('role', { auditToolCallId: tc1 });
    reg.read('role', { auditToolCallId: tc2 });
    const rows = listProvenanceForMemory(db, sessionId, 'project_local', 'role');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.memoryContentHash).toBe(rows[1]?.memoryContentHash);
    expect(rows[0]?.toolCallId).not.toBe(rows[1]?.toolCallId);
  });

  test('quarantined frontmatter state survives in provenance snapshot', () => {
    // Operator could transition the memory later; the row must
    // pin the state AT EXPOSURE TIME, not the latest.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', `${fmUser('role')}state: quarantined\n`, 'b');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const toolCallId = seedToolCall();
    reg.read('role', { auditToolCallId: toolCallId });
    const rows = listProvenanceForMemory(db, sessionId, 'project_local', 'role');
    expect(rows[0]?.memoryStateAtExposure).toBe('quarantined');
  });

  test('provenance failure (invalid toolCallId FK) does NOT break the read', () => {
    // Audit-drift posture: the body load already succeeded; a
    // failure recording the exposure is best-effort and MUST NOT
    // surface as an exception to the caller.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Role](role.md) — role\n');
    writeMemory(roots.projectLocal, 'role', fmUser('role'), 'body\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });

    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = reg.read('role', { auditToolCallId: 'does-not-exist' });
      expect(result.kind).toBe('present');
      if (result.kind === 'present') {
        expect(result.file.body).toBe('body\n');
      }
    } finally {
      process.stderr.write = original;
    }
    expect(captured.join('')).toMatch(/AUDIT DRIFT.*exposure/);
    expect(listProvenanceForMemory(db, sessionId, 'project_local', 'role')).toEqual([]);
  });

  test('search-deep body match emits a memory_read provenance row', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](a.md) — surface\n');
    writeMemory(roots.user, 'a', fmUser('a'), 'body has zebra inside\n');
    const reg = createMemoryRegistry({ roots, db, sessionId, cwd: '/p' });
    const toolCallId = seedToolCall();
    const hits = reg.search('zebra', { deep: true, auditToolCallId: toolCallId });
    expect(hits).toHaveLength(1);
    const rows = listProvenanceForMemory(db, sessionId, 'user', 'a');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.surface).toBe('memory_read');
    expect(rows[0]?.toolCallId).toBe(toolCallId);
  });
});
