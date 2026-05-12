// Slice 125 (R2 P0-5): fence test asserting the sandbox hide_paths
// list covers the home-rooted credential paths from
// `src/subagents/sensitive-paths.ts` (the worktree pre-spawn
// filter). Pre-slice the two lists drifted: `.git-credentials`
// was in SENSITIVE_PATH_DENY_LIST but missing from sandbox
// hide_paths, which meant a worktree-filtered subagent couldn't
// READ the file but a sandboxed bash process inside the agent
// COULD read it. This fence catches future drift loudly.
//
// Note: the two lists DO NOT have identical shapes (sensitive-
// paths uses glob patterns like `*.pem` for worktree filtering;
// sandbox hide_paths needs literal absolute mount targets). The
// fence asserts that the SUBSET of sensitive-paths entries that
// map to specific home-rooted dirs/files is covered by the
// sandbox lists.

import { describe, expect, test } from 'bun:test';
import { HIDE_PATHS_DIRS, HIDE_PATHS_FILES } from '../../src/permissions/sandbox-hide-paths.ts';
import { SENSITIVE_PATH_DENY_LIST } from '../../src/subagents/sensitive-paths.ts';

describe('sandbox-hide-paths content', () => {
  test('canonical §9 directories present', () => {
    expect(HIDE_PATHS_DIRS).toContain('.ssh');
    expect(HIDE_PATHS_DIRS).toContain('.aws');
    expect(HIDE_PATHS_DIRS).toContain('.config/gcloud');
    expect(HIDE_PATHS_DIRS).toContain('.gnupg');
    expect(HIDE_PATHS_DIRS).toContain('.kube');
  });

  test('canonical §9 files present', () => {
    expect(HIDE_PATHS_FILES).toContain('.netrc');
    expect(HIDE_PATHS_FILES).toContain('.docker/config.json');
    expect(HIDE_PATHS_FILES).toContain('.npmrc');
    expect(HIDE_PATHS_FILES).toContain('.pypirc');
  });

  // Slice 125 additions.
  test('slice 125 — cloud and secret-manager credential dirs', () => {
    expect(HIDE_PATHS_DIRS).toContain('.config/azure');
    expect(HIDE_PATHS_DIRS).toContain('.config/op');
    expect(HIDE_PATHS_DIRS).toContain('.config/sops');
    expect(HIDE_PATHS_DIRS).toContain('.terraform.d');
    expect(HIDE_PATHS_DIRS).toContain('.ansible');
  });

  test('slice 125 — Forja audit DB dir is hidden (sandboxed process cannot corrupt the hash chain)', () => {
    expect(HIDE_PATHS_DIRS).toContain('.local/share/forja');
  });

  test('slice 125 — .git-credentials file is hidden (was drift vs sensitive-paths)', () => {
    expect(HIDE_PATHS_FILES).toContain('.git-credentials');
  });

  test('no path appears in both DIRS and FILES (a mount can be one or the other, not both)', () => {
    const dirsSet = new Set(HIDE_PATHS_DIRS);
    for (const f of HIDE_PATHS_FILES) {
      expect(dirsSet.has(f)).toBe(false);
    }
  });
});

// Fence: every entry in SENSITIVE_PATH_DENY_LIST that names a
// specific home-rooted location (vs a glob pattern) MUST also be
// covered by sandbox hide_paths. This catches drift in either
// direction.
describe('sensitive-paths vs sandbox-hide-paths fence (slice 125)', () => {
  // Map of sensitive-paths entries to the sandbox-hide-paths
  // entry that should cover them. `null` means the pattern is too
  // glob-shaped to map to a specific mount (e.g., `*.pem` lives
  // anywhere). `undefined` means we forgot to map it — fence
  // makes that case fail loud.
  const expectedCoverage: Record<string, { kind: 'dir' | 'file' | 'unmappable'; target?: string }> =
    {
      // Project-relative env files (live in cwd, not home). Sandbox
      // cwd-rw profile gives the LLM access to cwd; hiding .env
      // would break legitimate config reads. Unmappable to home-
      // rooted hide_paths by design.
      '.env': { kind: 'unmappable' },
      '.env.*': { kind: 'unmappable' },
      '.envrc': { kind: 'unmappable' },
      // File patterns — pattern can be anywhere; not a specific mount.
      '*.pem': { kind: 'unmappable' },
      '*.key': { kind: 'unmappable' },
      '*.p12': { kind: 'unmappable' },
      '*.pfx': { kind: 'unmappable' },
      'id_rsa*': { kind: 'dir', target: '.ssh' },
      'id_ed25519*': { kind: 'dir', target: '.ssh' },
      'id_dsa*': { kind: 'dir', target: '.ssh' },
      'id_ecdsa*': { kind: 'dir', target: '.ssh' },
      // Directory globs already covered.
      '.ssh/**': { kind: 'dir', target: '.ssh' },
      '.gnupg/**': { kind: 'dir', target: '.gnupg' },
      // Specific files under directories already covered.
      '.aws/credentials': { kind: 'dir', target: '.aws' },
      '.aws/config': { kind: 'dir', target: '.aws' },
      // Specific files covered as hide_paths_files.
      '.netrc': { kind: 'file', target: '.netrc' },
      '.npmrc': { kind: 'file', target: '.npmrc' },
      '.pypirc': { kind: 'file', target: '.pypirc' },
      '.git-credentials': { kind: 'file', target: '.git-credentials' },
      // KeePassXC DB - pattern, lives anywhere.
      '*.kdbx': { kind: 'unmappable' },
      // Glob patterns for project-level secrets — unmappable.
      '**/credentials*.json': { kind: 'unmappable' },
      '**/secrets.yml': { kind: 'unmappable' },
      '**/secrets.yaml': { kind: 'unmappable' },
    };

  test('every sensitive-paths entry has an explicit fence mapping (catches new patterns without coverage)', () => {
    const missing: string[] = [];
    for (const pattern of SENSITIVE_PATH_DENY_LIST) {
      if (!(pattern in expectedCoverage)) {
        missing.push(pattern);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `New SENSITIVE_PATH_DENY_LIST entries lack fence-test mapping: ${missing.join(', ')}. Add them to expectedCoverage in this file with the right kind (dir/file/unmappable).`,
      );
    }
  });

  test('every fence-mapped dir target IS in HIDE_PATHS_DIRS', () => {
    const missing: string[] = [];
    for (const [_pattern, coverage] of Object.entries(expectedCoverage)) {
      if (coverage.kind === 'dir' && coverage.target !== undefined) {
        if (!HIDE_PATHS_DIRS.includes(coverage.target)) {
          missing.push(coverage.target);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every fence-mapped file target IS in HIDE_PATHS_FILES', () => {
    const missing: string[] = [];
    for (const [_pattern, coverage] of Object.entries(expectedCoverage)) {
      if (coverage.kind === 'file' && coverage.target !== undefined) {
        if (!HIDE_PATHS_FILES.includes(coverage.target)) {
          missing.push(coverage.target);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
