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
  resolveCachedRecall,
} from '../../src/harness/proactive-memory-inject.ts';
import type { ScopeRoots } from '../../src/memory/paths.ts';
import type { RecalledMemory } from '../../src/memory/proactive-recall.ts';
import { createMemoryRegistry } from '../../src/memory/registry.ts';
import type { ProviderMessage } from '../../src/providers/types.ts';
import { type DB, openMemoryDb } from '../../src/storage/db.ts';
import { migrate } from '../../src/storage/migrate.ts';
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
    expect(out.map((r) => r.nodeId)).toEqual(['memory:user/focusA']);
    expect(cache.get('s1')?.focusKey).toBe('focusA');
  });

  test('same focus reuses the cache (no recompute)', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    const out = await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    expect(calls()).toBe(1); // reused, not recomputed
    expect(out.map((r) => r.nodeId)).toEqual(['memory:user/focusA']);
  });

  test('focus change recomputes and updates the cache', async () => {
    const cache = new Map<string, ProactiveRecallCacheEntry>();
    const { recall, calls } = mk();
    await resolveCachedRecall(cache, 's1', 'focusA', recall, 'p');
    const out = await resolveCachedRecall(cache, 's1', 'focusB', recall, 'p');
    expect(calls()).toBe(2);
    expect(out.map((r) => r.nodeId)).toEqual(['memory:user/focusB']);
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
