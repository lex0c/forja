import { describe, expect, test } from 'bun:test';
import { canonicalHash, canonicalize, sha256Hex } from '../../src/permissions/canonical.ts';

describe('canonicalize — primitives', () => {
  test('null', () => {
    expect(canonicalize(null)).toBe('null');
  });
  test('boolean', () => {
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
  });
  test('finite numbers', () => {
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(1)).toBe('1');
    expect(canonicalize(-1)).toBe('-1');
    expect(canonicalize(1.5)).toBe('1.5');
    expect(canonicalize(1731000000000)).toBe('1731000000000');
  });
  test('negative zero canonicalizes to 0', () => {
    expect(canonicalize(-0)).toBe('0');
    // And it must hash identical to 0
    expect(canonicalize({ x: -0 })).toBe(canonicalize({ x: 0 }));
  });
  test('rejects non-finite numbers', () => {
    expect(() => canonicalize(Number.NaN)).toThrow('non-finite');
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow('non-finite');
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow('non-finite');
  });
  test('rejects undefined', () => {
    expect(() => canonicalize(undefined)).toThrow('undefined');
  });
  test('rejects bigint, symbol, function', () => {
    expect(() => canonicalize(1n)).toThrow('unsupported');
    expect(() => canonicalize(Symbol('x'))).toThrow('unsupported');
    expect(() => canonicalize(() => 0)).toThrow('unsupported');
  });
});

describe('canonicalize — strings', () => {
  test('plain string', () => {
    expect(canonicalize('hello')).toBe('"hello"');
  });
  test('escape sequences match JSON spec', () => {
    expect(canonicalize('a\nb')).toBe('"a\\nb"');
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize('a\\b')).toBe('"a\\\\b"');
    expect(canonicalize('\t\r')).toBe('"\\t\\r"');
  });
  test('control characters are escaped', () => {
    expect(canonicalize('')).toBe('"\\u0001"');
  });
  test('non-ASCII passes through (UTF-16 strings in JSON are valid)', () => {
    // V8 JSON.stringify doesn't escape non-ASCII by default.
    expect(canonicalize('café')).toBe('"café"');
  });
});

describe('canonicalize — arrays', () => {
  test('empty array', () => {
    expect(canonicalize([])).toBe('[]');
  });
  test('order preserved', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });
  test('nested arrays', () => {
    expect(canonicalize([[1, 2], [3]])).toBe('[[1,2],[3]]');
  });
  test('arrays propagate undefined rejection', () => {
    expect(() => canonicalize([1, undefined, 2])).toThrow('undefined');
  });
});

describe('canonicalize — objects', () => {
  test('empty object', () => {
    expect(canonicalize({})).toBe('{}');
  });
  test('keys sorted lexicographically (UTF-16 code unit order)', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  test('digits sort before letters', () => {
    expect(canonicalize({ a: 1, '0': 2 })).toBe('{"0":2,"a":1}');
  });
  test('uppercase sorts before lowercase', () => {
    expect(canonicalize({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });
  test('nested objects also sort their keys', () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });
  test('mixed nested shapes', () => {
    const result = canonicalize({
      tool: 'bash',
      caps: ['exec:shell', 'write-fs:./build'],
      score: 0.62,
      components: { capability_risk: 0.4, shell_chain: 0.22 },
    });
    expect(result).toBe(
      '{"caps":["exec:shell","write-fs:./build"],"components":{"capability_risk":0.4,"shell_chain":0.22},"score":0.62,"tool":"bash"}',
    );
  });
});

describe('canonicalize — chain determinism', () => {
  test('two equivalent objects built differently produce the same encoding', () => {
    const a = { foo: 1, bar: 2 };
    const b: Record<string, unknown> = {};
    b.bar = 2;
    b.foo = 1;
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
  test('absent vs explicit-undefined are distinguished (undefined throws)', () => {
    expect(canonicalize({})).toBe('{}');
    expect(() => canonicalize({ x: undefined })).toThrow();
  });
});

describe('sha256Hex / canonicalHash', () => {
  test('sha256Hex is hex-lowercased and stable', () => {
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
  test('canonicalHash chains canonicalize → sha256', () => {
    const expected = sha256Hex('{"a":1}');
    expect(canonicalHash({ a: 1 })).toBe(expected);
  });
  test('canonicalHash invariant under key reordering', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });
});

// Slice 134 P0-3: pin determinism for special-shape inputs that
// would silently diverge chain hashes if a future canonicalize
// refactor "improved" their encoding. Each test here describes
// a shape that REACHES canonicalize (not filtered upstream by
// safeJsonParse / scrub).
describe('canonicalize — surrogate pair determinism (slice 134 P0-3)', () => {
  test('lone high surrogate is preserved verbatim in canonical output', () => {
    // U+D800 is a lone high surrogate (not paired with U+DC00..U+DFFF).
    // JSON.stringify emits it as the escape "\ud800". The chain
    // hash depends on bit-stable output. A future canonicalize
    // that normalizes lone surrogates to U+FFFD would silently
    // invalidate every chain ever written.
    expect(canonicalize('\uD800')).toBe('"\\ud800"');
  });

  test('lone low surrogate is preserved verbatim', () => {
    expect(canonicalize('\uDFFF')).toBe('"\\udfff"');
  });

  test('paired surrogate (astral) round-trips as JSON.stringify default', () => {
    // U+1F4A9 = surrogate pair U+D83D U+DCA9 — JSON.stringify
    // emits the literal 4-byte UTF-8 (not escapes).
    const astral = '💩';
    expect(canonicalize(astral)).toBe(JSON.stringify(astral));
  });

  test('deterministic: same input → same output across calls', () => {
    const input = '\uD800lone\uDFFFpair💩';
    expect(canonicalize(input)).toBe(canonicalize(input));
  });
});
