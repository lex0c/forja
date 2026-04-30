import { describe, expect, test } from 'bun:test';
import {
  SENSITIVE_PATH_DENY_LIST,
  matchSensitivePath,
} from '../../src/subagents/sensitive-paths.ts';

// Direct tests on the matcher. The integration coverage lives in
// worktree-validation.test.ts and worktree.test.ts; this file
// pins the pattern semantics so a refactor of the canonical list
// (or the matcher) can't silently shift what counts as
// sensitive.

describe('matchSensitivePath — exact patterns from §8.4', () => {
  test('matches `.env` at the root', () => {
    expect(matchSensitivePath('.env')).toBe('.env');
  });

  test('matches `.env` at any depth (any-depth normalization)', () => {
    // Spec lists `.env` without a `**/` prefix; the matcher
    // normalizes so a `.env` committed deep in the tree still
    // trips. This is the safer interpretation of an ambiguous
    // pattern (root vs any-depth).
    expect(matchSensitivePath('config/.env')).toBe('.env');
    expect(matchSensitivePath('a/b/c/.env')).toBe('.env');
  });

  test('matches `.env.local`, `.env.production` via `.env.*`', () => {
    expect(matchSensitivePath('.env.local')).toBe('.env.*');
    expect(matchSensitivePath('.env.production')).toBe('.env.*');
  });

  test('matches `*.pem` files at any depth', () => {
    expect(matchSensitivePath('cert.pem')).toBe('*.pem');
    expect(matchSensitivePath('certs/server.pem')).toBe('*.pem');
  });

  test('matches `id_rsa`, `id_rsa.pub`, `id_ed25519`', () => {
    expect(matchSensitivePath('id_rsa')).toBe('id_rsa*');
    expect(matchSensitivePath('id_rsa.pub')).toBe('id_rsa*');
    expect(matchSensitivePath('id_ed25519')).toBe('id_ed25519*');
  });

  test('matches `.ssh/<anything>` via `.ssh/**`', () => {
    // Files inside `.ssh/` that don't match a more-specific
    // pattern (`id_rsa*`, etc.) trip the directory-level rule.
    // `id_rsa` itself matches `id_rsa*` first because that
    // pattern appears earlier in the canonical list — the
    // matcher returns the first hit by design (linear scan).
    expect(matchSensitivePath('.ssh/known_hosts')).toBe('.ssh/**');
    expect(matchSensitivePath('.ssh/config/extra.conf')).toBe('.ssh/**');
    // Files that match a more-specific pattern still get
    // flagged — just under the more-specific name. Either way
    // the file is sensitive, which is what the validator cares
    // about.
    expect(matchSensitivePath('.ssh/id_rsa')).toBe('id_rsa*');
  });

  test('matches `**/secrets.yml` and `**/secrets.yaml` at any depth', () => {
    expect(matchSensitivePath('secrets.yml')).toBe('**/secrets.yml');
    expect(matchSensitivePath('config/secrets.yml')).toBe('**/secrets.yml');
    expect(matchSensitivePath('a/b/c/secrets.yaml')).toBe('**/secrets.yaml');
  });

  test('matches `**/credentials*.json` (GCP service accounts)', () => {
    expect(matchSensitivePath('credentials.json')).toBe('**/credentials*.json');
    expect(matchSensitivePath('credentials-prod.json')).toBe('**/credentials*.json');
    expect(matchSensitivePath('infra/credentials.json')).toBe('**/credentials*.json');
  });

  test('matches `.aws/credentials` and `.aws/config` exactly', () => {
    // The bare names `credentials` / `config` are way too
    // generic to deny-list on their own — only when they sit
    // under `.aws/` does the spec consider them sensitive.
    expect(matchSensitivePath('.aws/credentials')).toBe('.aws/credentials');
    expect(matchSensitivePath('.aws/config')).toBe('.aws/config');
  });

  test('non-sensitive paths return null', () => {
    expect(matchSensitivePath('README.md')).toBeNull();
    expect(matchSensitivePath('src/index.ts')).toBeNull();
    expect(matchSensitivePath('package.json')).toBeNull();
    expect(matchSensitivePath('credentials.txt')).toBeNull();
    expect(matchSensitivePath('environment.md')).toBeNull();
    expect(matchSensitivePath('docs/key-concepts.md')).toBeNull();
  });

  test('similar-but-distinct paths do not false-positive', () => {
    // `.envoy` shares the `.env` prefix but isn't a dotenv
    // file. Pattern `.env.*` requires a literal dot after env.
    expect(matchSensitivePath('.envoy')).toBeNull();
    // `id_rsa.bak` matches `id_rsa*` (intentional — backup of
    // a private key is still a private key).
    expect(matchSensitivePath('id_rsa.bak')).toBe('id_rsa*');
    // A file literally named `config` outside `.aws/` is fine.
    expect(matchSensitivePath('config')).toBeNull();
    expect(matchSensitivePath('src/config.ts')).toBeNull();
  });

  test('normalizes Windows-style separators to posix before matching', () => {
    // Defensive — production paths come from posix joins, but
    // a caller passing `\\` shouldn't silently bypass the
    // matcher.
    expect(matchSensitivePath('config\\.env')).toBe('.env');
  });

  test('normalizes leading `./` so cwd-relative paths still match', () => {
    expect(matchSensitivePath('./.env')).toBe('.env');
  });
});

describe('matchSensitivePath — custom patterns', () => {
  test('caller can override the deny-list', () => {
    expect(matchSensitivePath('foo.txt', ['*.txt'])).toBe('*.txt');
    expect(matchSensitivePath('foo.txt', ['*.md'])).toBeNull();
  });

  test('empty pattern list never matches', () => {
    expect(matchSensitivePath('.env', [])).toBeNull();
  });
});

describe('SENSITIVE_PATH_DENY_LIST integrity', () => {
  test('mirrors the spec patterns (regression on accidental edits)', () => {
    // The spec list is the source of truth; this assertion is
    // here so a PR that edits the constant without also editing
    // SECURITY_GUIDELINE.md §8.4 stands out as a deliberate
    // change. Update the array below ONLY when the spec doc
    // changed in the same PR.
    expect([...SENSITIVE_PATH_DENY_LIST]).toEqual([
      '.env',
      '.env.*',
      '.envrc',
      '*.pem',
      '*.key',
      '*.p12',
      '*.pfx',
      'id_rsa*',
      'id_ed25519*',
      'id_dsa*',
      'id_ecdsa*',
      '.ssh/**',
      '.gnupg/**',
      '.aws/credentials',
      '.aws/config',
      '.netrc',
      '.npmrc',
      '.pypirc',
      '*.kdbx',
      '**/credentials*.json',
      '**/secrets.yml',
      '**/secrets.yaml',
      '.git-credentials',
    ]);
  });
});
