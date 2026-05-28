// FIFO bounded cache — pins the eviction shape so a regression that
// drops the cap or switches the policy (e.g. accidentally promoting
// an in-place update to LRU semantics) surfaces here instead of
// silently degrading memory behavior in production.
import { describe, expect, test } from 'bun:test';
import { createBoundedCache } from '../../src/permissions/bounded-cache.ts';

describe('createBoundedCache', () => {
  test('stores + retrieves values up to the cap', () => {
    const c = createBoundedCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.size()).toBe(3);
  });

  test('evicts oldest entry (FIFO) when cap is exceeded', () => {
    const c = createBoundedCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // evicts 'a'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
    expect(c.size()).toBe(3);
  });

  test('in-place update does NOT promote the key (FIFO, not LRU)', () => {
    // Setting an existing key to a new value MUST keep the original
    // insertion order. A regression to LRU semantics would move the
    // updated key to the tail and shift eviction onto a different
    // candidate — surface that here.
    const c = createBoundedCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('a', 99); // overwrite — 'a' stays oldest, NOT promoted
    c.set('d', 4); // evicts 'a' (oldest), not 'b'
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('d')).toBe(4);
  });

  test('cap of 1 acts as a single-slot cache', () => {
    const c = createBoundedCache<string, number>(1);
    c.set('a', 1);
    expect(c.size()).toBe(1);
    c.set('b', 2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.size()).toBe(1);
  });

  test('throws on cap <= 0', () => {
    expect(() => createBoundedCache<string, number>(0)).toThrow();
    expect(() => createBoundedCache<string, number>(-1)).toThrow();
  });

  test('clear() empties the cache', () => {
    const c = createBoundedCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});
