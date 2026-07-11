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
import { createBoundedCache } from './bounded-cache.ts';

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
  // `*credentials*.json` (contains-match, not just a `credentials`-prefix)
  // mirrors SECURITY_GUIDELINE §8.4 and catches suffix forms like
  // `foo-credentials.json`; `*service-account*.json` /
  // `*-firebase-adminsdk-*.json` cover the GCP / Firebase service-account
  // key files that don't carry "credentials" in the name. The
  // `**/<pattern>` probe in matchSensitivePath makes these fire at any depth.
  '*credentials*.json',
  '*service-account*.json',
  '*-firebase-adminsdk-*.json',
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
  // Kubernetes / Docker-registry credentials (tokens, client certs/keys,
  // base64'd registry auth). `.dockercfg` above is the legacy form;
  // `.docker/config.json` is the modern one.
  '.kube/config',
  'kubeconfig',
  '.docker/config.json',
  // Mobile signing material + secret-bearing config:
  //   `*.jks` / `*.keystore` — Android signing keystores (private keys).
  //   `keystore.properties` — Android signing-store + key passwords.
  //   `local.properties` — Android; commonly holds `storePassword` /
  //       `keyPassword` (gitignored by convention for this reason).
  //   `*.p8` — Apple APNs / sign-in auth key (PKCS#8 private key).
  //   `*.mobileprovision` — iOS provisioning profile (signing identity).
  //   `google-services.json` / `GoogleService-Info.plist` — Firebase
  //       config carrying API keys.
  // Public-cert encodings (`*.crt`/`*.cer`/`*.der`) are deliberately NOT
  // here: they carry no private key (that lives in the `*.pem`/`*.key`/
  // `*.p12`/`*.pfx` files already on this list), and this is a hard,
  // un-overridable floor — blocking public certs would only break
  // legitimate reads with no secret-exposure gain.
  '*.jks',
  '*.keystore',
  'keystore.properties',
  'local.properties',
  '*.p8',
  '*.mobileprovision',
  'google-services.json',
  'GoogleService-Info.plist',
  // Bearer tokens / VPN profiles that embed key material:
  '*.jwt',
  '*.ovpn',
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
// bypass-mode capability), so the 25 patterns × 2 forms (~50 Glob
// constructions per fs check) would be a measurable tax otherwise.
// Cap 512 is a safety valve against a future surge in patterns or
// session-injected variants, not a design constraint on the policy
// size — realistic workloads stay well under 100 entries.
const SENSITIVE_PATH_CACHE_CAP = 512;
const globCache = createBoundedCache<string, Glob>(SENSITIVE_PATH_CACHE_CAP);
const getGlob = (pattern: string): Glob => {
  let glob = globCache.get(pattern);
  if (glob === undefined) {
    glob = new Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob;
};

// Case-insensitive match. The §8.4 deny-list is an engine-floor: it must
// hold on every platform the binary supports, and macOS APFS and Windows
// NTFS are case-insensitive by default. On those FSes `write_file('.ENV')`
// hits the same inode as `.env`; a case-sensitive matcher would have
// classified the call as non-sensitive and let it through under a
// permissive policy (`allow_paths: ['**']`). The realpath fallback in
// engine.checkPath canonicalizes the case ONLY when the target exists
// — for write-creates-new-file the matcher sees the raw input, so the
// matcher itself has to be case-insensitive.
//
// Both sides are lowercased: the input AND the pattern. Most patterns are
// authored lowercase, but not all (`GoogleService-Info.plist` is mixed
// case, the canonical iOS Firebase config name) — lowercasing only the
// input would silently kill the match for those, re-opening the very
// §8.4 bypass this is meant to close (and dropping the real-cased file's
// own protection in the bargain). The reported value is the ORIGINAL
// pattern string so callers/audit see the spec-faithful form. The cost
// is over-matching `MyFile.PEM` style names, the safe direction for a
// credential-shaped deny.
export const matchSensitivePath = (
  relPath: string,
  patterns: readonly string[] = SENSITIVE_PATH_DENY_LIST,
): string | null => {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  for (const pattern of patterns) {
    const lowered = pattern.toLowerCase();
    if (getGlob(lowered).match(normalized)) return pattern;
    if (!lowered.startsWith('**/') && getGlob(`**/${lowered}`).match(normalized)) {
      return pattern;
    }
  }
  return null;
};
