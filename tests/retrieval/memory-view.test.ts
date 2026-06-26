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
  fm: {
    description?: string;
    state?: string;
    expires?: string;
    trust?: string;
    triggers?: string[];
  } = {},
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
  if (fm.trust !== undefined) lines.push(`trust: ${fm.trust}`);
  if (fm.triggers !== undefined) lines.push(`triggers: [${fm.triggers.join(', ')}]`);
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

  test('quarantined memory surfaces with ranking penalty (S6/T6.1, EVICTION §9.7)', async () => {
    // Walks back the H1 hard-filter: quarantined memories are now
    // VISIBLE to retrieval with a ×0.3 penalty on bootstrap score.
    // Spec EVICTION §9.7 + MEMORY.md §6.5.2 — penalty + visual flag
    // is the spec'd behavior; hard-filtering was the safety
    // shortcut. The model still sees the candidate but ranks it
    // below an active sibling with comparable match quality.
    //
    // The `reason` string carries the `quarantined ×0.3` marker so
    // retrieval_trace forensics can see why a candidate ranks
    // where it does.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth conventions\n');
    writeBody(roots.user, 'auth', 'auth body content', { state: 'quarantined' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.nodeId).toBe('memory:user/auth');
    expect(cands[0]?.reason).toContain('quarantined');
    expect(cands[0]?.reason).toContain('×0.3');
  });

  test('QUARANTINED_PENALTY constant value is exactly 0.3 (S6/T6.1 — pin)', async () => {
    // Pinning the literal value (not just "quarantined < active").
    // A silent change to 0.25 or 0.5 would still pass relative-
    // ordering tests; the constant value is part of the behavioral
    // contract documented in MEMORY.md §6.5.2 (~3.3× match needed
    // for parity). Import + assert directly.
    const { QUARANTINED_PENALTY } = await import('../../src/retrieval/views/memory.ts');
    expect(QUARANTINED_PENALTY).toBe(0.3);
  });

  test('dedupe keeps quarantined local shadow when active shared sibling exists (S6 × H3)', async () => {
    // Per the dedupe-after-filter ordering fix (commit 949fadf),
    // state filter runs BEFORE dedupe-by-name. Pre-S6: `local:
    // quarantined foo` was filtered out → dedupe saw only
    // `shared: active foo` → shared surfaced. Post-S6: BOTH
    // survive the state filter (quarantined now included), then
    // dedupe-by-name picks local (most-specific scope wins).
    //
    // Net behavior: the model sees the quarantined local version,
    // NOT the active shared sibling. This is spec'd (scope
    // precedence trumps state preference) but a real semantic
    // change from pre-S6 — pinned here so future refactors don't
    // silently revert.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Foo](foo.md) — shared auth hook\n');
    writeIndex(roots.projectLocal, '- [Foo](foo.md) — local auth hook\n');
    writeBody(roots.projectShared, 'foo', 'shared body content', { state: 'active' });
    writeBody(roots.projectLocal, 'foo', 'local body content', { state: 'quarantined' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.nodeId).toBe('memory:project_local/foo');
    expect(cands[0]?.reason).toContain('quarantined');
  });

  test('quarantined ranks below active sibling with comparable bootstrap (S6/T6.1)', async () => {
    // Two memories with identical match shape; only state differs.
    // Both surface; quarantined's bootstrapScore = active's × 0.3.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.user,
      '- [Active](active.md) — auth\n- [Quarantined](quarantined.md) — auth\n',
    );
    writeBody(roots.user, 'active', 'auth body content', { state: 'active' });
    writeBody(roots.user, 'quarantined', 'auth body content', { state: 'quarantined' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const cands = await view.search({ ...baseQuery, text: 'auth' });
    expect(cands).toHaveLength(2);
    const active = cands.find((c) => c.nodeId === 'memory:user/active');
    const quarantined = cands.find((c) => c.nodeId === 'memory:user/quarantined');
    expect(active).toBeDefined();
    expect(quarantined).toBeDefined();
    if (active === undefined || quarantined === undefined) return;
    // Same match quality means same raw BM25 score; quarantined's
    // bootstrapScore is exactly active's × 0.3 (within float
    // tolerance). Active ranks above quarantined as a result.
    expect(quarantined.bootstrapScore).toBeCloseTo(active.bootstrapScore * 0.3, 5);
    expect(active.bootstrapScore).toBeGreaterThan(quarantined.bootstrapScore);
  });

  test('invalidated / proposed memories still filtered out (only quarantined survives penalty)', async () => {
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

  test('loadBodies peek is scope-pinned (H3) — local body wins over shared with same name', async () => {
    // Both scopes have a memory named `auth`. Local body contains
    // the distinctive token "fortress"; shared has "castle". After
    // dedupe-by-name (local > shared), the BM25 corpus must use
    // the LOCAL body. Without scope-pinning, peek would re-walk
    // precedence — today it happens to land on local too (same
    // precedence), but the invariant pin prevents a future
    // registry-state race from picking the wrong scope.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Auth](auth.md) — shared\n');
    writeIndex(roots.projectLocal, '- [Auth](auth.md) — local\n');
    writeBody(roots.projectShared, 'auth', 'auth body castle');
    writeBody(roots.projectLocal, 'auth', 'auth body fortress');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, loadBodies: true });
    // Query only matches the LOCAL body's distinctive token.
    const cands = await view.search({ ...baseQuery, text: 'fortress' });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.nodeId).toBe('memory:project_local/auth');
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

  test('excludeScopes drops every candidate in the named scope (S5 CRIT/H2)', async () => {
    // When the bootstrap's trust probe returns a non-confirmed
    // outcome (verify_failed / deferred / revoked), it sets
    // `memoryExcludeScopes: ['project_shared']` on the runner. The
    // view MUST mirror the eager-load section's fail-closed
    // posture — no project_shared bodies surface via
    // retrieve_context, even if they'd otherwise score the highest.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Shared](shared.md) — fortress shared\n');
    writeIndex(roots.projectLocal, '- [Local](local.md) — fortress local\n');
    writeBody(roots.projectShared, 'shared', 'fortress body in shared');
    writeBody(roots.projectLocal, 'local', 'fortress body in local');
    const registry = createMemoryRegistry({ roots, db, sessionId });

    const baseline = await createMemoryView({ registry }).search({
      ...baseQuery,
      text: 'fortress',
    });
    expect(baseline.map((c) => c.nodeId).sort()).toEqual([
      'memory:project_local/local',
      'memory:project_shared/shared',
    ]);

    const offline = await createMemoryView({
      registry,
      excludeScopes: ['project_shared'],
    }).search({ ...baseQuery, text: 'fortress' });
    expect(offline.map((c) => c.nodeId)).toEqual(['memory:project_local/local']);
  });

  test('empty excludeScopes is a no-op (no behavior change)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [S](s.md) — fortress\n');
    writeBody(roots.projectShared, 's', 'fortress body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const cands = await createMemoryView({ registry, excludeScopes: [] }).search({
      ...baseQuery,
      text: 'fortress',
    });
    expect(cands.map((c) => c.nodeId)).toEqual(['memory:project_shared/s']);
  });

  test('excludeScopes preserves precedence fallback when shadowed name lives in excluded scope', async () => {
    // Review regression: pre-fix the view asked the registry for
    // `deduplicateByName: true` and then filtered `excludeScopes`
    // in JS afterward. Order broke the precedence-fallback contract.
    //
    // Setup: TWO memories named `foo`, one under project_shared and
    // one under user. Scope precedence is local > shared > user
    // (registry.ts SCOPE_ORDER), so without filtering, dedup picks
    // project_shared/foo and drops user/foo. With `excludeScopes:
    // ['project_shared']` the dedup-then-filter ordering would
    // drop project_shared/foo AFTER it suppressed user/foo, leaving
    // NO `foo` candidate at all — silently hiding a trusted body
    // the model should still see.
    //
    // Post-fix the registry filters excludeScopes BEFORE dedup, so
    // project_shared/foo is removed first, dedup operates only over
    // permitted scopes, and user/foo surfaces as expected.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectShared, '- [Foo](foo.md) — castle from shared\n');
    writeIndex(roots.user, '- [Foo](foo.md) — castle from user\n');
    writeBody(roots.projectShared, 'foo', 'castle body in shared scope');
    writeBody(roots.user, 'foo', 'castle body in user scope');
    const registry = createMemoryRegistry({ roots, db, sessionId });

    // Baseline (no exclusion): project_shared/foo wins precedence,
    // user/foo is shadowed out by dedup. Pins the pre-condition the
    // bug depended on: dedup IS hiding user/foo absent any filter.
    const baseline = await createMemoryView({ registry }).search({
      ...baseQuery,
      text: 'castle',
    });
    expect(baseline.map((c) => c.nodeId)).toEqual(['memory:project_shared/foo']);

    // With project_shared excluded: user/foo MUST surface. Pre-fix
    // this returned [] (the post-dedup filter wiped the only entry).
    const offline = await createMemoryView({
      registry,
      excludeScopes: ['project_shared'],
    }).search({ ...baseQuery, text: 'castle' });
    expect(offline.map((c) => c.nodeId)).toEqual(['memory:user/foo']);
  });

  test('excludeScopes precedence fallback also covers project_local shadow → project_shared survival', async () => {
    // Symmetric regression: project_local > project_shared. Exclude
    // project_local; the project_shared sibling should fall through
    // dedup. Covers the other direction of the precedence ladder
    // (the production case the bug report opened was shared→user,
    // but the registry rule is local→shared→user and a future
    // exclude policy could fail-close project_local too).
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.projectLocal, '- [Bar](bar.md) — moat from local\n');
    writeIndex(roots.projectShared, '- [Bar](bar.md) — moat from shared\n');
    writeBody(roots.projectLocal, 'bar', 'moat body in local scope');
    writeBody(roots.projectShared, 'bar', 'moat body in shared scope');
    const registry = createMemoryRegistry({ roots, db, sessionId });

    const baseline = await createMemoryView({ registry }).search({
      ...baseQuery,
      text: 'moat',
    });
    expect(baseline.map((c) => c.nodeId)).toEqual(['memory:project_local/bar']);

    const offline = await createMemoryView({
      registry,
      excludeScopes: ['project_local'],
    }).search({ ...baseQuery, text: 'moat' });
    expect(offline.map((c) => c.nodeId)).toEqual(['memory:project_shared/bar']);
  });
});

