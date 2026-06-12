import { describe, expect, test } from 'bun:test';
import { parseDuration } from '../../src/reminders/index.ts';

describe('parseDuration', () => {
  test('parses seconds / minutes / hours', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1s')).toBe(1_000);
  });

  test('is case-insensitive on the unit and tolerates surrounding space', () => {
    expect(parseDuration('5M')).toBe(300_000);
    expect(parseDuration('  3h ')).toBe(10_800_000);
  });

  test('rejects malformed input as null (tool turns null into invalid_arg)', () => {
    for (const bad of [
      '',
      's',
      'm',
      '10',
      'abc',
      '10x',
      '1.5h',
      '-5m',
      '+5m',
      '10 m',
      '1h30m',
      '0s',
      '0m',
    ]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });

  test('zero of any unit is null (a reminder must be in the future)', () => {
    expect(parseDuration('0h')).toBeNull();
  });
});
