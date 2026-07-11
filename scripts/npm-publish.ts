// Publishes the assembled npm tree (dist-npm/*) in dependency order
// (PERFORMANCE.md §18.6): the five platform packages FIRST, the launcher
// LAST — the launcher's optionalDependencies point at the platform
// packages, so publishing it earlier leaves a window where an install
// resolves a launcher whose binaries don't yet exist.
//
// Idempotent: npm has no --clobber, so each package is skipped when its
// exact version is already on the registry. A re-dispatch of the same
// tag is safe. Auth is provided by the CI environment (OIDC / Trusted
// Publishing, reusing id-token:write); provenance is attached via
// --provenance.
//
//   bun run scripts/npm-publish.ts [--out=dist-npm] [--dry-run]

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launcherPkgName } from './npm-pack.ts';

export interface DiscoveredPkg {
  name: string;
  version: string;
  dir: string;
}

// Walk `outDir` for `<scope>/<pkg>/package.json` (two levels: the scope
// dir, then each package dir). Sorted by name for stable ordering.
export const discoverPackages = (outDir: string): DiscoveredPkg[] => {
  if (!existsSync(outDir)) throw new Error(`npm tree not found: ${outDir} (run npm-pack first)`);
  const out: DiscoveredPkg[] = [];
  for (const scope of readdirSync(outDir)) {
    const scopeDir = join(outDir, scope);
    if (!statSync(scopeDir).isDirectory()) continue;
    for (const pkg of readdirSync(scopeDir)) {
      const pkgDir = join(scopeDir, pkg);
      const manifest = join(pkgDir, 'package.json');
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
        throw new Error(`invalid manifest (name/version) at ${manifest}`);
      }
      out.push({ name: parsed.name, version: parsed.version, dir: pkgDir });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

// Platform packages keep discovery order; the launcher is forced LAST.
export const publishOrder = (pkgs: readonly DiscoveredPkg[]): DiscoveredPkg[] => {
  const launcher = launcherPkgName();
  return [...pkgs.filter((p) => p.name !== launcher), ...pkgs.filter((p) => p.name === launcher)];
};

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: readonly string[]) => RunResult;

const defaultRun: Runner = (cmd, args) => {
  // Capture both streams: `npm view`'s E404 marker lands on stderr, and a
  // failed `npm publish`'s reason must be surfaced in the thrown error.
  const r = spawnSync(cmd, [...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export type PublishState = 'published' | 'absent' | 'unknown';

// Classify whether <name>@<version> is already on the registry via
// `npm view <name>@<version> version`:
//   published — exact version present (its string is echoed) → skip.
//   absent    — package or version genuinely not found (exit 0 + empty
//               stdout, or a non-zero E404) → publish.
//   unknown   — `npm view` failed for another reason (network / 5xx /
//               auth): we CANNOT tell, so the caller must not blindly
//               republish, which would yield a misleading E403
//               "cannot publish over existing version" on a re-dispatch.
export const publishState = (
  name: string,
  version: string,
  run: Runner = defaultRun,
): PublishState => {
  const r = run('npm', ['view', `${name}@${version}`, 'version']);
  if (r.status === 0) {
    return r.stdout.trim() === version ? 'published' : 'absent';
  }
  return `${r.stdout}\n${r.stderr}`.includes('E404') ? 'absent' : 'unknown';
};

// npm tags a publish `latest` unless --tag is given, so an unqualified
// publish of a prerelease (e.g. 1.2.3-rc.1 — which the `v*` tag trigger
// and normalizeVersion both accept) would move `latest` onto the RC, and
// `npm i -g @lex0c/forja` would hand every user a prerelease. Route
// prereleases to a separate tag so `latest` only ever points at a stable
// release. SemVer: the prerelease is the segment after `-`; build metadata
// (after `+`, which may itself contain `-`) is NOT a prerelease, so it is
// stripped before the check.
export const PRERELEASE_DIST_TAG = 'next';

export const distTag = (version: string, prereleaseTag: string = PRERELEASE_DIST_TAG): string => {
  const core = version.split('+', 1)[0] ?? version;
  return core.includes('-') ? prereleaseTag : 'latest';
};

export interface PublishOptions {
  outDir: string;
  dryRun: boolean;
  run?: Runner;
}

export interface PublishOutcome {
  name: string;
  version: string;
  tag: string;
  action: 'published' | 'skipped' | 'dry-run';
}

export const publishAll = (opts: PublishOptions): PublishOutcome[] => {
  const run = opts.run ?? defaultRun;
  const ordered = publishOrder(discoverPackages(opts.outDir));
  const outcomes: PublishOutcome[] = [];
  for (const p of ordered) {
    const tag = distTag(p.version);
    const state = publishState(p.name, p.version, run);
    if (state === 'published') {
      outcomes.push({ name: p.name, version: p.version, tag, action: 'skipped' });
      continue;
    }
    if (state === 'unknown') {
      // Can't confirm registry state — refuse rather than republish and
      // hit a confusing E403. The job is safe to retry.
      throw new Error(
        `could not determine whether ${p.name}@${p.version} is already published ` +
          `(npm view failed) — refusing to publish blindly; retry the job`,
      );
    }
    if (opts.dryRun) {
      outcomes.push({ name: p.name, version: p.version, tag, action: 'dry-run' });
      continue;
    }
    // --tag routes prereleases off `latest` (see distTag). Explicit even
    // for `latest` so the dist-tag is never left to npm's default.
    const r = run('npm', ['publish', p.dir, '--access', 'public', '--provenance', '--tag', tag]);
    if (r.status !== 0) {
      // Abort before the launcher if a platform package failed — never
      // ship a launcher whose binaries aren't on the registry.
      throw new Error(
        `npm publish failed for ${p.name}@${p.version} (exit ${r.status})${
          r.stderr ? `: ${r.stderr.trim()}` : ''
        }`,
      );
    }
    outcomes.push({ name: p.name, version: p.version, tag, action: 'published' });
  }
  return outcomes;
};

const main = (): void => {
  const argv = process.argv.slice(2);
  let outDir = 'dist-npm';
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith('--out=')) outDir = a.slice('--out='.length);
    else if (a === '--dry-run') dryRun = true;
    else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  try {
    const outcomes = publishAll({ outDir, dryRun });
    for (const o of outcomes) {
      process.stdout.write(`${o.action}: ${o.name}@${o.version} [${o.tag}]\n`);
    }
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
};

if (import.meta.main) main();
