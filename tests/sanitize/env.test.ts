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

  // Slice 135 P1 sec-1: slice 128 R4 P1 added 7 credential-/
  // session-bearing env vars that don't match the standard
  // suffix patterns. Pin each one so a future regression that
  // shortens the SCRUB_PATTERNS list (or refactors to a single
  // mega-regex) doesn't silently let one through.
  describe('slice 128 R4 P1 — credential/session vars without standard suffix', () => {
    test('drops SSH_AUTH_SOCK (ssh-agent socket path)', () => {
      const out = scrubEnv({ SSH_AUTH_SOCK: '/tmp/ssh-XXX/agent.123', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops GPG_AGENT_INFO and GNUPGHOME', () => {
      const out = scrubEnv({
        GPG_AGENT_INFO: '/run/user/1000/gnupg/S.gpg-agent:0:1',
        GNUPGHOME: '/home/me/.gnupg-evil',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops KUBECONFIG (k8s credential file path)', () => {
      const out = scrubEnv({ KUBECONFIG: '/home/me/.kube/config', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops DOCKER_AUTH_CONFIG (base64 registry creds)', () => {
      const out = scrubEnv({ DOCKER_AUTH_CONFIG: 'base64-blob', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops OP_SESSION_* (1Password CLI per-account sessions)', () => {
      const out = scrubEnv({
        OP_SESSION_account_a: 'session-token-a',
        OP_SESSION_account_b: 'session-token-b',
        OP_session_lower: 'lower-case',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops CLOUDSDK_* (gcloud config + auth tokens)', () => {
      const out = scrubEnv({
        CLOUDSDK_AUTH_ACCESS_TOKEN: 'tok',
        CLOUDSDK_CORE_PROJECT: 'prj',
        cloudsdk_lower_case: 'still-dropped',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('all slice-128 vars together: every one stripped, KEEP survives', () => {
      const out = scrubEnv({
        SSH_AUTH_SOCK: 'a',
        GPG_AGENT_INFO: 'b',
        GNUPGHOME: 'c',
        KUBECONFIG: 'd',
        DOCKER_AUTH_CONFIG: 'e',
        OP_SESSION_x: 'f',
        CLOUDSDK_y: 'g',
        KEEP: 'survive',
      });
      expect(out).toEqual({ KEEP: 'survive' });
    });
  });

  // Slice 129 (R5 P0-3): GIT_CONFIG_* env vars bypass the slice 128
  // `-c` argv refuse path. Confirm every git-config-via-env shape
  // is scrubbed.
  describe('slice 129 — git config via env', () => {
    test('drops GIT_CONFIG_PARAMETERS', () => {
      const out = scrubEnv({
        GIT_CONFIG_PARAMETERS: "'core.sshCommand=sh -c id'",
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops indexed GIT_CONFIG_COUNT / KEY / VALUE', () => {
      const out = scrubEnv({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.sshCommand',
        GIT_CONFIG_VALUE_0: 'sh -c id',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops GIT_SSH / GIT_SSH_COMMAND / GIT_PAGER / GIT_EDITOR / GIT_PROXY_COMMAND', () => {
      const out = scrubEnv({
        GIT_SSH: '/tmp/evil',
        GIT_SSH_COMMAND: 'sh -c id',
        GIT_PAGER: 'sh -c id',
        GIT_EDITOR: 'sh -c id',
        GIT_PROXY_COMMAND: 'sh -c id',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops GIT_EXTERNAL_DIFF and GIT_TEMPLATE_DIR', () => {
      const out = scrubEnv({
        GIT_EXTERNAL_DIFF: '/tmp/evil',
        GIT_TEMPLATE_DIR: '/tmp/templates',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
  });
});
