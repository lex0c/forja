import { homedir } from 'node:os';
import { join } from 'node:path';
import { appDirName } from '../config/app-namespace.ts';

export const defaultDataDir = (): string => {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg !== undefined && xdg.length > 0
    ? join(xdg, appDirName())
    : join(homedir(), '.local', 'share', appDirName());
};

export const defaultDbPath = (): string => join(defaultDataDir(), 'sessions.db');

// Forja-dedicated cache root. Honors $XDG_CACHE_HOME like `defaultDataDir`
// honors $XDG_DATA_HOME, but REQUIRES an absolute value (per the XDG Base
// Dir Spec, relative values are ignored): this path becomes a bwrap
// `--bind` target / SBPL subpath, and a relative one would be an invalid
// mount that aborts EVERY sandboxed spawn (persistence is on by default).
// A non-absolute XDG_CACHE_HOME falls back to `~/.cache/forja`. This tree
// is the sandbox's persistent area (`[sandbox] cache_persistence` /
// `shared_tmp`) — DEDICATED to Forja, never the host's real cache dirs, so
// a build inside the sandbox can't poison builds the operator runs outside.
export const forjaCacheDir = (): string => {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg !== undefined && xdg.length > 0 && xdg.startsWith('/')
    ? join(xdg, appDirName())
    : join(homedir(), '.cache', appDirName());
};

// Persistent build/dep cache base — bind-mounted read-write into the
// sandbox; per-language subdirs (`go/`, `npm/`, …) live under it. Kept a
// SIBLING of the session-tmp tree (below), never a parent, so the cache
// bind never captures the tmp tree.
export const forjaCachePersistBase = (): string => join(forjaCacheDir(), 'cache');

// Per-session `/tmp` source. `<forjaCacheDir>/tmp/sessions/<sessionId>`
// is bind-mounted onto `/tmp` when `shared_tmp` is on, created at boot
// and removed at exit — persistent within a session, isolated across
// sessions and from the host `/tmp`.
export const forjaSessionTmpDir = (sessionId: string): string =>
  join(forjaCacheDir(), 'tmp', 'sessions', sessionId);
