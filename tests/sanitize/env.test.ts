import { describe, expect, test } from 'bun:test';
import { scrubEnv } from '../../src/sanitize/env.ts';

describe('scrubEnv', () => {
  test('drops *_API_KEY by suffix', () => {
    const out = scrubEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', SAFE: 'v' });
    expect(out).toEqual({ SAFE: 'v' });
  });

  test('drops *_TOKEN, *_SECRET, *_PASSWORD, *_PASS by suffix', () => {
    const out = scrubEnv({
      DATABASE_PASSWORD: 'a',
      SOMETHING_TOKEN: 'b',
      MY_SECRET: 'c',
      ROOT_PASS: 'd',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops AWS_*, OPENAI_*, ANTHROPIC_* by prefix', () => {
    const out = scrubEnv({
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SESSION_TOKEN: 'b',
      OPENAI_ORG_ID: 'c',
      ANTHROPIC_BASE_URL: 'd',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops specific named tokens (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, DOCKER_PASSWORD)', () => {
    const out = scrubEnv({
      GITHUB_TOKEN: 'a',
      GH_TOKEN: 'b',
      NPM_TOKEN: 'c',
      DOCKER_PASSWORD: 'd',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops GOOGLE_API_KEY and GEMINI_API_KEY', () => {
    const out = scrubEnv({ GOOGLE_API_KEY: 'a', GEMINI_API_KEY: 'b', KEEP: 'k' });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('matches case-insensitively', () => {
    const out = scrubEnv({
      anthropic_api_key: 'a',
      Aws_Region: 'b',
      OpenAi_org: 'c',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops undefined values silently', () => {
    const env: NodeJS.ProcessEnv = { DEFINED: 'v', MISSING: undefined };
    const out = scrubEnv(env);
    expect(out).toEqual({ DEFINED: 'v' });
  });

  test('preserves PATH, HOME, and other innocuous vars', () => {
    const out = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      USER: 'me',
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      USER: 'me',
    });
  });

  test('result is a fresh object (no shared reference with input)', () => {
    const env = { KEEP: 'v' };
    const out = scrubEnv(env);
    expect(out).not.toBe(env);
  });
});
