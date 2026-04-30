// Sensitive path deny-list (spec §8.4). Lives under `subagents/`
// because the first consumer is the worktree pre-spawn filter
// (4.2b.iii). Future consumers — `read_file` / `write_file`
// runtime checks (§8.4 points 1 and 2) — will import the same
// constant and matcher to keep one source of truth for what
// counts as "sensitive". When that wiring lands, this file may
// migrate to `src/security/` or similar; the patterns and the
// matcher API stay stable.

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
// relative paths.
export const matchSensitivePath = (
  relPath: string,
  patterns: readonly string[] = SENSITIVE_PATH_DENY_LIST,
): string | null => {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const pattern of patterns) {
    if (new Glob(pattern).match(normalized)) return pattern;
    if (!pattern.startsWith('**/') && new Glob(`**/${pattern}`).match(normalized)) {
      return pattern;
    }
  }
  return null;
};
