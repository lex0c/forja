import { describe, expect, test } from 'bun:test';
import { createToolRegistry } from '../../src/tools/registry.ts';
import type { Tool } from '../../src/tools/types.ts';

const dummyTool = (name: string): Tool =>
  ({
    name,
    description: 'd',
    inputSchema: { type: 'object' },
    metadata: { category: 'misc', writes: false, idempotent: true },
    async execute() {
      return {};
    },
  }) as Tool;

describe('createToolRegistry', () => {
  test('starts empty', () => {
    const reg = createToolRegistry();
    expect(reg.list()).toEqual([]);
  });

  test('register / get / has', () => {
    const reg = createToolRegistry();
    const t = dummyTool('foo');
    reg.register(t);
    expect(reg.has('foo')).toBe(true);
    expect(reg.get('foo')).toBe(t);
    expect(reg.get('bar')).toBeNull();
  });

  test('throws on duplicate name', () => {
    const reg = createToolRegistry();
    reg.register(dummyTool('foo'));
    expect(() => reg.register(dummyTool('foo'))).toThrow(/already registered/);
  });

  test('list returns all in registration order', () => {
    const reg = createToolRegistry();
    reg.register(dummyTool('a'));
    reg.register(dummyTool('b'));
    reg.register(dummyTool('c'));
    expect(reg.list().map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });

  test('unregister removes a tool and reports whether it was present', () => {
    const reg = createToolRegistry();
    reg.register(dummyTool('foo'));
    expect(reg.unregister('foo')).toBe(true);
    expect(reg.has('foo')).toBe(false);
    expect(reg.get('foo')).toBeNull();
    expect(reg.list()).toEqual([]);
    // Idempotent: removing an absent name is a no-op returning false.
    expect(reg.unregister('foo')).toBe(false);
  });

  test('a name can be re-registered after unregister (no duplicate throw)', () => {
    const reg = createToolRegistry();
    reg.register(dummyTool('foo'));
    reg.unregister('foo');
    expect(() => reg.register(dummyTool('foo'))).not.toThrow();
    expect(reg.has('foo')).toBe(true);
  });
});
