// Assembles the npm publish tree (PERFORMANCE.md §18.6): one launcher
// package (`@lex0c/forja`) plus five per-platform packages
// (`@lex0c/forja-<target_id>`), each carrying the matching binary gated
// by `os`/`cpu`. Consumes the SAME binaries the GitHub Release ships —
// located in `dist/` and RE-VERIFIED against `SHA256SUMS` before
// packaging (fail-closed, mirroring install.sh).
//
// The launcher manifest is patched from the committed template at
// `npm/launcher/package.json` (version + exact optional-dependency
// pins). Platform manifests are synthesized from `TARGETS` so the target
// table stays the single source of truth.
//
//   bun run scripts/npm-pack.ts --version=1.2.3 [--dist=dist] [--out=dist-npm]
//                               [--sums=<dist>/SHA256SUMS] [--launcher=npm/launcher]
//                               [--readme=<path>]  (default: repo root README.md)

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseSums, sha256File } from './checksums.ts';
import { normalizeVersion } from './stamp-version.ts';
import { type BuildTarget, TARGETS } from './targets.ts';

export const NPM_SCOPE = '@lex0c';
export const launcherPkgName = (): string => `${NPM_SCOPE}/forja`;
export const platformPkgName = (t: BuildTarget): string => `${NPM_SCOPE}/forja-${t.id}`;

// npm's `os` field matches `process.platform`, whose Windows value is
// `win32` — NOT our target-id segment `windows`. `cpu` matches
// `process.arch` (`x64`/`arm64`), which already equals our arch.
const npmOs = (os: BuildTarget['os']): string => (os === 'windows' ? 'win32' : os);

// biome-ignore lint/suspicious/noExplicitAny: package.json is an open shape
type PkgJson = Record<string, any>;

// The optionalDependencies the launcher template MUST declare — exactly
// the five platform packages, no more, no less. Sorted for a stable
// comparison against the template.
export const expectedOptionalDeps = (): string[] => TARGETS.map(platformPkgName).sort();

export const platformManifest = (t: BuildTarget, version: string): PkgJson => ({
  name: platformPkgName(t),
  version,
  description: `Forja binary for ${t.id}`,
  license: 'Apache-2.0',
  homepage: 'https://github.com/lex0c/forja',
  repository: { type: 'git', url: 'git+https://github.com/lex0c/forja.git' },
  os: [npmOs(t.os)],
  cpu: [t.arch],
  // No `bin` (would collide with the launcher's `forja` command) and no
  // `exports` (would block the launcher's require.resolve of the file).
  files: [`bin/forja${t.ext}`],
});

// Patch the committed launcher template: stamp the version and pin every
// optional dependency to it (exact, never `^`, so launcher↔binary can't
// drift). Fails loudly if the template's optionalDependencies have
// drifted from the target table.
export const buildLauncherManifest = (template: PkgJson, version: string): PkgJson => {
  const optional = template.optionalDependencies;
  if (typeof optional !== 'object' || optional === null) {
    throw new Error('launcher template is missing optionalDependencies');
  }
  const keys = Object.keys(optional).sort();
  const expected = expectedOptionalDeps();
  if (keys.join(',') !== expected.join(',')) {
    throw new Error(
      `launcher optionalDependencies drift:\n  template: [${keys.join(', ')}]\n  expected: [${expected.join(', ')}]`,
    );
  }
  const pinned: Record<string, string> = {};
  for (const name of expected) pinned[name] = version;
  return { ...template, version, optionalDependencies: pinned };
};

