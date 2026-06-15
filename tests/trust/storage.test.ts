import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTrustedDir, isTrusted, loadTrustedDirs } from '../../src/trust/storage.ts';

describe('trust/storage', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forja-trust-'));
    path = join(dir, 'trusted_dirs.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loadTrustedDirs returns empty list when file missing', () => {
    expect(loadTrustedDirs(path)).toEqual([]);
  });

  test('loadTrustedDirs returns empty when file contents are corrupt', () => {
    // Corrupt JSON shouldn't lock the operator out — they just lose
    // the persisted set and the next confirm re-establishes.
    writeFileSync(path, '{not valid json', { encoding: 'utf8' });
    expect(loadTrustedDirs(path)).toEqual([]);
  });

  test('loadTrustedDirs returns empty when shape is wrong', () => {
    writeFileSync(path, '{"directories": "should be array"}', { encoding: 'utf8' });
    expect(loadTrustedDirs(path)).toEqual([]);
  });

  test('addTrustedDir creates parent directory and persists', () => {
    // Use a nested path to simulate the first-ever boot when
    // ~/.config/forja doesn't exist yet.
    const nested = join(dir, 'a', 'b', 'trusted_dirs.json');
    addTrustedDir(nested, '/projects/foo');
    expect(existsSync(nested)).toBe(true);
    expect(loadTrustedDirs(nested)).toEqual(['/projects/foo']);
  });

  test('addTrustedDir preserves existing entries and appends new ones', () => {
    addTrustedDir(path, '/projects/foo');
    addTrustedDir(path, '/projects/bar');
    expect(loadTrustedDirs(path)).toEqual(['/projects/foo', '/projects/bar']);
  });

  test('addTrustedDir is idempotent (no duplicate entries)', () => {
    addTrustedDir(path, '/projects/foo');
    addTrustedDir(path, '/projects/foo');
    expect(loadTrustedDirs(path)).toEqual(['/projects/foo']);
  });

  test('isTrusted returns true only for paths that were added', () => {
    addTrustedDir(path, '/projects/foo');
    expect(isTrusted(path, '/projects/foo')).toBe(true);
    expect(isTrusted(path, '/projects/bar')).toBe(false);
    // Exact-string match: trailing slash doesn't count as the same.
    expect(isTrusted(path, '/projects/foo/')).toBe(false);
  });

  test('written file is human-readable JSON (operator can hand-edit)', () => {
    addTrustedDir(path, '/projects/foo');
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('directories');
    expect(raw).toContain('/projects/foo');
    // Has trailing newline (POSIX text-file convention).
    expect(raw.endsWith('\n')).toBe(true);
  });

  test('written file is owner-private (mode 0o600)', () => {
    addTrustedDir(path, '/projects/foo');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('atomic write leaves no .tmp artifact behind', () => {
    // tmp-then-rename: after a successful add, only the final file
    // should exist in the dir. A leftover `.pid.tmp` would mean the
    // rename never happened.
    addTrustedDir(path, '/projects/foo');
    const entries = readdirSync(dir);
    expect(entries).toEqual(['trusted_dirs.json']);
  });
});
