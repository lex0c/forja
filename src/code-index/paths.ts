import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Per-project code-index database paths (CODE_INDEX.md §2.1).
//
// Layout:
//   <data-root>/code-index/<sha256(project-root)>.db
//
// where <data-root> resolves through the standard XDG precedence
// (mirrors the sessions DB resolver in storage/paths.ts):
//   1. $XDG_DATA_HOME/agent/
//   2. ~/.local/share/agent/
//
// One DB per project root. Hashing the project root keeps file
// names operator-readable lengths AND avoids encoding-issue
// surprises (paths with `/` or `..` would otherwise trip the
// filename layer). Collisions are statistically negligible: SHA-256
// over distinct project root strings — birthday bound is ~2^128
// before collision becomes plausible.
//
// Project root resolution itself lives in `resolveProjectRoot`
// below. Tests use `defaultCodeIndexPath` directly with a known
// root for determinism; production always pairs the two.

// Resolve the data-root parent for the code-index DB. Each
// candidate (XDG_DATA_HOME, HOME, homedir()) is treated as
// "set" only if it's a non-empty absolute path — otherwise we
// fall through to the next candidate. An empty HOME on certain
// container/CI environments would previously be accepted, and
// `join('', ...)` produces a RELATIVE path; the DB then lands
// under the current working directory and silently scatters
// across runs that cd around. We throw when no candidate
// resolves rather than ever return a relative path.
const isUsableAbsolute = (s: string | null | undefined): s is string =>
  s !== null && s !== undefined && s.length > 0 && isAbsolute(s);

export const codeIndexDir = (env: NodeJS.ProcessEnv = process.env): string => {
  if (isUsableAbsolute(env.XDG_DATA_HOME)) {
    return join(env.XDG_DATA_HOME, 'agent', 'code-index');
  }
  const home = isUsableAbsolute(env.HOME) ? env.HOME : homedir();
  if (!isUsableAbsolute(home)) {
    throw new Error(
      'codeIndexDir: cannot resolve a stable user data directory — XDG_DATA_HOME, HOME, and os.homedir() all unset/empty/relative. Set XDG_DATA_HOME or HOME to an absolute path.',
    );
  }
  return join(home, '.local', 'share', 'agent', 'code-index');
};

// Hash the canonical project root path so the filename is fixed-length
// and filesystem-safe regardless of input. Hex SHA-256 is 64 chars;
// trim to 32 for filename brevity (still 128 bits of collision space —
// safe for the bounded operator-host scale).
const projectRootHash = (projectRoot: string): string =>
  createHash('sha256').update(projectRoot).digest('hex').slice(0, 32);

// Resolve the absolute path to the code-index DB for a given project
// root. Caller is responsible for canonicalizing `projectRoot`
// (e.g., via `git rev-parse --show-toplevel` upstream) — this helper
// doesn't realpath because (a) the path may not exist yet, and (b)
// the same project under different symlink names should resolve
// to the same DB, but that's the caller's contract.
//
// Throws when `projectRoot` is relative. A caller passing
// `./projA` vs `/home/user/projA` would otherwise hash
// differently, producing two separate DBs for the same physical
// project — silent split-brain that's hard to diagnose. Failing
// fast surfaces the caller bug at the right call site.
export const defaultCodeIndexPath = (
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (!isAbsolute(projectRoot)) {
    throw new Error(
      `defaultCodeIndexPath: projectRoot must be absolute, got '${projectRoot}'. Caller should canonicalize via git rev-parse --show-toplevel or similar before invoking.`,
    );
  }
  return join(codeIndexDir(env), `${projectRootHash(projectRoot)}.db`);
};
