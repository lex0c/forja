import { describe, expect, test } from 'bun:test';
import { applyProfileFlag } from '../../src/cli/profile-flag.ts';

// `--profile` is a GLOBAL pre-parse pass: it must set FORJA_PROFILE and strip
// itself from argv BEFORE parseArgs runs (every subcommand parser would reject
// the unknown flag) and BEFORE any path resolver fires. These tests pass a
// throwaway `env` object so they never mutate the real process environment.

describe('applyProfileFlag — parsing', () => {
  test('`--profile dev` sets env and is stripped from argv', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['--profile', 'dev', 'doctor'], env);
    expect(r.error).toBeUndefined();
    expect(r.argv).toEqual(['doctor']);
    expect(env.FORJA_PROFILE).toBe('dev');
  });

  test('`--profile=dev` (equals form) sets env and is stripped', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['--profile=dev', 'init'], env);
    expect(r.error).toBeUndefined();
    expect(r.argv).toEqual(['init']);
    expect(env.FORJA_PROFILE).toBe('dev');
  });

  test('flag is position-independent (valid after the subcommand)', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['doctor', '--json', '--profile', 'dev'], env);
    expect(r.error).toBeUndefined();
    expect(r.argv).toEqual(['doctor', '--json']);
    expect(env.FORJA_PROFILE).toBe('dev');
  });

  test('no flag, no env ⇒ argv passes through untouched, env unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['"summarize the readme"'], env);
    expect(r.error).toBeUndefined();
    expect(r.argv).toEqual(['"summarize the readme"']);
    expect(env.FORJA_PROFILE).toBeUndefined();
  });
});

describe('applyProfileFlag — validation', () => {
  test('missing value → clean error, env untouched', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['--profile'], env);
    expect(r.error).toMatch(/requires a value/);
    expect(env.FORJA_PROFILE).toBeUndefined();
  });

  test('value that looks like a flag is rejected (not consumed as the value)', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['--profile', '--json'], env);
    expect(r.error).toMatch(/requires a value/);
    expect(env.FORJA_PROFILE).toBeUndefined();
  });

  test('malformed flag value → clean error, env untouched', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = applyProfileFlag(['--profile', '../escape'], env);
    expect(r.error).toMatch(/invalid --profile/);
    expect(env.FORJA_PROFILE).toBeUndefined();
  });

  test('malformed pre-existing FORJA_PROFILE (no flag) fails fast here', () => {
    // Without this, the typo would throw deep in the first resolver as an
    // "unexpected error" instead of a clean usage message.
    const env: NodeJS.ProcessEnv = { FORJA_PROFILE: 'Bad' };
    const r = applyProfileFlag(['doctor'], env);
    expect(r.error).toMatch(/invalid FORJA_PROFILE/);
  });

  test('valid pre-existing FORJA_PROFILE (no flag) passes through', () => {
    const env: NodeJS.ProcessEnv = { FORJA_PROFILE: 'dev' };
    const r = applyProfileFlag(['doctor'], env);
    expect(r.error).toBeUndefined();
    expect(r.argv).toEqual(['doctor']);
    expect(env.FORJA_PROFILE).toBe('dev');
  });

  test('flag overrides a pre-existing env value', () => {
    const env: NodeJS.ProcessEnv = { FORJA_PROFILE: 'old' };
    const r = applyProfileFlag(['--profile', 'new'], env);
    expect(r.error).toBeUndefined();
    expect(env.FORJA_PROFILE).toBe('new');
  });
});
