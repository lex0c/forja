// action_signature parser/serializer tests (FEEDBACK_ADAPTATION §4.2).

import { describe, expect, test } from 'bun:test';
import {
  InvalidActionSignatureError,
  levelOf,
  parseActionSignature,
  serializeActionSignature,
} from '../../src/storage/repos/action-signature.ts';

describe('serializeActionSignature', () => {
  test('L1 alias', () => {
    expect(serializeActionSignature({ level: 'L1', from: 'grep', to: 'ripgrep' })).toBe(
      'alias:grep:ripgrep',
    );
  });

  test('L2 flag', () => {
    expect(
      serializeActionSignature({
        level: 'L2',
        tool: 'bash',
        flag: 'cwd_arg',
        value: 'preferred',
      }),
    ).toBe('flag:bash:cwd_arg:preferred');
  });

  test('L3 recipe', () => {
    expect(serializeActionSignature({ level: 'L3', recipeId: 'sql_migration_dry_run' })).toBe(
      'recipe:sql_migration_dry_run',
    );
  });

  test('L4 strategy', () => {
    expect(
      serializeActionSignature({ level: 'L4', strategyId: 'refactor_batching', scope: 'js' }),
    ).toBe('strategy:refactor_batching:js');
  });

  test('rejects uppercase in L1 fields', () => {
    expect(() => serializeActionSignature({ level: 'L1', from: 'Grep', to: 'ripgrep' })).toThrow(
      InvalidActionSignatureError,
    );
  });

  test('rejects empty fields', () => {
    expect(() => serializeActionSignature({ level: 'L1', from: '', to: 'ripgrep' })).toThrow(
      InvalidActionSignatureError,
    );
  });

  test('rejects colons in fields (would clash with separator)', () => {
    expect(() =>
      serializeActionSignature({ level: 'L1', from: 'grep:cmd', to: 'ripgrep' }),
    ).toThrow(InvalidActionSignatureError);
  });
});

describe('parseActionSignature', () => {
  test('round-trip L1', () => {
    const s = 'alias:grep:ripgrep';
    const p = parseActionSignature(s);
    expect(p).toEqual({ level: 'L1', from: 'grep', to: 'ripgrep' });
    if (p !== null) expect(serializeActionSignature(p)).toBe(s);
  });

  test('round-trip L2', () => {
    const s = 'flag:bash:cwd_arg:preferred';
    const p = parseActionSignature(s);
    expect(p).toEqual({ level: 'L2', tool: 'bash', flag: 'cwd_arg', value: 'preferred' });
    if (p !== null) expect(serializeActionSignature(p)).toBe(s);
  });

  test('round-trip L3', () => {
    const s = 'recipe:sql_migration_dry_run';
    const p = parseActionSignature(s);
    expect(p).toEqual({ level: 'L3', recipeId: 'sql_migration_dry_run' });
    if (p !== null) expect(serializeActionSignature(p)).toBe(s);
  });

  test('round-trip L4', () => {
    const s = 'strategy:refactor_batching:js';
    const p = parseActionSignature(s);
    expect(p).toEqual({ level: 'L4', strategyId: 'refactor_batching', scope: 'js' });
    if (p !== null) expect(serializeActionSignature(p)).toBe(s);
  });

  test('returns null for unknown prefix', () => {
    expect(parseActionSignature('unknown:foo:bar')).toBeNull();
  });

  test('returns null for wrong field count', () => {
    expect(parseActionSignature('alias:grep')).toBeNull(); // L1 needs 3 parts
    expect(parseActionSignature('flag:bash:cwd_arg')).toBeNull(); // L2 needs 4 parts
    expect(parseActionSignature('recipe:foo:bar')).toBeNull(); // L3 needs 2 parts
  });

  test('returns null when fields contain invalid characters', () => {
    expect(parseActionSignature('alias:Grep:ripgrep')).toBeNull();
    expect(parseActionSignature('alias:grep cmd:ripgrep')).toBeNull();
  });

  test('returns null for empty or too short', () => {
    expect(parseActionSignature('')).toBeNull();
    expect(parseActionSignature('alias')).toBeNull();
  });
});

describe('levelOf', () => {
  test('detects level from prefix without full parse', () => {
    expect(levelOf('alias:grep:ripgrep')).toBe('L1');
    expect(levelOf('flag:bash:cwd_arg:preferred')).toBe('L2');
    expect(levelOf('recipe:sql_migration_dry_run')).toBe('L3');
    expect(levelOf('strategy:refactor_batching:js')).toBe('L4');
  });

  test('null for unknown prefix', () => {
    expect(levelOf('unknown:foo')).toBeNull();
    expect(levelOf('')).toBeNull();
  });

  test('does NOT validate field content (callers parse for that)', () => {
    // levelOf is a cheap prefix check; the actual parser catches
    // invalid field content. This keeps query-side filters fast.
    expect(levelOf('alias:GREP:ripgrep')).toBe('L1');
  });
});
