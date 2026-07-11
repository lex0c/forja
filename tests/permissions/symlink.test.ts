import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { matchPath, resolveSymlinks } from '../../src/permissions/matcher.ts';

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

describe('matchPath: DANGLING symlink resolution (target absent)', () => {
  // A dangling symlink (its target does not exist) is the dangerous case:
  // realpath throws, and the OLD fallback collapsed it to the in-cwd lexical
  // path, so a cwd-scoped allow matched while the KERNEL would still follow
  // the link on write and land outside cwd. The resolver now reads the link.

  test('dangling symlink whose target is OUTSIDE cwd does NOT match (write escape closed)', () => {
    // `escapeTarget` exists; its child `pwned` does not, so the link dangles
    // at the leaf — the exact shape a write_file would create-through.
    const escapeTarget = mkdtempSync(join(tmpdir(), 'forja-escape-'));
    symlinkSync(join(escapeTarget, 'pwned'), join(workdir, 'escape'));

    expect(matchPath('**', 'escape', workdir)).toBe(false);
    // The resolver surfaces the REAL (outside) destination, not the in-cwd
    // form — that is what lets the protected/allow checks see the truth.
    expect(resolveSymlinks(resolve(workdir, 'escape'))).toBe(join(escapeTarget, 'pwned'));

    rmSync(escapeTarget, { recursive: true, force: true });
  });

  test('dangling target through a symlinked ANCESTOR resolves outside (deepest-prefix walk)', () => {
    // `link → outdir/missing/file`, where `outdir` is an in-cwd symlink to an
    // OUTSIDE dir and `missing` does not exist. A one-level parent realpath
    // ENOENTs (missing is absent), so the old fallback collapsed to the in-cwd
    // lexical path and a cwd allow matched — while a write follows `outdir`
    // outside. Walking to the deepest existing prefix (`outdir`) resolves it.
    const escapeTarget = mkdtempSync(join(tmpdir(), 'forja-escape-anc-'));
    symlinkSync(escapeTarget, join(workdir, 'outdir'));
    symlinkSync('outdir/missing/file', join(workdir, 'link'));

    expect(resolveSymlinks(resolve(workdir, 'link'))).toBe(join(escapeTarget, 'missing', 'file'));
    expect(matchPath('**', 'link', workdir)).toBe(false);

    rmSync(escapeTarget, { recursive: true, force: true });
  });

  test('dangling symlink into a PROTECTED zone resolves to the protected target', () => {
    // Nothing is written; we only assert the gate would SEE /etc/cron.d/...
    // (a protected zone) rather than a harmless in-cwd path.
    symlinkSync('/etc/cron.d/forja-pwned', join(workdir, 'escprot'));
    expect(resolveSymlinks(resolve(workdir, 'escprot'))).toBe('/etc/cron.d/forja-pwned');
  });

  test('dangling symlink whose target is INSIDE cwd still matches (legit write-through)', () => {
    // write_file deliberately writes through a dangling link to create its
    // target (tests/tools|write-file). When that target is in-cwd, the gate
    // must keep allowing it.
    mkdirSync(join(workdir, 'src'), { recursive: true });
    symlinkSync(join(workdir, 'src', 'later.txt'), join(workdir, 'inlink'));
    expect(matchPath('**', 'inlink', workdir)).toBe(true);
  });

  test('dangling symlink with a RELATIVE target resolves against the link dir (in-cwd → matches)', () => {
    mkdirSync(join(workdir, 'src'), { recursive: true });
    symlinkSync('src/rel-later.txt', join(workdir, 'rellink'));
    expect(matchPath('**', 'rellink', workdir)).toBe(true);
  });

  test('symlink cycle is bounded (no hang) — both legs in-cwd still resolve', () => {
    symlinkSync(join(workdir, 'loopB'), join(workdir, 'loopA'));
    symlinkSync(join(workdir, 'loopA'), join(workdir, 'loopB'));
    // The MAX_SYMLINK_HOPS bound must return rather than spin; both legs are
    // in-cwd so the resolved form stays in-cwd and matches.
    expect(matchPath('**', 'loopA', workdir)).toBe(true);
  });
});
