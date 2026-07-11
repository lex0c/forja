import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatSums, sha256File } from '../../scripts/checksums.ts';
import {
  buildLauncherManifest,
  expectedOptionalDeps,
  findBinary,
  launcherPkgName,
  loadSums,
  pack,
  platformManifest,
  platformPkgName,
  verifyAgainstSums,
} from '../../scripts/npm-pack.ts';
import { TARGETS } from '../../scripts/targets.ts';
import { targetById } from '../scripts/_helpers.ts';

const LAUNCHER_DIR = resolve(import.meta.dir, '../../npm/launcher');
const VERSION = '1.2.3';

const tmpDirs: string[] = [];
const freshDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// A fake dist/ with one binary per target (named forja-<version>-<id>[.ext])
// plus a matching SHA256SUMS, exactly as the release build would leave it.
const makeDist = (version: string): string => {
  const dir = freshDir('forja-npm-dist-');
  const entries: { filename: string; sha256: string }[] = [];
  for (const t of TARGETS) {
    const filename = `forja-${version}-${t.id}${t.ext}`;
    const path = join(dir, filename);
    writeFileSync(path, `binary:${t.id}:${version}`);
    entries.push({ filename, sha256: sha256File(path) });
  }
  writeFileSync(join(dir, 'SHA256SUMS'), formatSums(entries));
  return dir;
};

describe('platformManifest', () => {
  test('windows os field is win32, not the windows target-id segment', () => {
    const m = platformManifest(targetById('windows-x64'), VERSION);
    expect(m.os).toEqual(['win32']);
    expect(m.cpu).toEqual(['x64']);
    expect(m.name).toBe('@lex0c/forja-windows-x64');
    expect(m.files).toEqual(['bin/forja.exe']);
  });

  test('unix targets keep os === platform and no .exe', () => {
    const m = platformManifest(targetById('linux-arm64'), VERSION);
    expect(m.os).toEqual(['linux']);
    expect(m.cpu).toEqual(['arm64']);
    expect(m.files).toEqual(['bin/forja']);
  });

  test('platform packages declare neither bin nor exports', () => {
    for (const t of TARGETS) {
      const m = platformManifest(t, VERSION);
      expect(m.bin).toBeUndefined();
      expect(m.exports).toBeUndefined();
      expect(m.version).toBe(VERSION);
    }
  });
});

describe('launcher template', () => {
  const template = JSON.parse(readFileSync(join(LAUNCHER_DIR, 'package.json'), 'utf-8'));

  test('committed optionalDependencies match the target table exactly', () => {
    expect(Object.keys(template.optionalDependencies).sort()).toEqual(expectedOptionalDeps());
  });

  test('buildLauncherManifest pins every optional dep to the stamped version', () => {
    const m = buildLauncherManifest(template, VERSION);
    expect(m.version).toBe(VERSION);
    for (const name of expectedOptionalDeps()) {
      expect(m.optionalDependencies[name]).toBe(VERSION);
    }
    // bin/command name is preserved from the template.
    expect(m.bin).toEqual({ forja: 'bin/forja' });
  });

  test('drift in the template optionalDependencies is rejected', () => {
    const drifted = { ...template, optionalDependencies: { '@lex0c/forja-linux-x64': '0.0.0' } };
    expect(() => buildLauncherManifest(drifted, VERSION)).toThrow(/drift/);
  });
});

describe('findBinary', () => {
  test('locates by target suffix, version-agnostic', () => {
    const dist = makeDist('9.9.9');
    expect(findBinary(dist, targetById('linux-x64'))).toBe('forja-9.9.9-linux-x64');
    expect(findBinary(dist, targetById('windows-x64'))).toBe('forja-9.9.9-windows-x64.exe');
  });

  test('throws when no binary matches', () => {
    const dist = freshDir('forja-empty-');
    expect(() => findBinary(dist, targetById('linux-x64'))).toThrow(/no binary/);
  });

  test('throws on ambiguous matches', () => {
    const dist = freshDir('forja-ambig-');
    writeFileSync(join(dist, 'forja-1.0.0-linux-x64'), 'a');
    writeFileSync(join(dist, 'forja-2.0.0-linux-x64'), 'b');
    expect(() => findBinary(dist, targetById('linux-x64'))).toThrow(/ambiguous/);
  });

  test('ignores sourcemaps', () => {
    const dist = freshDir('forja-map-');
    writeFileSync(join(dist, 'forja-1.0.0-linux-x64'), 'bin');
    writeFileSync(join(dist, 'forja-1.0.0-linux-x64.map'), 'map');
    expect(findBinary(dist, targetById('linux-x64'))).toBe('forja-1.0.0-linux-x64');
  });
});

