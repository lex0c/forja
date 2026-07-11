// Proactive memory injection tests (MEMORY.md §4.4 P2).
// Renderer (I1/I2 via the bottom-of-turn append) + the createProactiveRecall
// wiring (the §4.4 I3 view + body loader) end-to-end over a registry fixture.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProactiveRecall,
  formatProactiveRecallBlock,
  injectProactiveMemoryBlock,
  type ProactiveRecallCacheEntry,
  recordProactiveExposures,
  resolveCachedRecall,
} from '../../src/harness/proactive-memory-inject.ts';
import { parseMemoryFile, serializeMemoryFile } from '../../src/memory/index.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import type { RecalledMemory } from '../../src/memory/proactive-recall.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
import {
  hashMemoryContent,
  listProvenanceByName,
} from '../../src/storage/repos/memory-provenance.ts';
import { createSession } from '../../src/storage/repos/sessions.ts';

const rec = (nodeId: string, body: string): RecalledMemory => ({ nodeId, score: 1, body });

describe('formatProactiveRecallBlock', () => {
  test('empty → undefined', () => {
    expect(formatProactiveRecallBlock([])).toBeUndefined();
  });

  test('renders the header + each memory node id + body, framed as reference', () => {
    const block = formatProactiveRecallBlock([
      rec('memory:user/a', 'alpha body'),
      rec('memory:project_local/b', 'beta body'),
    ]);
    expect(block).toContain('# Recalled for this turn');
    expect(block).toContain('## memory:user/a');
    expect(block).toContain('alpha body');
    expect(block).toContain('## memory:project_local/b');
    expect(block).toContain('beta body');
    // Injection-safety: bodies are framed as reference, not instructions.
    expect(block).toContain('not as instructions');
  });

  test('caps a large body to the block budget (truncates with a memory_read pointer)', () => {
    // The block rides the ephemeral turn tail; maybeCompact can't fold it, so a single
    // huge body must not blow the context window. budget 1000 tokens ≈ 4000 chars.
    const big = `HEAD_MARKER ${'lorem ipsum dolor sit amet '.repeat(300)} TAIL_MARKER`;
    const block = formatProactiveRecallBlock([rec('memory:user/big', big)], 1000) as string;
    expect(block).toBeDefined();
    expect(block).toContain('HEAD_MARKER'); // the prefix survives
    expect(block).not.toContain('TAIL_MARKER'); // the tail is dropped
    expect(block).toContain('truncated to fit the recall budget');
    // The escape hatch uses memory_read's real args (name + scope), NOT the node id —
    // memory_read("memory:user/big") would be an invalid name.
    expect(block).toContain('memory_read name="big" scope="user"');
    expect(block).not.toContain('memory_read memory:');
    // Bounded near the budget — far below the ~8000-char un-truncated body.
    expect(block.length).toBeLessThan(5000);
  });

  test('a body under budget is rendered whole (no truncation marker)', () => {
    const block = formatProactiveRecallBlock([rec('memory:user/a', 'short fact')]) as string;
    expect(block).toContain('short fact');
    expect(block).not.toContain('truncated to fit the recall budget');
  });

  test('a body barely over budget renders whole, not as a LONGER truncated fragment', () => {
    // budget 75 tokens → 300 chars remaining; a ~312-char body would truncate to ~300 +
    // a ~90-char hint (longer than the body itself), so it must be emitted whole instead.
    const body = `TINYOVERFLOW ${'word '.repeat(60)}`.trim();
    const block = formatProactiveRecallBlock([rec('memory:user/x', body)], 75) as string;
    expect(block).toContain(body); // the whole body is present, not a fragment
    expect(block).not.toContain('truncated to fit the recall budget');
  });
});

describe('injectProactiveMemoryBlock', () => {
  test('empty recall → messages untouched', () => {
    const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];
    const before = JSON.stringify(messages);
    injectProactiveMemoryBlock(messages, []);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test('appends to the last user message (string content); leaves others intact', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'the prompt' },
    ];
    injectProactiveMemoryBlock(messages, [rec('memory:user/a', 'BODY')]);
    expect(messages[2]?.content).toContain('the prompt');
    expect(messages[2]?.content).toContain('# Recalled for this turn');
    expect(messages[2]?.content).toContain('BODY');
    // I1-ish: only the last user message changes; nothing else (and there's
    // no system prompt in scope — the renderer can't touch it).
    expect(messages[0]?.content).toBe('first');
    expect(messages[1]?.content).toBe('reply');
  });

  test('replace-not-mutate: the original message instance is untouched (I2)', () => {
    const original = { role: 'user' as const, content: 'p' };
    const messages: ProviderMessage[] = [original];
    injectProactiveMemoryBlock(messages, [rec('memory:user/a', 'B')]);
    expect(original.content).toBe('p');
    expect(messages[0]).not.toBe(original);
  });

  test('no-op when the last message is not a user turn → returns no exposures', () => {
    const messages: ProviderMessage[] = [{ role: 'assistant', content: 'x' }];
    const injected = injectProactiveMemoryBlock(messages, [rec('memory:user/a', 'B')]);
    expect(messages[0]?.content).toBe('x');
    // The append no-op'd → nothing reached the provider → no exposures, so the loop
    // records no phantom surface='proactive' rows.
    expect(injected).toEqual([]);
  });
});

