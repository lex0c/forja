import { describe, expect, test } from 'bun:test';
import {
  canonicalizeObject,
  sortKeysDeep,
  stableStringify,
} from '../../src/providers/canonical-json.ts';

describe('stableStringify', () => {
  test('same key/value set → same bytes regardless of insertion order', () => {
    const a = stableStringify({ b: 1, a: 2, c: 3 });
    const b = stableStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  test('sorts nested object keys too', () => {
    const a = stableStringify({ outer: { y: 1, x: 2 } });
    const b = stableStringify({ outer: { x: 2, y: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"x":2,"y":1}}');
  });

  test('preserves ARRAY element order (only object keys are sorted)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    // objects inside arrays still get their keys sorted
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test('passes through primitives and null', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });
});

describe('sortKeysDeep', () => {
  test('returns a value-equal structure (deep equality holds)', () => {
    const input = { z: [{ b: 1, a: 2 }], a: { d: 4, c: 3 } };
    expect(sortKeysDeep(input)).toEqual(input);
  });
});

describe('canonicalizeObject', () => {
  test('keeps the object type and sorts keys deeply', () => {
    const out = canonicalizeObject({ path: '/x', flags: { w: true, r: false } });
    expect(JSON.stringify(out)).toBe('{"flags":{"r":false,"w":true},"path":"/x"}');
    // deep-equal to the original (only byte order differs)
    expect(out).toEqual({ path: '/x', flags: { w: true, r: false } });
  });

  test('two key-orderings of the same tool args serialize identically', () => {
    const a = canonicalizeObject({ pattern: 'foo', path: 'src', ignore_case: true });
    const b = canonicalizeObject({ ignore_case: true, path: 'src', pattern: 'foo' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