describe('verifyAgainstSums (fail-closed)', () => {
  test('passes for an untampered binary', () => {
    const dist = makeDist(VERSION);
    const sums = loadSums(join(dist, 'SHA256SUMS'));
    expect(() => verifyAgainstSums(dist, `forja-${VERSION}-linux-x64`, sums)).not.toThrow();
  });

  test('throws on hash mismatch', () => {
    const dist = makeDist(VERSION);
    const sums = loadSums(join(dist, 'SHA256SUMS'));
    // Tamper the binary AFTER SHA256SUMS was parsed.
    writeFileSync(join(dist, `forja-${VERSION}-linux-x64`), 'tampered');
    expect(() => verifyAgainstSums(dist, `forja-${VERSION}-linux-x64`, sums)).toThrow(
      /hash mismatch/,
    );
  });

  test('throws when the file is absent from SHA256SUMS', () => {
    const dist = makeDist(VERSION);
    const sums = loadSums(join(dist, 'SHA256SUMS'));
    expect(() => verifyAgainstSums(dist, 'forja-9.9.9-not-listed', sums)).toThrow(/not listed/);
  });

  test('loadSums throws when SHA256SUMS is missing', () => {
    const empty = freshDir('forja-nosums-');
    expect(() => loadSums(join(empty, 'SHA256SUMS'))).toThrow(/not found/);
  });
});

describe('pack (end to end)', () => {
  test('assembles 6 packages with correct layout, gates, and executable bits', () => {
    const dist = makeDist(VERSION);
    const outDir = freshDir('forja-npm-out-');
    const packed = pack({
      distDir: dist,
      outDir,
      version: VERSION,
      sumsPath: join(dist, 'SHA256SUMS'),
      launcherDir: LAUNCHER_DIR,
    });

    expect(packed).toHaveLength(TARGETS.length + 1);

    // Platform packages.
    for (const t of TARGETS) {
      const pkgDir = join(outDir, platformPkgName(t));
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
      expect(manifest.name).toBe(platformPkgName(t));
      expect(manifest.version).toBe(VERSION);
      expect(manifest.cpu).toEqual([t.arch]);
      expect(manifest.bin).toBeUndefined();

      const binPath = join(pkgDir, 'bin', `forja${t.ext}`);
      expect(existsSync(binPath)).toBe(true);
      // Executable bit present (npm preserves tarball mode).
      expect(statSync(binPath).mode & 0o111).not.toBe(0);
    }

    // Launcher.
    const launcherDir = join(outDir, launcherPkgName());
    const launcher = JSON.parse(readFileSync(join(launcherDir, 'package.json'), 'utf-8'));
    expect(launcher.version).toBe(VERSION);
    for (const name of expectedOptionalDeps()) {
      expect(launcher.optionalDependencies[name]).toBe(VERSION);
    }
    expect(existsSync(join(launcherDir, 'bin', 'forja'))).toBe(true);
    expect(existsSync(join(launcherDir, 'README.md'))).toBe(true);
    expect(statSync(join(launcherDir, 'bin', 'forja')).mode & 0o111).not.toBe(0);
  });

  test('aborts fail-closed when a binary does not match SHA256SUMS', () => {
    const dist = makeDist(VERSION);
    const outDir = freshDir('forja-npm-out-');
    writeFileSync(join(dist, `forja-${VERSION}-linux-x64`), 'tampered-after-sums');
    expect(() =>
      pack({
        distDir: dist,
        outDir,
        version: VERSION,
        sumsPath: join(dist, 'SHA256SUMS'),
        launcherDir: LAUNCHER_DIR,
      }),
    ).toThrow(/hash mismatch/);
  });
});
