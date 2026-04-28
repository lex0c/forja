import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchPath } from '../../src/permissions/matcher.ts';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'forja-symlink-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('matchPath: symlink resolution', () => {
  test('symlink inside cwd that targets outside cwd does NOT match cwd-relative pattern', () => {
    // Create `workdir/src/safe.ts` and a symlink `workdir/src/escape`
    // pointing to a path outside workdir. Without realpath resolution,
    // the matcher would see `workdir/src/escape` and match `src/**`.
    // With realpath, it resolves to the outside path and falls out.
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(join(workdir, 'src/safe.ts'), '');
    const escapeTarget = mkdtempSync(join(tmpdir(), 'forja-escape-'));
    writeFileSync(join(escapeTarget, 'secret.txt'), 'plaintext password');
    symlinkSync(join(escapeTarget, 'secret.txt'), join(workdir, 'src/escape'));

    expect(matchPath('src/**', 'src/safe.ts', workdir)).toBe(true);
    expect(matchPath('src/**', 'src/escape', workdir)).toBe(false);

    rmSync(escapeTarget, { recursive: true, force: true });
  });

  test('symlinked DIRECTORY inside cwd that targets outside cwd is also caught', () => {
    // `workdir/src` is a symlink to `escapeTarget`. Reading `src/foo.txt`
    // resolves to `escapeTarget/foo.txt` — outside cwd, no match.
    const escapeTarget = mkdtempSync(join(tmpdir(), 'forja-escape-dir-'));
    writeFileSync(join(escapeTarget, 'foo.txt'), 'data');
    symlinkSync(escapeTarget, join(workdir, 'src'));

    expect(matchPath('src/**', 'src/foo.txt', workdir)).toBe(false);
    rmSync(escapeTarget, { recursive: true, force: true });
  });

  test('plain (non-symlink) path inside cwd still matches', () => {
    mkdirSync(join(workdir, 'src'), { recursive: true });
    writeFileSync(join(workdir, 'src/a.ts'), '');
    expect(matchPath('src/**', 'src/a.ts', workdir)).toBe(true);
  });

  test('non-existent path falls back to cwd-relative match (write_file new file)', () => {
    // `write_file({path: 'src/new.ts'})` for a not-yet-existing file:
    // realpath fails, we fall back to parent realpath + basename.
    // Parent is workdir (exists), so the resolved path stays in workdir
    // and matches the cwd-relative pattern.
    mkdirSync(join(workdir, 'src'), { recursive: true });
    expect(matchPath('src/**', 'src/new.ts', workdir)).toBe(true);
  });
});
