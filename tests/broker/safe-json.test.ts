import { describe, expect, test } from 'bun:test';
import { safeJsonParse } from '../../src/broker/safe-json.ts';

describe('safeJsonParse — proto-pollution defense (slice 104, R6 #42)', () => {
  test('parses normal JSON identically to JSON.parse', () => {
    const input = '{"a": 1, "b": {"c": 2}, "d": [1, 2, 3]}';
    expect(safeJsonParse(input)).toEqual({ a: 1, b: { c: 2 }, d: [1, 2, 3] });
  });

  test("strips top-level '__proto__' key", () => {
    const parsed = safeJsonParse('{"__proto__": {"isAdmin": true}, "x": 1}') as Record<
      string,
      unknown
    >;
    expect(parsed.x).toBe(1);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false);
    // The parsed object's prototype is unchanged.
    expect((parsed as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  test("strips nested '__proto__' key inside object", () => {
    // The args sub-object is what downstream handlers spread or
    // merge. A nested proto-pollution key would survive a
    // shallow top-level check.
    const parsed = safeJsonParse(
      '{"args": {"__proto__": {"polluted": true}, "real": "value"}}',
    ) as { args: Record<string, unknown> };
    expect(parsed.args.real).toBe('value');
    expect(Object.hasOwn(parsed.args, '__proto__')).toBe(false);
  });

  test("strips 'constructor' key", () => {
    const parsed = safeJsonParse(
      '{"constructor": {"prototype": {"x": "y"}}, "real": "ok"}',
    ) as Record<string, unknown>;
    expect(parsed.real).toBe('ok');
    expect(Object.hasOwn(parsed, 'constructor')).toBe(false);
  });

  test("strips 'prototype' key", () => {
    const parsed = safeJsonParse('{"prototype": {"x": 1}, "real": "ok"}') as Record<
      string,
      unknown
    >;
    expect(parsed.real).toBe('ok');
    expect(Object.hasOwn(parsed, 'prototype')).toBe(false);
  });

  test('strips dangerous keys at every nesting level', () => {
    const parsed = safeJsonParse(
      '{"a": {"b": {"__proto__": {"deep": true}, "real": "value"}}}',
    ) as { a: { b: Record<string, unknown> } };
    expect(parsed.a.b.real).toBe('value');
    expect(Object.hasOwn(parsed.a.b, '__proto__')).toBe(false);
  });

  test('downstream Object.assign does NOT pollute prototype', () => {
    // The exact exploitation shape the defense closes. Pre-slice
    // this test would observe `target.isAdmin === true` after the
    // assign because `parsed` carried an own `__proto__` enumerable
    // property whose value `Object.assign` applied via the
    // proto setter.
    const parsed = safeJsonParse('{"__proto__": {"isAdmin": true}}') as Record<string, unknown>;
    const target: Record<string, unknown> = {};
    Object.assign(target, parsed);
    expect((target as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    // Sanity: a fresh empty object has no isAdmin either.
    expect(({} as Record<string, unknown> as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  test('downstream spread does NOT pollute prototype', () => {
    const parsed = safeJsonParse('{"__proto__": {"injected": "yes"}, "ok": 1}') as Record<
      string,
      unknown
    >;
    const target = { ...parsed };
    expect((target as { injected?: string }).injected).toBeUndefined();
  });

  test('throws same SyntaxError shape as JSON.parse on malformed input', () => {
    expect(() => safeJsonParse('not json')).toThrow(SyntaxError);
    expect(() => safeJsonParse('{unclosed: ')).toThrow(SyntaxError);
  });

  test('arrays containing objects with dangerous keys: keys stripped', () => {
    const parsed = safeJsonParse('[{"__proto__": {"x": 1}, "real": "a"}, {"real": "b"}]') as Array<
      Record<string, unknown>
    >;
    expect(parsed[0]?.real).toBe('a');
    expect(parsed[1]?.real).toBe('b');
    expect(Object.hasOwn(parsed[0] ?? {}, '__proto__')).toBe(false);
  });

  test('legitimate string values containing "__proto__" as data are preserved', () => {
    // A user-authored value that happens to spell `__proto__`
    // (e.g., a path-like string) is fine — only KEYS are stripped.
    const parsed = safeJsonParse('{"description": "see __proto__ docs"}') as {
      description: string;
    };
    expect(parsed.description).toBe('see __proto__ docs');
  });

  test('top-level array works (not just objects)', () => {
    const parsed = safeJsonParse('[1, 2, 3]') as number[];
    expect(parsed).toEqual([1, 2, 3]);
  });

  test('top-level primitives work', () => {
    expect(safeJsonParse('42')).toBe(42);
    expect(safeJsonParse('"hello"')).toBe('hello');
    expect(safeJsonParse('null')).toBeNull();
    expect(safeJsonParse('true')).toBe(true);
  });
});
