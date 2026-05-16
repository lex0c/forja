// Memory view tests (RETRIEVAL.md §3.1 + §3.2, slice 4.2).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import type { RetrievalQuery } from '../../src/retrieval/types.ts';
import { createMemoryView } from '../../src/retrieval/views/memory.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-retrieval-mem-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeBody = (
  dir: string,
  name: string,
  body: string,
  fm: { description?: string; state?: string; expires?: string } = {},
): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: ${fm.description ?? `description for ${name}`}`,
    'type: feedback',
    'source: inferred',
  ];
  if (fm.state !== undefined) lines.push(`state: ${fm.state}`);
  if (fm.expires !== undefined) lines.push(`expires: ${fm.expires}`);
  writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
};

const writeIndex = (dir: string, body: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
};

let db: DB;
let sessionId: string;

const baseQuery: RetrievalQuery = {
  text: 'auth',
  workflow: 'precedent_lookup',
  queryType: 'precedent',
  budgetTokens: 100,
};

beforeEach(() => {
  db = openMemoryDb();
  migrate(db);
  sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createMemoryView', () => {
  test('empty registry → no candidates', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search(baseQuery);
    expect(cands).toEqual([]);
  });

  test('empty query text → no candidates', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth service notes\n');
    writeBody(roots.user, 'auth', 'body about auth');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: '' });
    expect(cands).toEqual([]);
  });

  test('title hit returns a candidate scoped by scope/name', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'body content');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search(baseQuery);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.nodeId).toBe('memory:user/auth');
    expect(cands[0]?.view).toBe('memory');
    expect(cands[0]?.bootstrapScore).toBeGreaterThan(0);
    expect(cands[0]?.reason).toContain('BM25 match in user/auth');
  });

  test('description hit returns a candidate (weighted lower than title)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.user,
      '- [TitleHit](titlehit.md) — unrelated\n- [Other](other.md) — auth conventions\n',
    );
    writeBody(roots.user, 'titlehit', 'body');
    writeBody(roots.user, 'other', 'body', { description: 'auth conventions' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    // 'other' has description=auth conventions; should rank above titlehit.
    const otherC = cands.find((c) => c.nodeId === 'memory:user/other');
    expect(otherC).toBeDefined();
  });

  test('title weight (3x) outranks description weight (2x) for the same term', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.user,
      '- [Auth](auth.md) — unrelated stuff\n- [Stuff](stuff.md) — auth here\n',
    );
    writeBody(roots.user, 'auth', 'body content');
    writeBody(roots.user, 'stuff', 'body content', { description: 'auth here' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    const titleHit = cands.find((c) => c.nodeId === 'memory:user/auth');
    const descHit = cands.find((c) => c.nodeId === 'memory:user/stuff');
    if (!titleHit || !descHit) throw new Error('both expected');
    expect(titleHit.bootstrapScore).toBeGreaterThan(descHit.bootstrapScore);
  });

  test('body content matches only when loadBodies=true', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Notes](notes.md) — unrelated description\n');
    writeBody(roots.user, 'notes', 'this body mentions authentication deeply');
    const registry = createMemoryRegistry({ roots, db, sessionId });

    // loadBodies=false → no match (term only in body).
    const shallow = createMemoryView({ registry });
    const shallowHits = await shallow.search({ ...baseQuery, text: 'authentication' });
    expect(shallowHits).toEqual([]);

    // loadBodies=true → match.
    const deep = createMemoryView({ registry, loadBodies: true });
    const deepHits = await deep.search({ ...baseQuery, text: 'authentication' });
    expect(deepHits).toHaveLength(1);
    expect(deepHits[0]?.nodeId).toBe('memory:user/notes');
  });

  test('loadBodies=true does not emit memory_events action=read (BM25 corpus is internal)', async () => {
    // Regression: prior implementation called `registry.read` for
    // every listed memory when building the BM25 corpus, emitting
    // one audit-read row per indexed memory regardless of whether
    // it reached top-K. The view now uses `registry.peek` —
    // retrieval-side visibility lives in `retrieval_trace`;
    // `memory_events action=read` stays reserved for explicit
    // `memory_read` tool calls. Scenario indexes 5 memories but
    // produces zero hits (term not in any title/desc/body), so the
    // ONLY way an audit-read row could land is the indexing path.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`- [Note${i}](note${i}.md) — unrelated topic ${i}`);
      writeBody(roots.user, `note${i}`, `body content for note ${i}`);
    }
    writeIndex(roots.user, `${lines.join('\n')}\n`);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, loadBodies: true });
    await view.search({ ...baseQuery, text: 'xyzzy' });

    const readRows = db
      .prepare("SELECT COUNT(*) AS n FROM memory_events WHERE action = 'read'")
      .get() as { n: number };
    expect(readRows.n).toBe(0);
  });

  test('multi-scope: candidates carry the correct scope tag', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [UserAuth](userauth.md) — auth notes\n');
    writeBody(roots.user, 'userauth', 'body');
    writeIndex(roots.projectShared, '- [SharedAuth](sharedauth.md) — auth\n');
    writeBody(roots.projectShared, 'sharedauth', 'body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    const ids = cands.map((c) => c.nodeId).sort();
    expect(ids).toEqual(['memory:project_shared/sharedauth', 'memory:user/userauth']);
  });

  test('respects the limit option (top-K cap)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`- [Auth${i}](auth${i}.md) — auth ${i}`);
      writeBody(roots.user, `auth${i}`, 'body');
    }
    writeIndex(roots.user, `${lines.join('\n')}\n`);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, limit: 3 });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toHaveLength(3);
  });

  test('dedup by name: local override of a shared name surfaces once', async () => {
    // Same memory name in two scopes; spec §2.4 says local > shared.
    // The view consumes the deduplicated listing so the model sees
    // one candidate, not two.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Auth](auth.md) — auth\n');
    writeBody(roots.projectShared, 'auth', 'shared body');
    writeIndex(roots.projectLocal, '- [Auth](auth.md) — auth\n');
    writeBody(roots.projectLocal, 'auth', 'local body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.nodeId).toBe('memory:project_local/auth');
  });

  test('no overlap with query → no candidates', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Unrelated](unrelated.md) — totally different topic\n');
    writeBody(roots.user, 'unrelated', 'body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toEqual([]);
  });

  test('orphaned listing (body file missing) is filtered out of the candidate pool', async () => {
    // Registry index references a memory whose body file got
    // deleted out of band (operator removed the file but not the
    // index entry, or a partial purge left an orphaned listing).
    // Pre-state-filter this surfaced a candidate using only the
    // title + description; with the H1 state filter the view now
    // demands a present, active, unexpired body. Missing body =>
    // unknown state => excluded. The operator's `/memory audit`
    // surface (broader `list()` defaults) still shows the orphan;
    // the model does not.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth conventions\n');
    // Deliberately omit writeBody — the body file does not exist.
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, loadBodies: true });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toEqual([]);
  });

  test('malformed body file is filtered out of the candidate pool', async () => {
    // Frontmatter so broken `parseMemoryFile` rejects it. Same
    // policy as the missing-body case: the model should never see
    // a memory whose state can't be confirmed.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Broken](broken.md) — auth notes\n');
    mkdirSync(roots.user, { recursive: true });
    // No closing `---`, no fields — parser refuses.
    writeFileSync(join(roots.user, 'broken.md'), '---\nname: broken\n');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, loadBodies: true });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toEqual([]);
  });

  test('quarantined memory does not surface as candidate (H1 regression)', async () => {
    // The model must never see memories the operator quarantined.
    // Pre-state-filter, `registry.list({ deduplicateByName: true })`
    // returned every state — the view surfaced the candidate, BM25
    // ranked it, and the body landed in the slot. Now the view
    // passes `states: ['active']` so non-active states are excluded
    // from the candidate pool.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth conventions\n');
    writeBody(roots.user, 'auth', 'auth body content', { state: 'quarantined' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toEqual([]);
  });

  test('invalidated / proposed memories filtered out (H1)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.user,
      '- [Inv](inv.md) — invalidated auth\n- [Prop](prop.md) — proposed auth\n- [Active](active.md) — active auth\n',
    );
    writeBody(roots.user, 'inv', 'body', { state: 'invalidated' });
    writeBody(roots.user, 'prop', 'body', { state: 'proposed' });
    writeBody(roots.user, 'active', 'body', { state: 'active' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands.map((c) => c.nodeId)).toEqual(['memory:user/active']);
  });

  test('expired memory does not surface as candidate (H6 regression)', async () => {
    // Boot-time GC is the canonical sweep; this guards the gap
    // between boots where stale memories would otherwise still land
    // in the model's view.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.user,
      '- [Stale](stale.md) — auth conventions stale\n- [Fresh](fresh.md) — auth conventions fresh\n',
    );
    writeBody(roots.user, 'stale', 'body', { expires: '2024-01-01' });
    writeBody(roots.user, 'fresh', 'body', { expires: '2099-12-31' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands.map((c) => c.nodeId)).toEqual(['memory:user/fresh']);
  });
});
