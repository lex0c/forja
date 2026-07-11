import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { CANONICAL_SEEDS, type CanonicalSeed } from '../cli/init-seeds/index.ts';
import { atomicWrite } from './atomic.ts';
import { INDEX_HEADER, serializeIndex } from './index-file.ts';
import type { ScopeRoots } from './paths.ts';
import {
  seedArchivedDir,
  seedArchivedFilePath,
  seedIndexFilePath,
  seedMemoryFilePath,
  seedsRoot,
} from './paths.ts';
import { isSeedDisabled, loadDisabledSeeds } from './seeds-disabled.ts';
import {
  hashSeedContent,
  loadSeedManifest,
  type SeedManifest,
  type SeedManifestEntry,
  writeSeedManifest,
} from './seeds-manifest.ts';
import type { IndexEntry } from './types.ts';

// Vendor seed catalog installer (spec MEMORY.md §5.7.4 + §5.7.5 + §5.7.8).
//
// Each boot reconciles three sources of truth:
//
//   1. The bundled `CANONICAL_SEEDS` (the catalog this binary
//      ships).
//   2. The on-disk bodies at `<user>/seeds/<name>.md`.
//   3. The install manifest at `<user>/seeds/.installed.json`,
//      recording the {version, hash} the installer last wrote
//      per seed.
//
// Per canonical seed, the installer picks one of five actions:
//
//   - `fresh`           — body absent, no manifest entry → write the
//                         canonical body and record the entry.
//   - `unchanged`       — body hash matches the manifest AND the
//                         canonical version equals the manifest's
//                         version → no disk write.
//   - `vendor_updated`  — body hash matches the manifest (user hasn't
//                         edited) AND the canonical version is newer
//                         than the manifest's → silent rewrite to the
//                         new canonical content + manifest bump. The
//                         operator gets the new vendor content for
//                         free.
//   - `user_kept`       — body hash diverges from the manifest (user
//                         hand-edited at some point). Whether or not
//                         the canonical version bumped, the on-disk
//                         body is preserved. Slice 5c will surface
//                         this as an interactive prompt
//                         (`[k]eep / [v]iew diff / [a]ccept / [m]erge`
//                         per spec §5.7.5); slice 4 shipped the
//                         conservative default — keep mine, log
//                         nothing extra — so operator customizations
//                         never silently regress on a vendor bump.
//
// Plus one orphan-disposal action for the inverse direction:
//
//   - `archived`        — a name in the prior manifest no longer has
//                         a matching CANONICAL_SEEDS entry. The body
//                         is moved to `<user>/seeds/archived/<name>.md`
//                         (spec §5.7.5: "Seeds removidas no novo
//                         catálogo viram `seeds/archived/`, não delete
//                         (reversível)."). The manifest row is dropped.
//                         If the operator had already deleted the
//                         body, no archive happens — the manifest
//                         row is still removed.
//
// At the end, the install manifest is rewritten with the new
// {version, hash} for every seed left active (fresh + unchanged +
// vendor_updated + user_kept). Archived seeds drop out. The index
// at `seeds/MEMORY.md` is regenerated from the active set so the
// loader sees exactly the seeds the operator can read today.
//
// Atomic write semantics mirror `src/memory/atomic.ts`:
// write-to-temp → rename, so a crash mid-install leaves either
// the old file or the new — never a half-written body.

export interface InstallVendorSeedsOptions {
  roots: ScopeRoots;
  // Test seam: override the canonical catalog. Production callers
  // pass `undefined` to get `CANONICAL_SEEDS`. Pinning the source
  // explicitly keeps the regression tests deterministic without
  // touching the global catalog.
  source?: ReadonlyArray<CanonicalSeed>;
  // Test seam: override the timestamp used for archive filenames
  // (`<archived>/<name>.<ts>.md`). Production callers omit so each
  // boot picks the current `Date.now()`; tests inject monotonic
  // values to exercise the two-archives-of-the-same-name case.
  now?: () => number;
}

export type SeedAction =
  | 'fresh'
  | 'unchanged'
  | 'vendor_updated'
  | 'user_kept'
  | 'archived'
  | 'disabled';

export interface SeedsInstallResult {
  // Bodies written for the first time (no prior manifest entry).
  fresh: string[];
  // Bodies skipped because the on-disk hash + version match the
  // manifest exactly.
  unchanged: string[];
  // Bodies silently rewritten with new canonical content because
  // the user hadn't edited them and the catalog's version bumped.
  vendorUpdated: string[];
  // Bodies preserved as-is because the user hand-edited them
  // (with or without a vendor bump on top).
  userKept: string[];
  // Names archived from the prior catalog (no longer in
  // CANONICAL_SEEDS). Bodies, if present, moved to
  // `<user>/seeds/archived/<name>.md`.
  archived: string[];
  // Names skipped because the operator added an opt-out sentinel
  // (spec §5.7.6 — `<user>/seeds/.disabled.json`). Body on disk is
  // untouched (preserved verbatim for a future `enable`), the prior
  // manifest entry is preserved, and the entry is excluded from the
  // regenerated index — so the model never sees these seeds in the
  // assembled system prompt. Survives a vendor catalog bump (sentinel
  // is honored BEFORE the state-machine branches, so the opt-out
  // doesn't regress on an upgrade).
  disabled: string[];
  // Absolute path to the regenerated `seeds/MEMORY.md`.
  indexPath: string;
}

