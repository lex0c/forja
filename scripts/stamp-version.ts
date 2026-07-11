// Version stamp: writes a release version into the single source every
// build artifact derives from — `src/cli/version.ts` `VERSION`, read by
// `scripts/targets.ts assetName` (the release asset names) and by the
// `--version` output (src/cli/index.ts). Run at the START of the
// release build (and the reproducibility + npm-publish jobs) so binaries
// are named `forja-<version>-<id>` and report the real version instead
// of the committed `0.0.0` placeholder. PERFORMANCE.md §18.6.
//
// The committed source keeps `0.0.0`; this is a build-time stamp, not a
// commit. Deterministic (same tag → same file bytes) so it does not
// perturb reproducible builds.
//
//   bun run scripts/stamp-version.ts <tag-or-version>   # v1.2.3 | 1.2.3

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Accept a git tag (`v1.2.3`) or a bare version (`1.2.3`) and return the
// normalized semver. Strips a single leading `v`. Throws on anything
// that isn't MAJOR.MINOR.PATCH with optional prerelease/build metadata —
// a malformed version must fail the release loudly, never stamp garbage
// into the binary. (Build script, not a policy/permission surface, so a
// regex is fine — the `no regex` hard rule scopes to permissions.)
export const normalizeVersion = (tagOrVersion: string): string => {
  const v = tagOrVersion.startsWith('v') ? tagOrVersion.slice(1) : tagOrVersion;
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
  if (!SEMVER.test(v)) {
    throw new Error(
      `not a valid version: ${tagOrVersion} (expected MAJOR.MINOR.PATCH[-pre][+build])`,
    );
  }
  return v;
};

// Replace the `VERSION` const in a version.ts source string. Requires
// exactly one match: a refactor that renames or duplicates the const
// fails here instead of silently stamping nothing.
export const stampSource = (source: string, version: string): string => {
  const RE = /export const VERSION = '[^']*';/g;
  const matches = source.match(RE);
  if (matches === null || matches.length === 0) {
    throw new Error('VERSION const not found in version.ts');
  }
  if (matches.length > 1) {
    throw new Error(`expected exactly one VERSION const, found ${matches.length}`);
  }
  return source.replace(RE, `export const VERSION = '${version}';`);
};

export interface StampResult {
  path: string;
  version: string;
}

export const stampVersionFile = (versionTsPath: string, tagOrVersion: string): StampResult => {
  const version = normalizeVersion(tagOrVersion);
  const source = readFileSync(versionTsPath, 'utf-8');
  writeFileSync(versionTsPath, stampSource(source, version));
  return { path: versionTsPath, version };
};

const DEFAULT_VERSION_TS = resolve(import.meta.dir, '../src/cli/version.ts');

const main = (): void => {
  const arg = process.argv[2] ?? process.env.FORJA_RELEASE_VERSION;
  if (arg === undefined || arg === '') {
    process.stderr.write('Usage: bun run scripts/stamp-version.ts <tag-or-version>\n');
    process.exit(2);
  }
  try {
    const { path, version } = stampVersionFile(DEFAULT_VERSION_TS, arg);
    process.stdout.write(`stamped ${path} → ${version}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
};

if (import.meta.main) main();
