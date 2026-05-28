import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWrite } from './atomic.ts';
import { seedManifestPath } from './paths.ts';
import type { ScopeRoots } from './paths.ts';

// Seed-install manifest (spec MEMORY.md §5.7.5).
//
// Persisted shape (JSON, at `<user>/seeds/.installed.json`):
//
//   {
//     "<name>": { "version": "1.0", "hash": "<sha256-hex>" },
//     ...
//   }
//
// Stores the {version, hash} the installer wrote for each
// canonical seed. The upgrade lifecycle reads this on every boot
// to decide, per seed:
//
//   - fresh                       (file absent, no entry) → write
//   - unchanged                   (file hash == entry.hash, file version == entry.version) → skip
//   - vendor_updated_clean        (file hash == entry.hash, canonical version > entry.version) → silent rewrite + manifest update
//   - vendor_updated_conflict     (file hash != entry.hash, canonical version > entry.version) → KEEP USER + warn
//   - user_modified_no_update     (file hash != entry.hash, canonical version == entry.version) → preserve, no change
//
// Manifest entries with NO matching CANONICAL_SEEDS entry are
// archived (moved to `seeds/archived/`) and removed from the
// manifest — spec §5.7.5's "Seeds removidas no novo catálogo viram
// `seeds/archived/`, não delete (reversível)."
//
// Hashing uses node:crypto's SHA-256 over the raw file/canonical
// content (same byte-for-byte comparison the catalog tests use),
// matching the established pattern in trust-corpus.ts +
// memory-provenance.ts.

export interface SeedManifestEntry {
  version: string;
  hash: string;
}

export type SeedManifest = Record<string, SeedManifestEntry>;

// SHA-256 hex of the seed body bytes. Stable across platforms;
// CRLF/LF differences DO produce different hashes (intentional —
// the canonical content is LF, and an operator who normalizes to
// CRLF has effectively edited the file).
export const hashSeedContent = (content: string): string =>
  createHash('sha256').update(content, 'utf-8').digest('hex');

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

// Load the install manifest. Absent file → empty manifest (first
// run; the installer will populate it). Malformed JSON also
// collapses to empty, with a stderr warning: we don't want a
// corrupt manifest to gate the install — a fresh manifest is
// recoverable (just re-writes everything as `vendor_updated_clean`),
// while refusing to install means the operator loses seeds with
// no clear recovery path.
export const loadSeedManifest = (roots: ScopeRoots): SeedManifest => {
  const path = seedManifestPath(roots);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `forja: seed manifest at ${path} malformed (${msg}); treating as empty — vendor catalog will reinstall\n`,
    );
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const out: SeedManifest = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // Per-entry corruption: warn the operator naming the key
      // (slice-4 review fix #6). Without this, a hand-edited
      // manifest that introduces a malformed row silently routes
      // the seed through `user_kept` on the next boot and the
      // drift goes undiagnosed.
      process.stderr.write(
        `forja: seed manifest at ${path}: dropping entry ${JSON.stringify(key)} (value not a plain object)\n`,
      );
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.version !== 'string' || typeof v.hash !== 'string') {
      process.stderr.write(
        `forja: seed manifest at ${path}: dropping entry ${JSON.stringify(key)} (version/hash must be strings)\n`,
      );
      continue;
    }
    out[key] = { version: v.version, hash: v.hash };
  }
  return out;
};

// Atomic-write the manifest as canonical JSON (2-space indent,
// keys sorted for stable diffs across boots). Stable shape means
// a vendor-catalog-bump only touches the rows that actually
// changed, not unrelated entries reordered by JavaScript's
// insertion-order rules.
export const writeSeedManifest = (roots: ScopeRoots, manifest: SeedManifest): void => {
  const sortedKeys = Object.keys(manifest).sort();
  const ordered: SeedManifest = {};
  for (const k of sortedKeys) {
    const entry = manifest[k];
    if (entry !== undefined) ordered[k] = entry;
  }
  const json = `${JSON.stringify(ordered, null, 2)}\n`;
  atomicWrite(seedManifestPath(roots), json);
};
