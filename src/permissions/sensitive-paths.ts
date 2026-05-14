// Sensitive path deny-list. Canonical home for the patterns +
// matcher used by both the permission engine (wired into
// checkPath + bash capability loop as an engine-floor refuse) AND
// the subagent worktree pre-spawn filter (sensitive files in a
// worktree refuse the subagent spawn entirely).
//
// "Engine-floor refuse" means: this defense fires BEFORE policy
// lookup. No operator policy (`allow_paths: ['**']`, session
// grants, etc.) can widen access to these paths. Same posture as
// `HARD_REFUSE_COMMANDS` in the bash resolver — by design,
// outside the operator's policy surface.
//
// Why this is a separate layer from `protected_paths.ts`:
//   - `protected_paths` covers system roots (`/proc`, `/sys`, ...)
//     and absolute infrastructure paths whose membership is fixed
//     by the OS layout. It also classifies `escalate` vs `deny`
//     tiers that the engine routes through different decision
//     paths.
//   - `sensitive-paths` (this file) covers CONTENT-BASED secrets
//     (`.env*`, `*.pem`, `id_rsa*`, `*credentials*.json`, etc.)
//     that match by name regardless of location in the filesystem.
//     The patterns are name-shape, not path-prefix.

import { Glob } from 'bun';

// Canonical patterns. Mirror the spec verbatim so a diff against
// the doc reads cleanly.
//
// Two normalization choices baked in:
//   1. Patterns without a leading `**/` are evaluated at any
//      depth as well as at the worktree root. A `.env` committed
//      to a subdirectory is no less sensitive than one at the
//      root, and a deny-list that only fires on root paths would
//      give false confidence.
//   2. Directory patterns end with `/**` so contents match. The
//      conventional shorthand `.ssh/` (trailing slash, "the
//      directory and its contents") needs the explicit recursive
//      form for Glob semantics.
//
// Anything added here MUST also be added to the spec — pattern
// drift between code and doc is the kind of policy bug this list
// exists to prevent.
export const SENSITIVE_PATH_DENY_LIST: readonly string[] = [
  '.env',
  '.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  'id_dsa*',
  'id_ecdsa*',
  '.ssh/**',
  '.gnupg/**',
  '.aws/credentials',
  '.aws/config',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '*.kdbx',
  '**/credentials*.json',
  '**/secrets.yml',
  '**/secrets.yaml',
  '.git-credentials',
  // Tool-specific credential files (well-known location, plain-
  // text or base64'd credentials on disk):
  //   `.terraformrc` — Terraform CLI config with `credentials`
  //       blocks for Terraform Cloud / Enterprise.
  //   `.dockercfg` — legacy Docker auth file (pre-`.docker/config.json`).
  //   `.pgpass` — Postgres password file (`host:port:db:user:pass`).
  //   `.my.cnf` — MySQL client config with `[client] password=` blocks.
  //   `.mongorc.js` — MongoDB shell init; commonly carries
  //       connection strings with password embedded.
  //   `**/.htpasswd` — Apache basic-auth password file.
  '.terraformrc',
  '.dockercfg',
  '.pgpass',
  '.my.cnf',
  '.mongorc.js',
  '**/.htpasswd',
];

// Match a relative path against the deny-list. Returns the
// pattern that matched, or null. Two probes per pattern:
//   - exact match (handles anchored patterns like `.aws/credentials`
//     and explicit `**/secrets.yml`)
//   - `**/<pattern>` prefix (handles bare-name patterns like
//     `.env` or `*.pem` so a file in any subdirectory still trips
//     the gate)
//
// The path is normalized to forward slashes and stripped of any
// leading `./` so callers can pass either fs-style or git-style
// relative paths. Absolute paths are accepted too — the
// `**/<pattern>` fallback handles them because `**` spans path
// segments in Bun's Glob (matches any number of `/`-separated
// components).
//
// Globs are memoized at module scope: the engine wire calls this
// matcher in the hot path (every fs-tool call + every bash
// bypass-mode capability), so the 23 patterns × 2 forms (~46 Glob
// constructions per fs check) would be a measurable tax otherwise.
// Pattern strings are short and the cache stays bounded by the
// union of all distinct patterns the process ever sees (under
// ~50 entries for realistic workloads).
const globCache = new Map<string, Glob>();
const getGlob = (pattern: string): Glob => {
  let glob = globCache.get(pattern);
  if (glob === undefined) {
    glob = new Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob;
};

export const matchSensitivePath = (
  relPath: string,
  patterns: readonly string[] = SENSITIVE_PATH_DENY_LIST,
): string | null => {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const pattern of patterns) {
    if (getGlob(pattern).match(normalized)) return pattern;
    if (!pattern.startsWith('**/') && getGlob(`**/${pattern}`).match(normalized)) {
      return pattern;
    }
  }
  return null;
};
