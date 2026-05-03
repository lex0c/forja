import { describe, expect, test } from 'bun:test';
import { parseSlashInput } from '../../../src/cli/slash/parse.ts';

describe('parseSlashInput', () => {
  test('returns null for non-slash input', () => {
    expect(parseSlashInput('hello world')).toBeNull();
    expect(parseSlashInput('')).toBeNull();
    expect(parseSlashInput(' /help')).toBeNull(); // leading space → not a command
  });

  test('returns {name: "", args: []} for bare /', () => {
    expect(parseSlashInput('/')).toEqual({ name: '', args: [] });
    expect(parseSlashInput('/   ')).toEqual({ name: '', args: [] });
  });

  test('parses command name without args', () => {
    expect(parseSlashInput('/help')).toEqual({ name: 'help', args: [] });
    expect(parseSlashInput('/quit')).toEqual({ name: 'quit', args: [] });
  });

  test('parses positional args split on whitespace', () => {
    expect(parseSlashInput('/sessions 25')).toEqual({ name: 'sessions', args: ['25'] });
    expect(parseSlashInput('/budget cost 5.0')).toEqual({
      name: 'budget',
      args: ['cost', '5.0'],
    });
  });

  test('collapses multiple spaces in args', () => {
    expect(parseSlashInput('/foo   a   b')).toEqual({ name: 'foo', args: ['a', 'b'] });
  });

  test('preserves arg case (paths, IDs are case-significant)', () => {
    expect(parseSlashInput('/model anthropic/Claude-Sonnet')).toEqual({
      name: 'model',
      args: ['anthropic/Claude-Sonnet'],
    });
  });

  test('trims trailing whitespace before splitting', () => {
    expect(parseSlashInput('/help   ')).toEqual({ name: 'help', args: [] });
  });

  test('does not lowercase the command name (registry key is exact)', () => {
    expect(parseSlashInput('/HELP')).toEqual({ name: 'HELP', args: [] });
  });
});
