// Sensitive path deny-list per SECURITY_GUIDELINE.md §8.4. The
// canonical home for the patterns + matcher used by both the
// permission engine (slice 159 — wired into checkPath + bash
// capability loop as an engine-floor refuse) AND the subagent
// worktree pre-spawn filter (the original consumer; sensitive
// files in a worktree refuse the subagent spawn entirely).
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
//     Spec §8.4 defines this set explicitly; the patterns are
//     name-shape, not path-prefix.
//
// Pre-slice the matcher lived under `src/subagents/` because the
// first consumer was the worktree filter. Slice 159 promotes it to
// `src/permissions/` as the canonical home; `src/subagents/
// sensitive-paths.ts` is a re-export shim for backward compat.

import { Glob } from 'bun';

// Canonical patterns from SECURITY_GUIDELINE.md §8.4. Mirror the
// spec verbatim so a diff against the doc reads cleanly.
//
// Two normalization choices baked in:
//   1. Patterns without a leading `**/` are evaluated at any
//      depth as well as at the worktree root. A `.env` committed
//      to a subdirectory is no less sensitive than one at the
//      root, and a deny-list that only fires on root paths would
//      give false confidence. Spec is silent on root vs any-depth
//      so we choose the safer interpretation.
//   2. Directory patterns end with `/**` so contents match. The
//      spec writes `.ssh/` (trailing slash, conventional shell
//      shorthand for "the directory and its contents"); Glob
//      semantics need the explicit recursive form.
//
// Anything added here MUST also be added to the spec — patterns
// drift between code and doc is the kind of policy bug §8.4
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
  // Slice 180 (review — sensitive-path gap). Tool-specific
  // credential files that share the shape of `.netrc` /
  // `.aws/credentials` (well-known location, plain-text or
  // base64'd credentials on disk):
  //   `.terraformrc` — Terraform CLI config with `credentials`
  //       blocks for Terraform Cloud / Enterprise.
  //   `.dockercfg` — legacy Docker auth file (pre-`.docker/config.json`).
  //   `.pgpass` — Postgres password file, netrc-shaped (`host:port:db:user:pass`).
  //   `.my.cnf` — MySQL client config with `[client] password=` blocks.
  //   `.mongorc.js` — MongoDB shell init; commonly carries
  //       connection strings with password embedded.
  //   `**/.htpasswd` — Apache basic-auth password file.
  //   `**/Charles.cer` / `**/charles-proxy.pem` — proxy MITM certs
  //       (not credentials, but reading them confirms an attacker
  //       MITM is in place).
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
//     the gate; see normalization choice 1 above)
//
// The path is normalized to forward slashes and stripped of any
// leading `./` so callers can pass either fs-style or git-style
// relative paths. Absolute paths are accepted too — the
// `**/<pattern>` fallback handles them because `**` spans path
// segments in Bun's Glob (matches any number of `/`-separated
// components).
//
// Slice 159 (self-review): the engine wire moved this matcher into
// the hot path (every fs-tool call + every bash bypass-mode capability).
// Pre-slice the only caller was the worktree pre-spawn filter (once
// per subagent), so building `new Glob(pattern)` inside the loop on
// every call was free. Post-slice the same 23 patterns × 2 forms =
// up to 46 Glob constructions per fs check, which is a measurable
// hot-path tax. Memoize the compiled Globs at module scope, keyed
// by the literal pattern string. Default `SENSITIVE_PATH_DENY_LIST`
// patterns warm the cache on first call; custom-pattern callers
// (worktree's `opts.denyListPatterns`) hit the same cache when their
// strings overlap (typical). Pattern strings are short, the cache
// stays bounded by the union of all distinct patterns the process
// ever sees — for realistic workloads under ~50 entries. Slice 161
// will memoize the broader `matcher.ts` Glob churn; this local
// cache addresses the §8.4 wire's regression risk now so slice 159
// doesn't regress the budget while waiting for slice 161 to land.
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
