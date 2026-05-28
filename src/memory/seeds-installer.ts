import { existsSync, mkdirSync } from 'node:fs';
import { CANONICAL_SEEDS, type CanonicalSeed } from '../cli/init-seeds/index.ts';
import { atomicWrite } from './atomic.ts';
import { INDEX_HEADER, serializeIndex } from './index-file.ts';
import { seedIndexFilePath, seedMemoryFilePath, seedsRoot } from './paths.ts';
import type { ScopeRoots } from './paths.ts';
import type { IndexEntry } from './types.ts';

// Vendor seed catalog installer (spec MEMORY.md §5.7.4 + §5.7.8).
//
// On first invocation the bootstrap calls `installVendorSeeds`
// which writes the bundled `CANONICAL_SEEDS` into the user scope's
// `seeds/` subdirectory and regenerates `seeds/MEMORY.md`. The
// install is idempotent: re-running skips any body that already
// exists on disk, so operator edits made between boots are
// preserved (spec §5.7.5 "preserva o que o user mexeu" — slice 4
// will land the full upgrade lifecycle with hash compare + diff
// prompts; this slice ships the conservative baseline).
//
// The `seeds/MEMORY.md` index is always rewritten from the
// canonical entries (mirroring the writer's invariant that
// MEMORY.md is canonical state owned by the agent, not operator-
// edited prose — see `index-file.ts:23-44`). If a future slice
// needs to preserve operator-curated index entries, this is the
// place to merge them.
//
// Atomic write semantics mirror `src/memory/writer.ts`:
// write-to-temp → rename, so a crash mid-install leaves either
// the old file or the new — never a half-written body.

export interface InstallVendorSeedsOptions {
  roots: ScopeRoots;
  // Test seam: override the canonical catalog. Production callers
  // pass `undefined` to get `CANONICAL_SEEDS`. Pinning the source
  // explicitly keeps the regression tests deterministic without
  // touching the global catalog.
  source?: ReadonlyArray<CanonicalSeed>;
}

export interface SeedsInstallResult {
  // Filenames written this run (file was absent before).
  wrote: string[];
  // Filenames skipped (file already existed; preserved verbatim).
  skipped: string[];
  // Absolute path to the regenerated `seeds/MEMORY.md`.
  indexPath: string;
}

export const installVendorSeeds = (opts: InstallVendorSeedsOptions): SeedsInstallResult => {
  const source = opts.source ?? CANONICAL_SEEDS;
  const dir = seedsRoot(opts.roots);
  mkdirSync(dir, { recursive: true });

  const wrote: string[] = [];
  const skipped: string[] = [];
  for (const seed of source) {
    // seedMemoryFilePath revalidates the name + applies the
    // <user>/seeds/ sandbox check, so even a corrupt build that
    // shipped a CANONICAL_SEEDS entry with a bad name would refuse
    // at this gate instead of writing somewhere unexpected.
    const target = seedMemoryFilePath(opts.roots, seed.name);
    if (existsSync(target)) {
      skipped.push(seed.filename);
      continue;
    }
    atomicWrite(target, seed.content);
    wrote.push(seed.filename);
  }

  // The index is regenerated whether or not any body was written.
  // The seeds-subdir MEMORY.md is canonical state owned by the
  // agent (spec §3.2 + analogy to skills/playbooks); the loader
  // uses it as the authoritative listing for what's installed.
  const entries: IndexEntry[] = source.map((seed) => ({
    title: seed.name,
    href: seed.filename,
    hook: seed.description,
  }));
  const serialized = serializeIndex(entries, { header: INDEX_HEADER });
  const indexPath = seedIndexFilePath(opts.roots);
  atomicWrite(indexPath, serialized.text);

  return { wrote, skipped, indexPath };
};
