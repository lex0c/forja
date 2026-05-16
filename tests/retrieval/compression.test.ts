// Compression tests (RETRIEVAL.md §6, slice 4.7).
//
// Two layers exercised here: (1) the per-view resolver — given a
// candidate + level, produces { content, costTokens } drawn from
// the underlying substrate (registry or DB); (2) the greedy
// allocator — given ranked candidates + budget, places each at
// the cheapest level that fits and tracks the skipped trail.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import { compressGreedy, createCompressionResolver } from '../../src/retrieval/compression.ts';
import type { RankedCandidate, RetrievalQuery } from '../../src/retrieval/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import { appendFailureEvent } from '../../src/storage/repos/failure-events.ts';
import { appendMessage } from '../../src/storage/repos/messages.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';
import { createToolCall, finishToolCall } from '../../src/storage/repos/tool-calls.ts';

const tmpDirs: string[] = [];

const makeTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forja-retrieval-compress-'));
  tmpDirs.push(dir);
  return dir;
};

const makeRoots = (repo: string): ScopeRoots => ({
  user: join(repo, 'user'),
  projectShared: join(repo, 'shared'),
  projectLocal: join(repo, 'local'),
});

const writeBody = (dir: string, name: string, body: string, fmExtras: string[] = []): void => {
  mkdirSync(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: description for ${name}`,
    'type: feedback',
    'source: inferred',
    ...fmExtras,
  ];
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
  workflow: 'default',
  queryType: 'semantic',
  budgetTokens: 1000,
};

const makeRanked = (overrides: Partial<RankedCandidate> = {}): RankedCandidate => ({
  nodeId: 'memory:user/sample',
  view: 'memory',
  reason: 'BM25 match',
  path: ['memory:user/sample'],
  finalScore: 0.5,
  signals: {
    structural: 0,
    lexical: 0,
    semantic: 0,
    temporal: 0,
    usage: 0,
    goalAlignment: 0,
  },
  ...overrides,
});

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

describe('createCompressionResolver — memory view', () => {
  test('resolves full / outline / summary / ref for an existing memory', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'line1\nline2\nline3\nline4\nline5\nline6');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({ nodeId: 'memory:user/auth' });

    const full = resolver.resolve(c, 'full');
    expect(full).not.toBeNull();
    expect(full?.content).toContain('line1');
    expect(full?.content).toContain('line6');
    expect(full?.costTokens).toBeGreaterThan(0);

    const outline = resolver.resolve(c, 'outline');
    expect(outline).not.toBeNull();
    expect(outline?.content).toContain('line1');
    expect(outline?.content).toContain('line5');
    expect(outline?.content).not.toContain('line6'); // outline = first 5 lines

    const summary = resolver.resolve(c, 'summary');
    expect(summary?.content).toBe('description for auth');

    const ref = resolver.resolve(c, 'ref');
    expect(ref?.content).toBe('memory:user/auth');
  });

  test('returns null when memory does not exist', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({ nodeId: 'memory:user/missing' });

    expect(resolver.resolve(c, 'full')).toBeNull();
    expect(resolver.resolve(c, 'outline')).toBeNull();
    expect(resolver.resolve(c, 'summary')).toBeNull();
    // `ref` works without registry hit — pure id projection.
    expect(resolver.resolve(c, 'ref')?.content).toBe('memory:user/missing');
  });

  test('costs increase from ref → summary → outline → full (cheapest first)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Big](big.md) — h\n');
    writeBody(roots.user, 'big', 'big body '.repeat(200));
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({ nodeId: 'memory:user/big' });

    const ref = resolver.resolve(c, 'ref');
    const summary = resolver.resolve(c, 'summary');
    const outline = resolver.resolve(c, 'outline');
    const full = resolver.resolve(c, 'full');
    if (!ref || !summary || !outline || !full) throw new Error('all expected');
    expect(ref.costTokens).toBeLessThanOrEqual(summary.costTokens);
    expect(outline.costTokens).toBeLessThanOrEqual(full.costTokens);
  });

  test('malformed nodeId returns null', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    expect(resolver.resolve(makeRanked({ nodeId: 'not-a-memory-id' }), 'full')).toBeNull();
    expect(resolver.resolve(makeRanked({ nodeId: 'memory:no-slash' }), 'full')).toBeNull();
  });

  test('invalid scope in nodeId is refused (defends against corrupt trace replay)', () => {
    // M1 from code review: a memory:<unknown-scope>/<name> must
    // be rejected at parse time, not silently passed to the
    // registry. Defense in depth — the view never emits this,
    // but a corrupt trace replay could.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    expect(
      resolver.resolve(makeRanked({ nodeId: 'memory:made_up_scope/auth' }), 'full'),
    ).toBeNull();
    expect(resolver.resolve(makeRanked({ nodeId: 'memory:made_up_scope/auth' }), 'ref')).toBeNull();
  });

  test('does not emit memory_events action=read for compression probes (fallback or place)', () => {
    // Regression: prior implementation called `registry.read`
    // inside the memory resolver. compressGreedy probes up to
    // four levels per candidate, so even a single placed memory
    // emitted 1–3 synthetic `read` audit rows, and a candidate
    // skipped after probing every level emitted up to 3. The
    // resolver now uses `registry.peek`, so the only audit that
    // should ever land in `memory_events` for a retrieval pass
    // is whatever non-read lifecycle event the registry emits
    // (none, here — we're not creating / evicting anything).
    //
    // Scenario covers both outcomes in one pass:
    //   - placed:  budget large enough that `full` fits.
    //   - skipped: budget = 0 forces fallthrough to ref then skip.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Placed](placed.md) — h\n- [Skipped](skipped.md) — h\n');
    writeBody(roots.user, 'placed', 'body for the candidate that lands at full level');
    writeBody(roots.user, 'skipped', 'body for the candidate that gets skipped');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });

    const ranked: RankedCandidate[] = [
      makeRanked({ nodeId: 'memory:user/placed', finalScore: 0.9 }),
      makeRanked({ nodeId: 'memory:user/skipped', finalScore: 0.1 }),
    ];
    // First placement gets full; budget then forces skipped to
    // try every level. Set budget tight enough that the second
    // candidate can't fit at ref either.
    compressGreedy({ ranked, query: { ...baseQuery, budgetTokens: 500 }, resolver });
    compressGreedy({ ranked, query: { ...baseQuery, budgetTokens: 0 }, resolver });

    const readRows = db
      .prepare("SELECT COUNT(*) AS n FROM memory_events WHERE action = 'read'")
      .get() as { n: number };
    expect(readRows.n).toBe(0);
  });

  test('estimateTokens override is respected for cost calculation', () => {
    // L4: slice 4.9 will wire provider-specific countTokens via
    // this override. Pin the contract now so a future refactor
    // can't quietly start ignoring the override.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'body');
    const registry = createMemoryRegistry({ roots, db, sessionId });
    // Override: every content costs exactly 42 tokens.
    const fixedEstimator = (): number => 42;
    const resolver = createCompressionResolver({
      registry,
      db,
      estimateTokens: fixedEstimator,
    });
    const ref = resolver.resolve(makeRanked({ nodeId: 'memory:user/auth' }), 'ref');
    const full = resolver.resolve(makeRanked({ nodeId: 'memory:user/auth' }), 'full');
    expect(ref?.costTokens).toBe(42);
    expect(full?.costTokens).toBe(42);
  });
});

describe('createCompressionResolver — session view', () => {
  test('resolves message at every level', () => {
    const msg = appendMessage(db, {
      sessionId,
      role: 'user',
      content: 'first line of the prompt\nsecond line',
    });
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({
      view: 'session',
      nodeId: `session:message:${msg.id}`,
      reason: 'BM25 match in user message',
    });

    const full = resolver.resolve(c, 'full');
    expect(full?.content).toContain('[user]');
    expect(full?.content).toContain('first line');
    expect(full?.content).toContain('second line');

    const outline = resolver.resolve(c, 'outline');
    expect(outline?.content).toContain('[user]');

    const summary = resolver.resolve(c, 'summary');
    expect(summary?.content).toContain('[user]');
    expect(summary?.content).toContain('first line');

    const ref = resolver.resolve(c, 'ref');
    expect(ref?.content).toBe(`session:message:${msg.id}`);
  });

  test('resolves tool_call with input + output at full', () => {
    const msg = appendMessage(db, {
      sessionId,
      role: 'assistant',
      content: [{ type: 'tool_use', input: { command: 'grep foo' } }],
    });
    const tc = createToolCall(db, {
      messageId: msg.id,
      toolName: 'bash',
      input: { command: 'grep foo' },
    });
    finishToolCall(db, {
      id: tc.id,
      status: 'done',
      output: { stdout: 'matched line' },
      durationMs: 5,
    });
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({
      view: 'session',
      nodeId: `session:tool_call:${tc.id}`,
      reason: 'BM25 match in tool_call(bash)',
    });

    const full = resolver.resolve(c, 'full');
    expect(full?.content).toContain('tool=bash');
    expect(full?.content).toContain('grep foo');
    expect(full?.content).toContain('matched line');

    const outline = resolver.resolve(c, 'outline');
    expect(outline?.content).toContain('tool=bash');
    expect(outline?.content).toContain('status=done');

    const summary = resolver.resolve(c, 'summary');
    expect(summary?.content).toContain('bash(');
  });

  test('resolves failure_event', () => {
    const failureId = crypto.randomUUID();
    appendFailureEvent(db, {
      id: failureId,
      session_id: sessionId,
      step_id: null,
      code: 'auth.token_expired',
      classe: 'tool',
      recovery_action: 'reauth',
      user_visible: 0,
      payload_json: JSON.stringify({ detail: 'expired at boundary' }),
      created_at: Date.now(),
      prev_chain_hash: '0'.repeat(64),
      this_chain_hash: '1'.repeat(64),
    });
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({
      view: 'session',
      nodeId: `session:failure:${failureId}`,
    });

    const full = resolver.resolve(c, 'full');
    expect(full?.content).toContain('failure=auth.token_expired');
    expect(full?.content).toContain('expired at boundary');

    const summary = resolver.resolve(c, 'summary');
    expect(summary?.content).toBe('tool/auth.token_expired');
  });

  test('returns null for missing rows (deleted between rank and compress)', () => {
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({
      view: 'session',
      nodeId: 'session:message:nonexistent-id',
    });
    expect(resolver.resolve(c, 'full')).toBeNull();
    expect(resolver.resolve(c, 'outline')).toBeNull();
    expect(resolver.resolve(c, 'summary')).toBeNull();
    // ref always works — pure id projection.
    expect(resolver.resolve(c, 'ref')?.content).toBe('session:message:nonexistent-id');
  });
});

describe('createCompressionResolver — workspace deferred', () => {
  test('workspace view returns null at every level (slice 4.4)', () => {
    const repo = makeTmp();
    const registry = createMemoryRegistry({ roots: makeRoots(repo), db, sessionId });
    const resolver = createCompressionResolver({ registry, db });
    const c = makeRanked({
      view: 'workspace',
      nodeId: 'workspace:file:src/auth.ts',
    });
    for (const level of ['full', 'outline', 'summary', 'ref'] as const) {
      expect(resolver.resolve(c, level)).toBeNull();
    }
  });
});

describe('compressGreedy — budget allocation', () => {
  // Fixed-cost resolver so tests can drive budget scenarios
  // without going through file I/O. Returns the same fake content
  // at predictable costs per level.
  const fixedResolver = (costs: Record<string, number>) => ({
    resolve(candidate: RankedCandidate, level: string) {
      const cost = costs[level];
      if (cost === undefined) return null;
      return { content: `${candidate.nodeId}#${level}`, costTokens: cost };
    },
  });

  test('top-K gets full, tail degrades down the hierarchy', () => {
    const resolver = fixedResolver({ full: 50, outline: 20, summary: 5, ref: 1 });
    const ranked: RankedCandidate[] = [
      makeRanked({ nodeId: 'a', finalScore: 0.9 }),
      makeRanked({ nodeId: 'b', finalScore: 0.7 }),
      makeRanked({ nodeId: 'c', finalScore: 0.5 }),
    ];
    // Budget = 80. a@full(50) → remaining=30; b@full(50) > 30 →
    // b@outline(20) → remaining=10; c@full(50) > 10 → c@outline(20)
    // > 10 → c@summary(5) → remaining=5.
    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 80 },
      resolver,
    });
    expect(slot.included.map((e) => `${e.nodeId}@${e.level}`)).toEqual([
      'a@full',
      'b@outline',
      'c@summary',
    ]);
    expect(slot.skipped).toEqual([]);
  });

  test('skipped trail carries wouldCostTokens for the cheapest level that did not fit', () => {
    const resolver = fixedResolver({ full: 50, outline: 20, summary: 10, ref: 5 });
    const ranked: RankedCandidate[] = [makeRanked({ nodeId: 'a' }), makeRanked({ nodeId: 'b' })];
    // Budget = 51. a@full(50). b: full=50>1, outline=20>1, summary=10>1, ref=5>1 → skipped.
    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 51 },
      resolver,
    });
    expect(slot.included).toHaveLength(1);
    expect(slot.included[0]?.nodeId).toBe('a');
    expect(slot.skipped).toHaveLength(1);
    expect(slot.skipped[0]?.nodeId).toBe('b');
    expect(slot.skipped[0]?.wouldCostTokens).toBe(5); // cheapest (ref)
    expect(slot.skipped[0]?.reason).toContain('ref');
  });

  test('candidate with no resolver content gets skipped with null wouldCost', () => {
    const resolver = {
      resolve: () => null,
    };
    const ranked: RankedCandidate[] = [makeRanked({ nodeId: 'orphan' })];
    const slot = compressGreedy({ ranked, query: baseQuery, resolver });
    expect(slot.included).toEqual([]);
    expect(slot.skipped).toHaveLength(1);
    expect(slot.skipped[0]?.nodeId).toBe('orphan');
    expect(slot.skipped[0]?.wouldCostTokens).toBeNull();
    expect(slot.skipped[0]?.reason).toContain('no resolver');
  });

  test('exact-fit budget consumes everything to zero', () => {
    const resolver = fixedResolver({ full: 10, outline: 5, summary: 2, ref: 1 });
    const ranked: RankedCandidate[] = [
      makeRanked({ nodeId: 'a' }),
      makeRanked({ nodeId: 'b' }),
      makeRanked({ nodeId: 'c' }),
    ];
    // Budget = 30; 3 × full(10) = 30 exactly.
    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 30 },
      resolver,
    });
    expect(slot.included).toHaveLength(3);
    for (const e of slot.included) {
      expect(e.level).toBe('full');
    }
    expect(slot.skipped).toEqual([]);
  });

  test('zero budget: every candidate skipped', () => {
    const resolver = fixedResolver({ full: 5, outline: 4, summary: 2, ref: 1 });
    const ranked: RankedCandidate[] = [makeRanked({ nodeId: 'a' })];
    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 0 },
      resolver,
    });
    expect(slot.included).toEqual([]);
    expect(slot.skipped).toHaveLength(1);
  });

  test('rejects costTokens=NaN / Infinity / negative — treats level as unresolvable, falls through', () => {
    // H4: slice 4.9 will inject provider-specific token counters
    // via the estimateTokens hook. A buggy counter returning
    // NaN/Infinity/-1 must not corrupt the greedy comparison —
    // NaN <= remaining is false (silent skip), placed Infinity
    // would underflow `remaining`, negative would deflate budget.
    // The compress loop must treat the level as not-resolvable
    // (same shape as null) and fall through to the next.
    const badAtFull = {
      resolve(candidate: RankedCandidate, level: string) {
        if (level === 'full') return { content: 'x', costTokens: Number.NaN };
        if (level === 'outline') return { content: 'x', costTokens: Number.POSITIVE_INFINITY };
        if (level === 'summary') return { content: 'x', costTokens: -5 };
        // Only ref returns a valid cost — that's where this
        // candidate must land.
        return { content: candidate.nodeId, costTokens: 1 };
      },
    };
    const ranked: RankedCandidate[] = [makeRanked({ nodeId: 'a' })];
    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 10 },
      resolver: badAtFull,
    });
    expect(slot.included).toHaveLength(1);
    expect(slot.included[0]?.level).toBe('ref');
    expect(slot.included[0]?.costTokens).toBe(1);
    expect(slot.skipped).toEqual([]);
  });

  test('all-levels invalid → candidate skipped (no malformed cost reaches the slot)', () => {
    const allBad = {
      resolve(_c: RankedCandidate, _l: string) {
        return { content: 'x', costTokens: Number.NaN };
      },
    };
    const ranked: RankedCandidate[] = [makeRanked({ nodeId: 'a' })];
    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 1000 },
      resolver: allBad,
    });
    expect(slot.included).toEqual([]);
    expect(slot.skipped).toHaveLength(1);
    // No level produced a valid cost, so cheapestUnfit stays null —
    // skipped trail reports 'no resolver produced content' (or
    // equivalent), and wouldCostTokens is null.
    expect(slot.skipped[0]?.wouldCostTokens).toBeNull();
  });
});