describe('createMemoryView — trustedOnly (§4.4 I3)', () => {
  test('folds triggers: tags into the corpus on the proactive path (§4.4 P3)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Deploy](deploy-mem.md) — release steps\n');
    // neither name/description/body says "kubernetes" — only the trigger tag.
    writeBody(roots.user, 'deploy-mem', 'shipping notes', {
      description: 'release steps',
      triggers: ['kubernetes'],
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    // proactive path: the tag is in the corpus → the query matches.
    const safe = await createMemoryView({ registry, trustedOnly: true }).search({
      ...baseQuery,
      text: 'kubernetes',
    });
    expect(safe.map((c) => c.nodeId)).toContain('memory:user/deploy-mem');
    // model-driven path: tags are NOT indexed → no match (corpus unchanged).
    const open = await createMemoryView({ registry }).search({ ...baseQuery, text: 'kubernetes' });
    expect(open.map((c) => c.nodeId)).not.toContain('memory:user/deploy-mem');
  });

  test('excludes quarantined memories (I3 active-only)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Act](act-auth.md) — auth\n- [Quar](quar-auth.md) — auth\n');
    writeBody(roots.user, 'act-auth', 'body', { description: 'auth notes' });
    writeBody(roots.user, 'quar-auth', 'body', { description: 'auth notes', state: 'quarantined' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const safe = await createMemoryView({ registry, trustedOnly: true }).search({
      ...baseQuery,
      text: 'auth',
    });
    expect(safe.map((c) => c.nodeId)).toContain('memory:user/act-auth');
    expect(safe.map((c) => c.nodeId)).not.toContain('memory:user/quar-auth');
    // Without trustedOnly the model-driven path still sees quarantined.
    const open = await createMemoryView({ registry }).search({ ...baseQuery, text: 'auth' });
    expect(open.map((c) => c.nodeId)).toContain('memory:user/quar-auth');
  });

  test('trusted lower-precedence sibling survives an untrusted shadow (trust before dedupe)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // project_local/foo (higher precedence) is untrusted; user/foo (lower) is
    // trusted. Deduping before the trust filter keeps only the untrusted shadow,
    // drops it, and loses the trusted fallback. The proactive view must surface
    // user/foo — mirrors assembleMemorySection's trust-before-dedupe order.
    writeIndex(roots.projectLocal, '- [Foo](foo.md) — auth helper\n');
    writeBody(roots.projectLocal, 'foo', 'untrusted shadow', {
      description: 'auth helper',
      trust: 'untrusted',
    });
    writeIndex(roots.user, '- [Foo](foo.md) — auth helper\n');
    writeBody(roots.user, 'foo', 'trusted fallback', { description: 'auth helper' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const out = await createMemoryView({ registry, trustedOnly: true }).search({
      ...baseQuery,
      text: 'auth helper',
    });
    expect(out.map((c) => c.nodeId)).toContain('memory:user/foo');
    expect(out.map((c) => c.nodeId)).not.toContain('memory:project_local/foo');
  });

  test('drops untrusted memories, keeps trusted', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(
      roots.user,
      '- [Trusted](trusted-auth.md) — auth\n- [Untrusted](untrusted-auth.md) — auth\n',
    );
    writeBody(roots.user, 'trusted-auth', 'body', { description: 'auth notes', trust: 'trusted' });
    writeBody(roots.user, 'untrusted-auth', 'body', {
      description: 'auth notes',
      trust: 'untrusted',
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, trustedOnly: true });
    const ids = (await view.search({ ...baseQuery, text: 'auth' })).map((c) => c.nodeId);
    expect(ids).toContain('memory:user/trusted-auth');
    expect(ids).not.toContain('memory:user/untrusted-auth');
  });

  test('keeps memories with trust absent (default trusted)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Plain](plain-auth.md) — auth\n');
    writeBody(roots.user, 'plain-auth', 'body', { description: 'auth notes' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, trustedOnly: true });
    const ids = (await view.search({ ...baseQuery, text: 'auth' })).map((c) => c.nodeId);
    expect(ids).toContain('memory:user/plain-auth');
  });

  test('without trustedOnly, untrusted still surfaces (the parked retrieve_context gap)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Untrusted](untrusted-auth.md) — auth\n');
    writeBody(roots.user, 'untrusted-auth', 'body', {
      description: 'auth notes',
      trust: 'untrusted',
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry });
    const ids = (await view.search({ ...baseQuery, text: 'auth' })).map((c) => c.nodeId);
    expect(ids).toContain('memory:user/untrusted-auth');
  });

  test('trustedOnly + loadBodies: untrusted body tokens never enter the corpus', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // 'kerberos' lives only in the untrusted body — a body-only match.
    writeIndex(roots.user, '- [U](untrusted-x.md) — unrelated\n');
    writeBody(roots.user, 'untrusted-x', 'kerberos ticket', {
      description: 'unrelated',
      trust: 'untrusted',
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const view = createMemoryView({ registry, trustedOnly: true, loadBodies: true });
    const cands = await view.search({ ...baseQuery, text: 'kerberos' });
    expect(cands).toEqual([]);
  });
});