// Locate a target's binary in `distDir` by suffix — version-segment
// agnostic, mirroring install.sh and the exec-check job: the `forja-…`
// file ending in `-<id>[.ext]`. Sourcemaps (`.map`) are excluded.
export const findBinary = (distDir: string, t: BuildTarget): string => {
  const suffix = `-${t.id}${t.ext}`;
  const matches = readdirSync(distDir).filter(
    (n) => n.startsWith('forja-') && n.endsWith(suffix) && !n.endsWith('.map'),
  );
  if (matches.length === 0) {
    throw new Error(`no binary for ${t.id} in ${distDir} (expected forja-*${suffix})`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous binaries for ${t.id} in ${distDir}: ${matches.join(', ')}`);
  }
  return matches[0] as string;
};

// Parse SHA256SUMS once into a filename → sha256 map, so pack() verifies
// every target against a single read+parse instead of one per target.
export const loadSums = (sumsPath: string): Map<string, string> => {
  if (!existsSync(sumsPath)) {
    throw new Error(`SHA256SUMS not found at ${sumsPath}`);
  }
  const map = new Map<string, string>();
  for (const e of parseSums(readFileSync(sumsPath, 'utf-8'))) map.set(e.filename, e.sha256);
  return map;
};

// Re-verify a binary against the parsed SHA256SUMS before packaging.
// Fail-closed: a missing entry or a hash mismatch aborts — we never ship
// an unverifiable binary through npm.
export const verifyAgainstSums = (
  distDir: string,
  filename: string,
  sums: ReadonlyMap<string, string>,
): void => {
  const expected = sums.get(filename);
  if (expected === undefined) {
    throw new Error(`${filename} not listed in SHA256SUMS — refusing to package`);
  }
  const actual = sha256File(join(distDir, filename));
  if (actual !== expected) {
    throw new Error(`hash mismatch for ${filename}: expected ${expected}, got ${actual}`);
  }
};

const writeJson = (path: string, obj: PkgJson): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
};

export interface PackOptions {
  distDir: string;
  outDir: string;
  version: string;
  sumsPath: string;
  launcherDir: string;
  // README shipped in the launcher package — this is what npmjs.com
  // renders on the package page. Defaults to the repo root README so the
  // npm page mirrors GitHub.
  readmePath: string;
}

export interface PackedPackage {
  name: string;
  dir: string;
  kind: 'platform' | 'launcher';
}

export const pack = (opts: PackOptions): PackedPackage[] => {
  const version = normalizeVersion(opts.version);
  // Load+parse SHA256SUMS once, before wiping outDir, so a missing SUMS
  // fails closed without leaving a half-cleared tree.
  const sums = loadSums(opts.sumsPath);

  // Fresh tree each run so a stale package from a prior version can't
  // ride along into the publish step.
  if (existsSync(opts.outDir)) rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });

  const packed: PackedPackage[] = [];

  // Platform packages.
  for (const t of TARGETS) {
    const filename = findBinary(opts.distDir, t);
    verifyAgainstSums(opts.distDir, filename, sums);

    const pkgDir = join(opts.outDir, platformPkgName(t));
    const binDest = join(pkgDir, 'bin', `forja${t.ext}`);
    mkdirSync(dirname(binDest), { recursive: true });
    copyFileSync(join(opts.distDir, filename), binDest);
    // copyFileSync doesn't carry the source mode; set the executable bit
    // explicitly (npm preserves tarball mode on unpack).
    chmodSync(binDest, 0o755);
    writeJson(join(pkgDir, 'package.json'), platformManifest(t, version));
    packed.push({ name: platformPkgName(t), dir: pkgDir, kind: 'platform' });
  }

  // Launcher package (patched template + shim + README).
  const template = JSON.parse(readFileSync(join(opts.launcherDir, 'package.json'), 'utf-8'));
  const launcherOut = join(opts.outDir, launcherPkgName());
  writeJson(join(launcherOut, 'package.json'), buildLauncherManifest(template, version));
  const shimDest = join(launcherOut, 'bin', 'forja');
  mkdirSync(dirname(shimDest), { recursive: true });
  copyFileSync(join(opts.launcherDir, 'bin', 'forja'), shimDest);
  chmodSync(shimDest, 0o755);
  // The repo README (opts.readmePath) is what shows on the npm page.
  copyFileSync(opts.readmePath, join(launcherOut, 'README.md'));
  packed.push({ name: launcherPkgName(), dir: launcherOut, kind: 'launcher' });

  return packed;
};

interface ParsedArgs {
  distDir: string;
  outDir: string;
  version: string;
  sumsPath: string;
  launcherDir: string;
  readmePath: string;
}

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let distDir = 'dist';
  let outDir = 'dist-npm';
  let version = process.env.FORJA_RELEASE_VERSION ?? '';
  let sumsPath = '';
  let launcherDir = resolve(import.meta.dir, '../npm/launcher');
  // Default to the repo root README so the npm page mirrors GitHub.
  let readmePath = resolve(import.meta.dir, '../README.md');
  for (const a of argv) {
    if (a.startsWith('--dist=')) distDir = a.slice('--dist='.length);
    else if (a.startsWith('--out=')) outDir = a.slice('--out='.length);
    else if (a.startsWith('--version=')) version = a.slice('--version='.length);
    else if (a.startsWith('--sums=')) sumsPath = a.slice('--sums='.length);
    else if (a.startsWith('--launcher=')) launcherDir = a.slice('--launcher='.length);
    else if (a.startsWith('--readme=')) readmePath = a.slice('--readme='.length);
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  if (version === '') {
    process.stderr.write('npm-pack: --version=<x.y.z> (or FORJA_RELEASE_VERSION) is required\n');
    process.exit(2);
  }
  if (sumsPath === '') sumsPath = join(distDir, 'SHA256SUMS');
  return { distDir, outDir, version, sumsPath, launcherDir, readmePath };
};

const main = (): void => {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const packed = pack(opts);
    for (const p of packed) process.stdout.write(`packed ${p.name} → ${p.dir}\n`);
    process.stdout.write(`assembled ${packed.length} package(s) into ${opts.outDir}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
};

if (import.meta.main) main();
