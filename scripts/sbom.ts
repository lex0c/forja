// SBOM generator (SECURITY_GUIDELINE.md §7.2 line 307,
// PERFORMANCE.md §18.5 line 630).
//
// Wraps `@cyclonedx/cyclonedx-npm` to emit a CycloneDX 1.5 JSON
// document at `dist/sbom.cdx.json`. One SBOM per release covers the
// whole matrix because the dependency graph is identical across
// targets — Bun bundles the same JS for every platform; what differs
// is the embedded runtime, which CycloneDX captures as a separate
// component (the `bun` engine field in `package.json`).
//
// The cyclonedx-npm CLI is consumed via `bunx`; no global install
// needed. We pin the exact version so SBOMs are reproducible.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CYCLONEDX_NPM_VERSION = '2.0.1';

export interface GenerateOptions {
  distDir: string;
  // Test seam.
  spawn?: (cmd: string, args: readonly string[]) => { status: number | null; stderr?: string };
}

const defaultSpawn = (
  cmd: string,
  args: readonly string[],
): { status: number | null; stderr?: string } => {
  const r = spawnSync(cmd, [...args], { stdio: 'inherit' });
  return { status: r.status };
};

export const generateSbom = (opts: GenerateOptions): { path: string } => {
  if (!existsSync(opts.distDir)) mkdirSync(opts.distDir, { recursive: true });
  const out = join(opts.distDir, 'sbom.cdx.json');
  const args = [
    `@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM_VERSION}`,
    '--output-format',
    'JSON',
    '--output-file',
    out,
    // Forja is the published artifact; deps already live in the
    // bundle, so the omit list keeps devDeps off the SBOM.
    '--omit',
    'dev',
    '--spec-version',
    '1.5',
    'package.json',
  ];
  const spawn = opts.spawn ?? defaultSpawn;
  const { status } = spawn('bunx', args);
  if (status !== 0) {
    throw new Error(`cyclonedx-npm exited with ${status}`);
  }
  return { path: out };
};

// Read the generated SBOM and surface a one-line summary on stdout
// so a CI log can be scanned without opening the JSON. Validates
// shape minimally — full schema validation belongs to a downstream
// policy controller, not here.
export const summarize = (sbomPath: string): string => {
  const raw = readFileSync(sbomPath, 'utf-8');
  const doc = JSON.parse(raw) as {
    bomFormat?: string;
    specVersion?: string;
    components?: unknown[];
  };
  if (doc.bomFormat !== 'CycloneDX') {
    throw new Error(`SBOM at ${sbomPath} is not CycloneDX (bomFormat=${doc.bomFormat})`);
  }
  const componentCount = Array.isArray(doc.components) ? doc.components.length : 0;
  return `CycloneDX ${doc.specVersion} — ${componentCount} component(s) at ${sbomPath}`;
};

const parseFlag = (argv: readonly string[], name: string, dflt: string): string => {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return dflt;
};

const main = (): void => {
  const argv = process.argv.slice(2);
  const distDir = parseFlag(argv, 'dist', 'dist');
  const { path } = generateSbom({ distDir });
  process.stdout.write(`${summarize(path)}\n`);
};

if (import.meta.main) main();