// Archive a single seed body. Returns the timestamped destination
// filename (relative to archived/) when the move happened, or null
// when there was no body to archive (operator pre-deleted). The
// timestamp lets the second archival of the same name land at a
// distinct path — spec §5.7.5's "reversível" promise is broken if
// `<archived>/<name>.md` silently overwrites a prior archive (a
// real risk on catalog reintroduce → operator-restore-and-edit →
// catalog-drops-again loops).
const archiveSeed = (roots: ScopeRoots, name: string, ts: number): string | null => {
  const live = seedMemoryFilePath(roots, name);
  if (!existsSync(live)) return null;
  const dest = seedArchivedFilePath(roots, name, ts);
  mkdirSync(seedArchivedDir(roots), { recursive: true });
  renameSync(live, dest);
  return `${name}.${ts}.md`;
};

export const installVendorSeeds = (opts: InstallVendorSeedsOptions): SeedsInstallResult => {
  const source = opts.source ?? CANONICAL_SEEDS;
  const nowFn = opts.now ?? Date.now;
  const dir = seedsRoot(opts.roots);
  mkdirSync(dir, { recursive: true });

  const oldManifest = loadSeedManifest(opts.roots);
  const newManifest: SeedManifest = {};
  // Load the opt-out sentinel once per install pass. Reading inside
  // the per-seed loop would re-parse + re-validate N times for no
  // benefit; the sentinel is a single small JSON file.
  const disabledSentinel = loadDisabledSeeds(opts.roots);

  const fresh: string[] = [];
  const unchanged: string[] = [];
  const vendorUpdated: string[] = [];
  const userKept: string[] = [];
  const archived: string[] = [];
  const disabled: string[] = [];

  // Track which names the canonical catalog covers so we can
  // detect orphans in the prior manifest below.
  const canonicalNames = new Set<string>();

  for (const seed of source) {
    canonicalNames.add(seed.name);

    // seedMemoryFilePath revalidates the name + applies the
    // <user>/seeds/ sandbox check, so even a corrupt build that
    // shipped a CANONICAL_SEEDS entry with a bad name would refuse
    // at this gate instead of writing somewhere unexpected.
    const target = seedMemoryFilePath(opts.roots, seed.name);
    const canonicalHash = hashSeedContent(seed.content);
    const newEntry: SeedManifestEntry = {
      version: seed.version,
      hash: canonicalHash,
    };

    const prior = oldManifest[seed.name];

    // Opt-out sentinel takes precedence over every state-machine
    // branch (spec §5.7.6). Disabled seeds do NOT have their body
    // touched, do NOT get a manifest entry refresh (the prior row
    // is preserved verbatim so a later `enable` resumes from the
    // same baseline), and do NOT enter the regenerated index. This
    // means the model never sees the body in the assembled prompt,
    // and a future vendor bump can't silently override the opt-out
    // by routing through `vendor_updated`.
    if (isSeedDisabled(disabledSentinel, seed.name)) {
      disabled.push(seed.filename);
      if (prior !== undefined) {
        newManifest[seed.name] = prior;
      }
      continue;
    }

    if (!existsSync(target)) {
      // No body on disk. If a prior manifest entry exists the
      // operator deleted the body manually; respect that as the
      // implicit-suppression path — it predates the slice-5b
      // explicit sentinel (above) but the conservative "don't
      // reinstall" outcome stays the same. `fresh` only fires when
      // both the body AND the manifest say "absent". The slash
      // `enable` command intentionally clears the prior manifest
      // entry when the body is absent at re-enable time, so this
      // branch never silently overrides an `enable` intent.
      if (prior === undefined) {
        atomicWrite(target, seed.content);
        fresh.push(seed.filename);
        newManifest[seed.name] = newEntry;
      } else {
        // Operator-deleted body. Don't reinstall (would fight the
        // operator); don't archive (no body to archive). Preserve
        // the prior manifest row so the slice-5b explicit-sentinel
        // path (above) can detect the historic suppression. The
        // active index regenerated below SHOULD skip these — see
        // the existsSync filter in the regen loop.
        newManifest[seed.name] = prior;
        userKept.push(seed.filename);
      }
      continue;
    }

    // Body present. Hash it once and decide the branch.
    const onDisk = readFileSync(target, 'utf-8');
    const onDiskHash = hashSeedContent(onDisk);

    if (prior !== undefined && onDiskHash === prior.hash) {
      // User hasn't edited since the last install — safe to apply
      // a vendor bump if any.
      if (prior.version === newEntry.version && onDiskHash === canonicalHash) {
        // Same version, same content — nothing to do.
        unchanged.push(seed.filename);
        newManifest[seed.name] = newEntry;
      } else {
        // Vendor bumped (version differs) OR the manifest was
        // missing a fresh hash (e.g. operator hand-edited the
        // manifest). Either way, the user hasn't touched the
        // body, so applying the new canonical content is safe
        // and matches the spec's "User não editou (hash bate):
        // atualiza silenciosamente" path.
        atomicWrite(target, seed.content);
        vendorUpdated.push(seed.filename);
        newManifest[seed.name] = newEntry;
      }
      continue;
    }

    // User-modified body. Preserve verbatim. The manifest row keeps
    // the OLD {version, hash} so a future bump still sees the
    // divergence and re-routes to user_kept (or, slice 5c, an
    // interactive prompt). Refreshing the hash here would silently
    // bless the user's edit as the new baseline and lose the
    // conflict signal on the next vendor bump.
    // INVARIANT: this branch is the natural loop tail. Every prior
    // state branch (`fresh`/`unchanged`/`vendor_updated`/operator-
    // deleted-user_kept) terminates with an explicit `continue`. A
    // future maintainer adding state-machine logic AFTER this block
    // must either add it BEFORE the user-modified branch or add an
    // explicit `continue;` here first (slice-4 review fix #4 —
    // Biome's noUnnecessaryContinue rule rejects a defensive continue
    // at the loop tail, so the invariant lives in this comment).
    userKept.push(seed.filename);
    if (prior !== undefined) {
      newManifest[seed.name] = prior;
    } else {
      // No prior manifest but a body on disk that doesn't match
      // canonical (e.g., operator pre-populated the file). Record
      // the on-disk hash so future re-runs see "unchanged" until
      // either the operator edits again or the vendor bumps.
      newManifest[seed.name] = { version: newEntry.version, hash: onDiskHash };
    }
  }

  // Archive any prior-manifest entries the new catalog dropped.
  // Iterate the OLD manifest because that's the authoritative
  // record of "what we installed last time"; an orphan body with
  // no manifest entry is operator-authored and out of scope here
  // (the seeds-subdir orphan walker in slice 2 already surfaces
  // it for /memory list).
  for (const [name, _entry] of Object.entries(oldManifest)) {
    if (canonicalNames.has(name)) continue;
    // Defense-in-depth: `loadSeedManifest` already drops invalid-
    // name keys with an stderr warn, so by construction every name
    // reaching this point passes `validateName`. The try/catch
    // exists for the case where a future refactor loosens the
    // loader's validation (or a different caller bypasses it) —
    // without it, an unexpected invalid name would throw in
    // `seedMemoryFilePath` and abort the install before the
    // self-healing `writeSeedManifest` below could run. Skipping
    // here preserves the "manifest writes always happen at the end
    // of the pass" invariant.
    try {
      const archivedAs = archiveSeed(opts.roots, name, nowFn());
      if (archivedAs !== null) archived.push(archivedAs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `forja: seed installer: skipping orphan archive for ${JSON.stringify(name)} (${msg}); the manifest rewrite below drops it\n`,
      );
    }
    // newManifest deliberately omits this entry — the seed is
    // gone from the canonical pack.
  }

  writeSeedManifest(opts.roots, newManifest);

  // Regenerate seeds/MEMORY.md from the ACTIVE set (canonical
  // seeds whose body the operator hasn't suppressed). Operator-
  // deleted seeds (manifest row preserved, body absent) drop out
  // of the index so /memory list doesn't advertise something the
  // loader would return 'missing' for. Disabled seeds also drop
  // out — the opt-out semantic is "model doesn't see this body",
  // so listing it would defeat the purpose. The filter mirrors the
  // newManifest membership for these names (we kept the row to
  // signal suppression but the index gates on body presence + not
  // being in the disabled sentinel).
  const entries: IndexEntry[] = [];
  for (const seed of source) {
    if (isSeedDisabled(disabledSentinel, seed.name)) continue;
    const target = seedMemoryFilePath(opts.roots, seed.name);
    if (!existsSync(target)) continue;
    entries.push({
      title: seed.name,
      href: seed.filename,
      hook: seed.description,
    });
  }
  const serialized = serializeIndex(entries, { header: INDEX_HEADER });
  const indexPath = seedIndexFilePath(opts.roots);
  atomicWrite(indexPath, serialized.text);

  return { fresh, unchanged, vendorUpdated, userKept, archived, disabled, indexPath };
};
