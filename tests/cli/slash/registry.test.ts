import { describe, expect, test } from 'bun:test';
import { createRegistry } from '../../../src/cli/slash/registry.ts';
import type { SlashCommand } from '../../../src/cli/slash/types.ts';

const cmd = (name: string, description = `${name} cmd`): SlashCommand => ({
  name,
  description,
  exec: async () => ({ kind: 'ok' }),
});

describe('createRegistry', () => {
  test('lookup returns the registered command, undefined for unknown', () => {
    const r = createRegistry([cmd('help'), cmd('quit')]);
    expect(r.lookup('help')?.name).toBe('help');
    expect(r.lookup('quit')?.name).toBe('quit');
    expect(r.lookup('nope')).toBeUndefined();
  });

  test('lookup is case-sensitive (paths/IDs are case-significant downstream)', () => {
    const r = createRegistry([cmd('Help')]);
    expect(r.lookup('Help')?.name).toBe('Help');
    expect(r.lookup('help')).toBeUndefined();
  });

  test('duplicate registration throws at construction time', () => {
    expect(() => createRegistry([cmd('help'), cmd('help')])).toThrow(/duplicate/);
  });

  test('list returns commands in registration order', () => {
    const r = createRegistry([cmd('z'), cmd('a'), cmd('m')]);
    expect(r.list().map((c) => c.name)).toEqual(['z', 'a', 'm']);
  });

  test('complete with empty prefix returns all commands', () => {
    const r = createRegistry([cmd('help'), cmd('quit'), cmd('clear')]);
    expect(r.complete('').map((c) => c.name)).toEqual(['help', 'quit', 'clear']);
  });

  test('complete prefix-matches and sorts results', () => {
    const r = createRegistry([cmd('help'), cmd('quit'), cmd('clear'), cmd('cost')]);
    expect(r.complete('c').map((c) => c.name)).toEqual(['clear', 'cost']);
    expect(r.complete('he').map((c) => c.name)).toEqual(['help']);
    expect(r.complete('q').map((c) => c.name)).toEqual(['quit']);
  });

  test('complete is case-insensitive on the prefix (input is forgiving)', () => {
    const r = createRegistry([cmd('Help'), cmd('Quit')]);
    expect(r.complete('h').map((c) => c.name)).toEqual(['Help']);
    expect(r.complete('Q').map((c) => c.name)).toEqual(['Quit']);
  });

  test('complete returns empty array when no command matches', () => {
    const r = createRegistry([cmd('help')]);
    expect(r.complete('xyz')).toEqual([]);
  });
});
