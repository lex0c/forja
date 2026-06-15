import { afterEach, describe, expect, test } from 'bun:test';
import { boolFromEnv } from '../../src/providers/env.ts';

const VAR = 'FORJA_TEST_BOOL_FLAG';

afterEach(() => {
  delete process.env[VAR];
});

describe('boolFromEnv', () => {
  test('truthy vocabulary: 1/true/yes/on (case-insensitive) → true', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
      process.env[VAR] = v;
      expect(boolFromEnv(VAR)).toBe(true);
    }
  });

  test('anything else → false', () => {
    for (const v of ['0', 'false', 'no', 'off', 'enabled', 'xyz']) {
      process.env[VAR] = v;
      expect(boolFromEnv(VAR)).toBe(false);
    }
  });

  test('unset or empty → the fallback (default false)', () => {
    delete process.env[VAR];
    expect(boolFromEnv(VAR)).toBe(false);
    expect(boolFromEnv(VAR, true)).toBe(true);
    process.env[VAR] = '';
    expect(boolFromEnv(VAR)).toBe(false);
    expect(boolFromEnv(VAR, true)).toBe(true);
  });
});
