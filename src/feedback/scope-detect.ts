// Scope chain detection for FEEDBACK_ADAPTATION dispatch rewrite.
//
// Slice 3.5b shipped the resolver with a degenerate chain:
//   - repo:     config.cwd (literal, no normalization)
//   - user:     'global'   (hardcoded — multi-user host shares policies)
//   - language: 'unknown'  (no detection — language-scope policies inert)
//
// This module computes proper values from the operator's environment:
//
// Normalization is deliberate-but-conservative:
//   - `normalizeRepoScope` resolves to an absolute path and strips
//     a single trailing slash. Symlinks are NOT resolved (operator
//     might use a symlinked working directory intentionally; calling
//     realpath would surprise them on every cd).
//   - `detectUserScope` uses os.userInfo().username and falls back
//     to process.env.USER (or 'unknown' if both fail). Excludes the
//     hostname — operators on the same machine but different logins
//     legitimately want different adaptation profiles.
//   - `detectLanguageScope` probes the repo root for marker files
//     in a precedence order designed to match the OPERATOR'S
//     primary intent (e.g., a polyglot repo with both package.json
//     and pyproject.toml is detected as 'typescript' because TS
//     adaptation policies usually want to fire on JS-shaped bash
//     calls; ties are operator decisions, not detector ones).

import { existsSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

// Strip a single trailing slash (drops `/repo/foo/` → `/repo/foo`).
// Repeated slashes inside the path are NOT collapsed — operators
// who hand-type a path with `//` might be in a UNC-shape or a
// purposefully odd shape; we leave it. The dominant case (cd into
// the repo, harness gets the trailing slash) is what this normalizes.
const stripTrailingSlash = (s: string): string => {
  if (s.length > 1 && s.endsWith('/')) return s.slice(0, -1);
  return s;
};

// Resolve cwd to an absolute path + strip trailing slash. The
// resolver query is exact-match, so any inconsistency in scope_id
// across sessions means a previously-promoted policy doesn't fire.
// `path.resolve` handles `./relative` paths and normalizes `..`
// segments; we don't go further (no realpath) because symlinks may
// be intentional.
export const normalizeRepoScope = (cwd: string): string => {
  if (cwd.length === 0) return 'unknown';
  return stripTrailingSlash(resolve(cwd));
};

// Detect the OS user. Used as the `user` scope_id. Falls through
// gracefully — a headless environment with no UID info would
// otherwise refuse to write user-scope policies entirely.
export const detectUserScope = (): string => {
  try {
    const info = userInfo();
    if (info.username !== '' && info.username !== 'unknown') return info.username;
  } catch {
    // userInfo throws on some pseudo-platforms (containers without
    // /etc/passwd). Fall through to env.
  }
  const envUser = process.env.USER ?? process.env.USERNAME;
  if (envUser !== undefined && envUser.length > 0) return envUser;
  // Last resort: hostname so per-host policies still work even
  // when the user identity is unrecoverable.
  try {
    const host = hostname();
    if (host.length > 0) return `host:${host}`;
  } catch {
    // unreachable on all supported platforms but defensive
  }
  return 'unknown';
};

// Language detection by marker-file probe at the repo root. The
// order encodes operator-bias: TS/JS first because Forja's own
// primary use case is JS-shaped repos; Python second because it's
// the second-largest user base; Rust + Go follow. Polyglot repos
// resolve to whichever marker comes FIRST — operators with mixed
// stacks can override via a future per-repo TOML config.
const LANGUAGE_MARKERS: { marker: string; language: string }[] = [
  { marker: 'package.json', language: 'typescript' },
  { marker: 'pyproject.toml', language: 'python' },
  { marker: 'setup.py', language: 'python' },
  { marker: 'Cargo.toml', language: 'rust' },
  { marker: 'go.mod', language: 'go' },
  { marker: 'pom.xml', language: 'java' },
  { marker: 'build.gradle', language: 'java' },
  { marker: 'build.gradle.kts', language: 'kotlin' },
  { marker: 'Gemfile', language: 'ruby' },
  { marker: 'composer.json', language: 'php' },
];

export const detectLanguageScope = (repoCwd: string): string => {
  if (repoCwd.length === 0) return 'unknown';
  const resolved = resolve(repoCwd);
  for (const { marker, language } of LANGUAGE_MARKERS) {
    try {
      if (existsSync(join(resolved, marker))) return language;
    } catch {
      // path lookup failed — try the next marker rather than
      // bailing the whole detection.
    }
  }
  return 'unknown';
};

// Convenience: compute the full scope chain for the current
// harness context. Caller (loop.ts) passes the session id and the
// repo cwd; user/language/normalize derive from environment.
export interface BuildScopeChainInput {
  sessionId: string;
  repoCwd: string;
}

export interface BuiltScopeChain {
  session: string;
  repo: string;
  user: string;
  language: string;
}

export const buildScopeChain = (input: BuildScopeChainInput): BuiltScopeChain => ({
  session: input.sessionId,
  repo: normalizeRepoScope(input.repoCwd),
  user: detectUserScope(),
  language: detectLanguageScope(input.repoCwd),
});

export { LANGUAGE_MARKERS };
