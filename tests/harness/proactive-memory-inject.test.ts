// Proactive memory injection tests (MEMORY.md §4.4 P2).
// Renderer (I1/I2 via the bottom-of-turn append) + the createProactiveRecall
// wiring (the §4.4 I3 view + body loader) end-to-end over a registry fixture.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProactiveRecallCacheEntry,
  createProactiveRecall,
  formatProactiveRecallBlock,
  injectProactiveMemoryBlock,
  recordProactiveExposures,
  resolveCachedRecall,
} from '../../src/harness/proactive-memory-inject.ts';
import { serializeMemoryFile } from '../../src/memory/index.ts';
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

  test('no-op when the last message is not a user turn', () => {
    const messages: ProviderMessage[] = [{ role: 'assistant', content: 'x' }];
    injectProactiveMemoryBlock(messages, [rec('memory:user/a', 'B')]);
    expect(messages[0]?.content).toBe('x');
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
    expect(cache.get('s1')?.focusKey).toBe('focusA');
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
    expect(cache.get('s1')?.focusKey).toBe('focusB');
  });

  test('sessions cache independently', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    await resolveCachedRecall(cache, 's2', 'focusA', recall, 'p');
    expect(calls()).toBe(2);
  });
});