describe('createProactiveRecall (wiring)', () => {
  const tmps: string[] = [];
  const makeTmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'forja-proactive-'));
    tmps.push(d);
    return d;
  };
  const makeRoots = (r: string): ScopeRoots => ({
    user: join(r, 'user'),
    projectShared: join(r, 'shared'),
    projectLocal: join(r, 'local'),
  });
  const writeBody = (
    dir: string,
    name: string,
    body: string,
    fm: { description?: string; state?: string; trust?: string } = {},
  ): void => {
    mkdirSync(dir, { recursive: true });
    const lines = [
      `name: ${name}`,
      `description: ${fm.description ?? `description for ${name}`}`,
      'type: feedback',
      'source: inferred',
    ];
    if (fm.state !== undefined) lines.push(`state: ${fm.state}`);
    if (fm.trust !== undefined) lines.push(`trust: ${fm.trust}`);
    writeFileSync(join(dir, `${name}.md`), `---\n${lines.join('\n')}\n---\n\n${body}\n`);
  };
  const writeIndex = (dir: string, body: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), body);
  };

  let db: DB;
  let sessionId: string;

  beforeEach(() => {
    db = openMemoryDb();
    migrate(db);
    sessionId = createSession(db, { model: 'm', cwd: '/p' }).id;
  });

  afterEach(() => {
    while (tmps.length > 0) {
      const d = tmps.pop();
      if (d !== undefined) rmSync(d, { recursive: true, force: true });
    }
  });

  test('recalls a trusted+active memory with its body; drops untrusted', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth\n- [Secret](secret.md) — auth\n');
    writeBody(roots.user, 'auth', 'use JWT tokens for login', { description: 'auth notes' });
    writeBody(roots.user, 'secret', 'untrusted note', {
      description: 'auth notes',
      trust: 'untrusted',
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    // minScore 0 isolates the wiring (I3 view + loadBody) from the absolute
    // BM25 floor, which proactive-recall.test.ts covers with fake scores.
    const recall = createProactiveRecall({ registry, minScore: 0 });
    const out = await recall({ goalText: 'auth', prompt: 'how do we auth' });
    expect(out.map((r) => r.nodeId)).toContain('memory:user/auth');
    expect(out.map((r) => r.nodeId)).not.toContain('memory:user/secret');
    expect(out.find((r) => r.nodeId === 'memory:user/auth')?.body).toContain('use JWT tokens');
  });

  test('drops quarantined (I3 active-only)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Act](act.md) — auth\n- [Quar](quar.md) — auth\n');
    writeBody(roots.user, 'act', 'active body', { description: 'auth notes' });
    writeBody(roots.user, 'quar', 'quarantined body', {
      description: 'auth notes',
      state: 'quarantined',
    });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const recall = createProactiveRecall({ registry, minScore: 0 });
    const out = await recall({ goalText: 'auth', prompt: 'auth' });
    expect(out.map((r) => r.nodeId)).toContain('memory:user/act');
    expect(out.map((r) => r.nodeId)).not.toContain('memory:user/quar');
  });

  test('loadBody resolves the ranked snapshot, not an unqualified peek (seed shadowed by expired top-level)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // user/foo.md: EXPIRED (expires in the past). The view's list() drops it
    // (includeExpired:false) and ranks the seed below — its body must NEVER
    // surface. An unqualified peek(name,{scope:'user'}) would resolve it.
    mkdirSync(roots.user, { recursive: true });
    writeIndex(roots.user, '- [Foo](foo.md) — auth helper\n');
    writeFileSync(
      join(roots.user, 'foo.md'),
      '---\nname: foo\ndescription: auth helper\ntype: feedback\nsource: inferred\nexpires: 2020-01-01\n---\n\nSTALE auth token body\n',
    );
    // user/seeds/foo.md: ACTIVE seed of the same name — what the view ranks.
    const seedsDir = join(roots.user, 'seeds');
    mkdirSync(seedsDir, { recursive: true });
    writeIndex(seedsDir, '- [Foo](foo.md) — auth helper\n');
    writeFileSync(
      join(seedsDir, 'foo.md'),
      '---\nname: foo\ndescription: auth helper\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "1.0"\n---\n\nFRESH auth token seed body\n',
    );
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const recall = createProactiveRecall({ registry, minScore: 0 });
    const out = await recall({ goalText: 'auth', prompt: 'auth token' });
    const foo = out.find((r) => r.nodeId === 'memory:user/foo');
    expect(foo).toBeDefined();
    // The fix returns the active seed body, not the expired top-level shadow.
    expect(foo?.body).toContain('FRESH');
    expect(foo?.body).not.toContain('STALE');
  });

  test('records provenance for the injected seed, not the expired top-level shadow', async () => {
    // Same shadow scenario, asserting the AUDIT row: its content hash must
    // describe the ranked seed bytes, not the top-level an unqualified peek hits.
    const repo = makeTmp();
    const roots = makeRoots(repo);
    mkdirSync(roots.user, { recursive: true });
    writeIndex(roots.user, '- [Foo](foo.md) — auth helper\n');
    writeFileSync(
      join(roots.user, 'foo.md'),
      '---\nname: foo\ndescription: auth helper\ntype: feedback\nsource: inferred\nexpires: 2020-01-01\n---\n\nSTALE auth token body\n',
    );
    const seedsDir = join(roots.user, 'seeds');
    mkdirSync(seedsDir, { recursive: true });
    writeIndex(seedsDir, '- [Foo](foo.md) — auth helper\n');
    writeFileSync(
      join(seedsDir, 'foo.md'),
      '---\nname: foo\ndescription: auth helper\ntype: feedback\nsource: seed\nseed_origin: vendor\nseed_version: "1.0"\n---\n\nFRESH auth token seed body\n',
    );
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const recall = createProactiveRecall({ registry, minScore: 0 });
    const out = await recall({ goalText: 'auth', prompt: 'auth token' });
    recordProactiveExposures(db, registry, sessionId, out);

    const rows = listProvenanceByName(db, sessionId, 'foo');
    expect(rows).toHaveLength(1);
    // The hash must be the seed's, not the expired top-level shadow's.
    const seed = registry.peek('foo', { scope: 'user', subdir: 'seeds' });
    expect(seed.kind).toBe('present');
    if (seed.kind === 'present') {
      expect(rows[0]?.memoryContentHash).toBe(hashMemoryContent(serializeMemoryFile(seed.file)));
    }
  });

  test('threads excludeScopes when resolving bodies (excluded shadow does not drop the recall)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // project_shared/foo (higher precedence) is in an EXCLUDED scope; user/foo is
    // allowed. The view ranks user/foo, but if the body resolver re-lists WITHOUT
    // the exclusion it keeps the project_shared shadow and can't find the ranked
    // user listing — silently dropping the recall. Resolver must share the same
    // exclusion as the view.
    writeIndex(roots.projectShared, '- [Foo](foo.md) — auth helper\n');
    writeBody(roots.projectShared, 'foo', 'shared shadow body', { description: 'auth helper' });
    writeIndex(roots.user, '- [Foo](foo.md) — auth helper\n');
    writeBody(roots.user, 'foo', 'user fallback body', { description: 'auth helper' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const recall = createProactiveRecall({
      registry,
      excludeScopes: ['project_shared'],
      minScore: 0,
    });
    const out = await recall({ goalText: 'auth', prompt: 'auth helper' });
    const foo = out.find((r) => r.nodeId === 'memory:user/foo');
    expect(foo).toBeDefined();
    expect(foo?.body).toContain('user fallback');
  });

  test('resolves the body for a trusted sibling shadowed by an untrusted higher-precedence memory', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // project_local/foo (higher precedence) is active but UNTRUSTED; user/foo is
    // trusted. The view ranks user/foo (it filters trust before dedupe), so the
    // resolver must too — else the dedupe keeps the untrusted shadow, .find misses
    // the ranked user listing, and the safe memory loads as null (dropped + unaudited).
    writeIndex(roots.projectLocal, '- [Foo](foo.md) — auth helper\n');
    writeBody(roots.projectLocal, 'foo', 'untrusted shadow body', {
      description: 'auth helper',
      trust: 'untrusted',
    });
    writeIndex(roots.user, '- [Foo](foo.md) — auth helper\n');
    writeBody(roots.user, 'foo', 'trusted fallback body', { description: 'auth helper' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const recall = createProactiveRecall({ registry, minScore: 0 });
    const out = await recall({ goalText: 'auth', prompt: 'auth helper' });
    const foo = out.find((r) => r.nodeId === 'memory:user/foo');
    expect(foo).toBeDefined();
    expect(foo?.body).toContain('trusted fallback');
    expect(out.map((r) => r.nodeId)).not.toContain('memory:project_local/foo');
  });

  test('recordProactiveExposures writes a canonical proactive row per loaded memory', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [A](alpha.md) — x\n');
    writeBody(roots.user, 'alpha', 'body a', { description: 'x' });
    writeIndex(roots.projectLocal, '- [B](beta.md) — y\n');
    writeBody(roots.projectLocal, 'beta', 'body b', { description: 'y' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    recordProactiveExposures(db, registry, sessionId, [
      rec('memory:user/alpha', 'body a'),
      rec('memory:project_local/beta', 'body b'),
      rec('memory:user/ghost', 'no file on disk'), // valid id, no file → skipped
      rec('not-a-memory-node', 'malformed id'), // parse fail → skipped
    ]);
    const alpha = listProvenanceByName(db, sessionId, 'alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.surface).toBe('proactive');
    expect(alpha[0]?.toolCallId).toBeNull();
    // canonical hash (frontmatter + body), NOT the bare body and not null —
    // so it cross-compares with eager / retrieve_context rows.
    expect(alpha[0]?.memoryContentHash).not.toBeNull();
    expect(alpha[0]?.memoryContentHash).not.toBe(hashMemoryContent('body a'));
    expect(listProvenanceByName(db, sessionId, 'beta')).toHaveLength(1);
    expect(listProvenanceByName(db, sessionId, 'ghost')).toHaveLength(0);
  });

  test('records provenance only for memories the budget injected (dropped overflow gets no row)', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    // Two recalled memories whose bodies together exceed the block budget: the first
    // fills it (~4000 chars), so the second is DROPPED at render and never reaches the
    // provider. It must NOT get a surface='proactive' row. Mirrors the loop sequence:
    // record exactly what injectProactiveMemoryBlock RETURNS, not the full recall.
    const bigBody = `BIG_FILLS_BUDGET ${'lorem ipsum dolor sit amet '.repeat(300)}`;
    writeIndex(roots.user, '- [Big](big.md) — big\n- [Small](small.md) — small\n');
    writeBody(roots.user, 'big', bigBody, { description: 'big' });
    writeBody(roots.user, 'small', 'small body', { description: 'small' });
    const registry = createMemoryRegistry({ roots, db, sessionId });

    const messages: ProviderMessage[] = [{ role: 'user', content: 'p' }];
    const injected = injectProactiveMemoryBlock(messages, [
      rec('memory:user/big', bigBody),
      rec('memory:user/small', 'small body'),
    ]);
    recordProactiveExposures(db, registry, sessionId, injected);

    // Only big was injected; small was dropped by the cap.
    expect(injected.map((m) => m.nodeId)).toEqual(['memory:user/big']);
    expect(messages[0]?.content).not.toContain('small body');
    // Provenance reflects exactly what reached the provider.
    expect(listProvenanceByName(db, sessionId, 'big')).toHaveLength(1);
    expect(listProvenanceByName(db, sessionId, 'small')).toHaveLength(0);
  });

  test('truncated injection records a null (partial) content hash; a full one keeps the canonical hash', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    const bigBody = `BIG ${'lorem ipsum dolor sit amet '.repeat(300)}`; // > budget → truncated
    writeIndex(roots.user, '- [Big](big.md) — big\n- [Sm](sm.md) — sm\n');
    writeBody(roots.user, 'big', bigBody, { description: 'big' });
    writeBody(roots.user, 'sm', 'small body', { description: 'sm' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    // Separate renders so each is the sole injection (one truncated, one full).
    const m1: ProviderMessage[] = [{ role: 'user', content: 'p' }];
    const big = injectProactiveMemoryBlock(m1, [rec('memory:user/big', bigBody)]);
    recordProactiveExposures(db, registry, sessionId, big);
    const m2: ProviderMessage[] = [{ role: 'user', content: 'p' }];
    const sm = injectProactiveMemoryBlock(m2, [rec('memory:user/sm', 'small body')]);
    recordProactiveExposures(db, registry, sessionId, sm);

    // big was truncated → the model saw a prefix → null (partial) hash, not the full file.
    expect(big[0]?.truncated).toBe(true);
    expect(listProvenanceByName(db, sessionId, 'big')[0]?.memoryContentHash).toBeNull();
    // sm fit whole → canonical hash, cross-comparable with eager/retrieve rows.
    expect(sm[0]?.truncated).toBe(false);
    expect(listProvenanceByName(db, sessionId, 'sm')[0]?.memoryContentHash).not.toBeNull();
  });

  test('carries the resolved file onto each recalled memory (for provenance reuse)', async () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Auth](auth.md) — auth\n');
    writeBody(roots.user, 'auth', 'use JWT bearer tokens', { description: 'auth notes' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    const recall = createProactiveRecall({ registry, minScore: 0 });
    const out = await recall({ goalText: 'auth', prompt: 'auth' });
    const auth = out.find((r) => r.nodeId === 'memory:user/auth');
    expect(auth?.file).toBeDefined();
    expect(auth?.file?.body).toBe(auth?.body); // the SAME bytes loadBody loaded
  });

  test('recordProactiveExposures hashes the CARRIED file, not a re-resolved one', () => {
    const repo = makeTmp();
    const roots = makeRoots(repo);
    writeIndex(roots.user, '- [Foo](foo.md) — foo\n');
    writeBody(roots.user, 'foo', 'DISK body', { description: 'foo' });
    const registry = createMemoryRegistry({ roots, db, sessionId });
    // Carry a file whose body differs from disk; provenance must hash the carried bytes,
    // proving it reused the recall's resolution instead of re-resolving from disk.
    const carried = parseMemoryFile(
      '---\nname: foo\ndescription: foo\ntype: feedback\nsource: inferred\n---\n\nCARRIED body\n',
    );
    recordProactiveExposures(db, registry, sessionId, [
      { nodeId: 'memory:user/foo', file: carried },
    ]);
    const row = listProvenanceByName(db, sessionId, 'foo')[0];
    expect(row?.memoryContentHash).toBe(hashMemoryContent(serializeMemoryFile(carried)));
    const disk = registry.peek('foo', { scope: 'user' });
    if (disk.kind === 'present') {
      expect(row?.memoryContentHash).not.toBe(hashMemoryContent(serializeMemoryFile(disk.file)));
    }
  });
});

describe('resolveCachedRecall (the P3 focus-change gate)', () => {
  const mk = () => {
    let calls = 0;
    const recall = async (input: { goalText: string; prompt: string }) => {
      calls += 1;
      return [rec(`memory:user/${input.goalText || 'none'}`, 'b')];
    };
    return { recall, calls: () => calls };
  };

  test('first turn recomputes and caches', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    const out = await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    expect(calls()).toBe(1);
    expect(out.recomputed).toBe(true);
    expect(out.recalled.map((r) => r.nodeId)).toEqual(['memory:user/focusA']);
    expect(cache.get('s1')?.focusKey).toBe('focusa'); // cache key is normalized (lowercased)
  });

  test('same focus reuses the cache (no recompute)', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    const out = await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    expect(calls()).toBe(1); // reused, not recomputed
    expect(out.recomputed).toBe(false);
    expect(out.recalled.map((r) => r.nodeId)).toEqual(['memory:user/focusA']);
  });

  test('focus change recomputes and updates the cache', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    const out = await resolveCachedRecall(cache, 's1', 'focusB', recall, 'p');
    expect(calls()).toBe(2);
    expect(out.recomputed).toBe(true);
    expect(out.recalled.map((r) => r.nodeId)).toEqual(['memory:user/focusB']);
    expect(cache.get('s1')?.focusKey).toBe('focusb'); // normalized cache key
  });

  test('sessions cache independently', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    await resolveCachedRecall(cache, 's2', 'focusA', recall, 'p');
    expect(calls()).toBe(2);
  });

  test('cosmetic rephrase (case / collapsed whitespace) reuses the cache — no re-record', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    const r1 = await resolveCachedRecall(cache, 's1', 'Implement Auth', recall, 'p');
    expect(r1.recomputed).toBe(true);
    // Same focus, only case + surrounding/inner whitespace differ → same normalized key.
    const r2 = await resolveCachedRecall(cache, 's1', '  implement   auth ', recall, 'p');
    expect(r2.recomputed).toBe(false); // cache hit → no recompute, no duplicate provenance
    expect(calls()).toBe(1);
  });
});