describe('compressGreedy — end-to-end with createCompressionResolver', () => {
  test('full pipeline against memory + session corpora', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — h\n');
    writeBody(roots.user, 'auth', 'small body about authentication patterns');
    const msg = appendMessage(db, {
      sessionId,
      role: 'user',
      content: 'how does auth work in this project?',
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const resolver = createCompressionResolver({ registry, db });

    const ranked: RankedCandidate[] = [
      makeRanked({
        view: 'memory',
        nodeId: 'memory:user/auth',
        finalScore: 0.9,
      }),
      makeRanked({
        view: 'session',
        nodeId: `session:message:${msg.id}`,
        finalScore: 0.6,
      }),
    ];

    const slot = compressGreedy({
      ranked,
      query: { ...baseQuery, budgetTokens: 500 },
      resolver,
    });

    expect(slot.included).toHaveLength(2);
    // Tracks rank order: memory first (higher final score).
    expect(slot.included[0]?.nodeId).toBe('memory:user/auth');
    expect(slot.included[1]?.nodeId).toBe(`session:message:${msg.id}`);
    // Both got the richest content their budget allowed; verify
    // the actual substrate landed in the slot.
    expect(slot.included[0]?.content).toContain('authentication patterns');
    expect(slot.included[1]?.content).toContain('how does auth work');
  });
});
