// Build-target table consumed by every script under scripts/. The
// release pipeline (cross-platform matrix, size gate, checksums,
// reproducible build, SBOM, install script, UPX compress) all need
// to agree on:
//
//   - the canonical target id (drives `--target=` and asset names),
//   - the size budget (PERFORMANCE.md §18.2),
//   - the executable extension (Windows is the only deviation).
//
// Single source of truth — adding a target means editing this file
// and re-running `bun test scripts/`.

export interface BuildTarget {
  // Canonical id used in asset filenames and as the suffix of
  // `dist/forja-<id>`. Stable; do not rename without bumping the
  // install script's lookup table.
  readonly id: string;
  // Bun --compile target. Bun's matrix is more granular than
  // ours (modern vs baseline x64); we pin -modern because the size
  // budget only fits the modern subset and the baseline variant is
  // a niche fallback we don't ship by default.
  readonly bunTarget: string;
  // Size budget in MiB from PERFORMANCE.md §18.2. Hitting the budget
  // emits a warning; +20% blocks the release.
  readonly sizeMaxMiB: number;
  // Extension appended to the produced binary. Windows is `.exe`;
  // every other platform is empty.
  readonly ext: '' | '.exe';
  // OS / arch tuple used by install.sh to pick the right asset for
  // `uname -s` / `uname -m`. The script normalizes case-insensitive.
  readonly os: 'linux' | 'darwin' | 'windows';
  readonly arch: 'x64' | 'arm64';
}

export const TARGETS: readonly BuildTarget[] = [
  {
    id: 'linux-x64',
    bunTarget: 'bun-linux-x64-modern',
    sizeMaxMiB: 110,
    ext: '',
    os: 'linux',
    arch: 'x64',
  },
  {
    id: 'linux-arm64',
    bunTarget: 'bun-linux-arm64',
    sizeMaxMiB: 110,
    ext: '',
    os: 'linux',
    arch: 'arm64',
  },
  {
    id: 'darwin-x64',
    bunTarget: 'bun-darwin-x64',
    sizeMaxMiB: 75,
    ext: '',
    os: 'darwin',
    arch: 'x64',
  },
  {
    id: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    sizeMaxMiB: 70,
    ext: '',
    os: 'darwin',
    arch: 'arm64',
  },
  {
    id: 'windows-x64',
    bunTarget: 'bun-windows-x64-modern',
    sizeMaxMiB: 125,
    ext: '.exe',
    os: 'windows',
    arch: 'x64',
  },
];

// Shared size-gate constant: anything strictly above
// `sizeMaxMiB * BLOCK_RATIO` blocks the release. Anything between
// `sizeMaxMiB` and the block threshold emits a warning. Below
// budget is silent. PERFORMANCE.md §18.2 specifies +20%.
export const SIZE_BLOCK_RATIO = 1.2;

export const findTarget = (id: string): BuildTarget | undefined => TARGETS.find((t) => t.id === id);

export const assetName = (t: BuildTarget): string => `forja-${t.id}${t.ext}`;
