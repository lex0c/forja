import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_SLUG } from './refresh.ts';

// How the running binary was installed. Drives which copy-pasteable update
// command the passive notice shows (SECURITY_GUIDELINE §11.4) — this is NOT a
// self-update strategy. The `forja update` subcommand (§11.1-11.3) stays a
// future design-target; here we only pick the right command to print so the
// operator runs the verified install.sh / npm channel themselves.
export type InstallOrigin = 'npm' | 'standalone';

// npm installs place the compiled binary under the per-platform package
// `node_modules/@lex0c/forja-<target>/bin/` (PERFORMANCE §18.6) — the launcher
// spawns it via `require.resolve('@lex0c/forja-<target>/bin/forja')`, so the
// running binary's own path sits under this marker. A self-replace there would
// break require.resolve, so npm updates go through the package manager.
const NPM_PATH_MARKER = '/node_modules/@lex0c/';

// Detect how the running binary was installed from its own path. Anything not
// positively under the npm package tree is `standalone`: install.sh or a direct
// asset download. That's the safe default — install.sh replaces the binary in
// place regardless of the exact origin, so we never suggest the wrong manager.
export const detectInstallOrigin = (execPath: string = process.execPath): InstallOrigin => {
  // Normalize Windows separators so the marker matches on every platform —
  // split/join, not a regex (no backslash-class escaping to get wrong).
  const normalized = execPath.split('\\').join('/');
  return normalized.includes(NPM_PATH_MARKER) ? 'npm' : 'standalone';
};

// The npm scope/name — distinct from the GitHub owner/repo slug even though both
// read `lex0c/forja` (one addresses the package registry, the other the repo).
const NPM_PACKAGE = '@lex0c/forja';
const INSTALL_SH_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;
// Human-facing releases page — the cross-platform fallback. On stock Windows
// (cmd/PowerShell) there is no POSIX `sh`, so the curl one-liner is unrunnable;
// a URL opens on every platform.
const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases/latest`;

// install.sh's own default prefix: `PREFIX=${FORJA_PREFIX:-$HOME/.local/bin}`.
const defaultPrefix = (): string => join(homedir(), '.local', 'bin');

// POSIX single-quote a path for safe interpolation into the shell hint: wrap in
// single quotes and rewrite each embedded `'` as `'\''`. Handles spaces and
// shell metacharacters in a custom prefix.
const shellSingleQuote = (s: string): string => `'${s.split("'").join("'\\''")}'`;

// The copy-pasteable update command (or, on stock Windows, an openable URL) for
// the notice, tailored to origin + platform + install location:
//   npm        → hand off to the package manager, PINNED to the announced
//                version (§11.1 `npm i -g @lex0c/forja@<versão>`); cross-platform.
//   standalone → re-run the verified install.sh one-liner (§11.4), EXCEPT on
//                stock Windows where there's no `sh` → the releases page URL.
//                A custom-prefix install gets `--prefix <its dir>` so the running
//                binary is replaced in place, not duplicated at ~/.local/bin.
// install.sh resolves the latest tag itself (no per-tag `v` prefix to
// reconstruct here); only the npm channel, where the version is unambiguous, is
// pinned to the announced release.
export const updateCommand = (
  origin: InstallOrigin,
  version: string,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (origin === 'npm') return `npm i -g ${NPM_PACKAGE}@${version}`;
  if (platform === 'win32') return RELEASES_PAGE_URL;
  const base = `curl -fsSL ${INSTALL_SH_URL} | sh`;
  const prefix = dirname(execPath);
  return prefix === defaultPrefix() ? base : `${base} -s -- --prefix ${shellSingleQuote(prefix)}`;
};
