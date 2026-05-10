// SHA256SUMS generator + verifier (SECURITY_GUIDELINE.md §7.2,
// PERFORMANCE.md §18.5).
//
// Output format follows GNU coreutils `sha256sum`:
//   <hex>  <filename>
// Two spaces, filename relative to the SHA256SUMS file. This is what
// `sha256sum -c SHA256SUMS` and `shasum -a 256 -c` consume natively,
// so the install script (Slice G) can rely on the host tool.
//
// Verbs:
//   bun run scripts/checksums.ts generate [--dist=...]
//   bun run scripts/checksums.ts verify   [--dist=...]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SBOM_FILENAME } from './sbom.ts';
import { TARGETS, assetName } from './targets.ts';

export const sha256File = (path: string): string => {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
};

export interface ChecksumEntry {
  filename: string;
  sha256: string;
}

export const formatSums = (entries: readonly ChecksumEntry[]): string => {
  // Stable order: alphabetical by filename. `sha256sum -c` doesn't
  // care, but a stable sort makes the file diffable across runs.
  const sorted = [...entries].sort((a, b) => a.filename.localeCompare(b.filename));
  const body = sorted.map((e) => `${e.sha256}  ${e.filename}`).join('\n');
  return `${body}\n`;
};

// Strict GNU sha256sum format: 64 lowercase hex + EXACTLY two spaces
// + filename whose first character is non-whitespace. Tabs, single
// space, three+ spaces, and leading whitespace in the filename group
// are all rejected so a malformed or hand-edited SUMS file fails
// closed at parse time instead of silently passing a defense-in-depth
// check downstream. `[ ]{2}` (over `  `) keeps the two-space
// separator explicit for readers and Biome's lint.
const SUMS_LINE = /^([0-9a-f]{64})[ ]{2}(\S.*)$/;

export const parseSums = (text: string): ChecksumEntry[] => {
  const out: ChecksumEntry[] = [];
  // Normalize CRLF to LF before splitting so a SUMS file produced on
  // Windows (or downloaded through a CRLF-introducing proxy) parses
  // identically. `trimEnd` further strips trailing whitespace
  // a stray editor might have left on a line.
  const normalized = text.replace(/\r\n/g, '\n');
  for (const raw of normalized.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const m = SUMS_LINE.exec(line);
    if (m === null) {
      throw new Error(`malformed SHA256SUMS line: ${line}`);
    }
    out.push({ sha256: m[1] as string, filename: m[2] as string });
  }
  return out;
};

// Files that should be checksummed if present in `dist/`. Allowlist
// (not denylist) so build droppings don't sneak in. The SBOM and
// per-target asset names are sourced from the modules that produce
// them — renaming the SBOM file or adding a target updates this
// predicate automatically. `.asc` / `.sig` are reserved for cosign
// or PGP detached signatures (Slice deferred); they still hit the
// `endsWith` excludes here so a future signature rolling out doesn't
// accidentally land in SHA256SUMS.
const isReleaseAsset = (name: string): boolean => {
  if (name === 'SHA256SUMS') return false;
  if (name.endsWith('.asc') || name.endsWith('.sig')) return false;
  if (name.endsWith('.map')) return false; // sourcemaps shipped separately
  if (name === SBOM_FILENAME) return true;
  for (const t of TARGETS) {
    if (name === assetName(t)) return true;
  }
  return false;
};

export const collectAssets = (distDir: string): string[] => {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir)
    .filter((n) => isReleaseAsset(n))
    .filter((n) => statSync(join(distDir, n)).isFile())
    .sort();
};

export const generate = (distDir: string): string => {
  const files = collectAssets(distDir);
  if (files.length === 0) {
    throw new Error(`no release assets under ${distDir}; build first`);
  }
  const entries: ChecksumEntry[] = files.map((filename) => ({
    filename,
    sha256: sha256File(join(distDir, filename)),
  }));
  const text = formatSums(entries);
  writeFileSync(join(distDir, 'SHA256SUMS'), text);
  return text;
};

export interface VerifyResult {
  ok: boolean;
  failed: { filename: string; expected: string; actual: string | null }[];
}

export const verify = (distDir: string): VerifyResult => {
  const sumsPath = join(distDir, 'SHA256SUMS');
  if (!existsSync(sumsPath)) {
    throw new Error(`SHA256SUMS missing in ${distDir}; run generate first`);
  }
  const entries = parseSums(readFileSync(sumsPath, 'utf-8'));
  const failed: VerifyResult['failed'] = [];
  for (const e of entries) {
    const path = join(distDir, e.filename);
    if (!existsSync(path)) {
      failed.push({ filename: e.filename, expected: e.sha256, actual: null });
      continue;
    }
    const actual = sha256File(path);
    if (actual !== e.sha256) {
      failed.push({ filename: e.filename, expected: e.sha256, actual });
    }
  }
  return { ok: failed.length === 0, failed };
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
  const verb = argv[0];
  const distDir = parseFlag(argv.slice(1), 'dist', 'dist');
  if (verb === 'generate') {
    const text = generate(distDir);
    process.stdout.write(`wrote ${join(distDir, 'SHA256SUMS')}\n`);
    process.stdout.write(text);
    return;
  }
  if (verb === 'verify') {
    const result = verify(distDir);
    if (result.ok) {
      process.stdout.write(`OK ${basename(distDir)}/SHA256SUMS\n`);
      return;
    }
    for (const f of result.failed) {
      process.stderr.write(
        `FAIL ${f.filename}: expected ${f.expected} got ${f.actual ?? '<missing>'}\n`,
      );
    }
    process.exit(1);
  }
  process.stderr.write('Usage: bun run scripts/checksums.ts {generate|verify} [--dist=<path>]\n');
  process.exit(2);
};

if (import.meta.main) main();
