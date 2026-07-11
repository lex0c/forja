// BM25 ranking utility tests (RETRIEVAL.md §3.2 + §5.1).

import { describe, expect, test } from 'bun:test';
import { type BM25Document, createBM25Index, tokenize } from '../../src/retrieval/bm25.ts';

const docOf = (id: string, text: string): BM25Document => ({ id, tokens: tokenize(text) });

describe('tokenize', () => {
  test('lowercase split on non-alphanumeric', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
    expect(tokenize('validateToken(arg)')).toEqual(['validatetoken', 'arg']);
    expect(tokenize('snake_case AND camelCase')).toEqual(['snake', 'case', 'and', 'camelcase']);
  });

  test('empty / whitespace / punctuation-only', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!!---???')).toEqual([]);
  });

  test('mixed alphanumeric tokens', () => {
    expect(tokenize('node-22.11.0 and bun 1.3')).toEqual([
      'node',
      '22',
      '11',
      '0',
      'and',
      'bun',
      '1',
      '3',
    ]);
  });
});

describe('createBM25Index — score + topK', () => {
  test('empty corpus returns no hits', () => {
    const idx = createBM25Index([]);
    expect(idx.score('foo', 'anything')).toBe(0);
    expect(idx.topK('foo', 10)).toEqual([]);
  });

  test('empty query returns no hits', () => {
    const idx = createBM25Index([docOf('d1', 'hello world')]);
    expect(idx.topK('', 10)).toEqual([]);
  });

  test('exact match scores positive', () => {
    const idx = createBM25Index([
      docOf('d1', 'auth service implementation'),
      docOf('d2', 'database migration plan'),
    ]);
    const hits = idx.topK('auth', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('d1');
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  test('rare term outranks common term (IDF)', () => {
    // "the" appears in many docs (low IDF); "ripgrep" in one (high IDF).
    const idx = createBM25Index([
      docOf('d1', 'the cat sat on the mat'),
      docOf('d2', 'the dog ate the bone'),
      docOf('d3', 'the bird flew over the ripgrep manual'),
    ]);
    const ripgrepHit = idx.topK('ripgrep', 10)[0];
    const theHit = idx.topK('the', 10)[0];
    if (!ripgrepHit || !theHit) throw new Error('both hits expected');
    expect(ripgrepHit.score).toBeGreaterThan(theHit.score);
  });

  test('multi-term query sums per-term contributions', () => {
    const idx = createBM25Index([
      docOf('d1', 'authentication service handles tokens'),
      docOf('d2', 'authentication helpers'),
      docOf('d3', 'unrelated content'),
    ]);
    const hits = idx.topK('authentication tokens', 10);
    expect(hits[0]?.id).toBe('d1'); // matches both terms
    expect(hits.find((h) => h.id === 'd2')?.score).toBeGreaterThan(0);
    expect(hits.find((h) => h.id === 'd3')).toBeUndefined();
  });

  test('field weighting via token repetition (caller responsibility)', () => {
    // Doc that repeats the term 3x (as a title-weighted memory view
    // would) scores higher than one with a single hit, all else equal.
    const idx = createBM25Index([
      { id: 'with-title', tokens: tokenize('auth auth auth misc') },
      { id: 'no-title', tokens: tokenize('auth misc misc misc') },
    ]);
    const hits = idx.topK('auth', 10);
    expect(hits[0]?.id).toBe('with-title');
  });

  test('length normalization prefers concise docs for the same hit count', () => {
    const idx = createBM25Index([
      docOf('short', 'auth'),
      docOf('long', `auth ${'pad '.repeat(50)}`),
    ]);
    const hits = idx.topK('auth', 10);
    expect(hits[0]?.id).toBe('short');
  });

  test('topK respects limit', () => {
    const idx = createBM25Index([docOf('d1', 'auth'), docOf('d2', 'auth'), docOf('d3', 'auth')]);
    expect(idx.topK('auth', 2)).toHaveLength(2);
    expect(idx.topK('auth', 10)).toHaveLength(3);
  });

  test('topK ties are broken deterministically by id ascending', () => {
    // Two docs with identical content tie on score; id order
    // ensures trace replays are stable.
    const idx = createBM25Index([
      docOf('zebra', 'auth'),
      docOf('alpha', 'auth'),
      docOf('mike', 'auth'),
    ]);
    const hits = idx.topK('auth', 10);
    expect(hits.map((h) => h.id)).toEqual(['alpha', 'mike', 'zebra']);
  });

  test('unknown docId returns 0', () => {
    const idx = createBM25Index([docOf('d1', 'auth')]);
    expect(idx.score('auth', 'never-indexed')).toBe(0);
  });

  test('scoreTokens accepts pre-tokenized query', () => {
    const idx = createBM25Index([docOf('d1', 'auth service')]);
    expect(idx.scoreTokens(['auth'], 'd1')).toBeGreaterThan(0);
    expect(idx.scoreTokens([], 'd1')).toBe(0);
  });
});
