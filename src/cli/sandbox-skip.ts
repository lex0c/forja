// §13.5 sandbox_skip marker — PERMISSION_ENGINE.md slice 91.
//
// Spec line 893: "Nunca há opção silenciosa 'skip and don't ask
// again'. Re-prompt em toda sessão se sandbox continua ausente;
// suprimível só com `~/.config/forja/sandbox_skip` criado via
// `--i-know-what-im-doing`."
//
// The marker file exists for the rare advanced operator who:
//   1. acknowledges they're running without sandbox isolation;
//   2. doesn't want the first-boot prompt every session;
//   3. is OK with that visible-to-audit acknowledgment.
//
// The intent is high-friction-to-engage: long flag name (no
// short form), no env var, no config file. Operator must
// EXPLICITLY pass `--i-know-what-im-doing` once. Subsequent
// sessions read the marker + skip the welcome prompt.
//
// Out of scope: bypassing policy / sandbox enforcement at
// runtime. The marker is UX-only — the engine's degraded state +
// confirm-on-every-call posture is unaffected.
//
// Slice 122 (R9 P0 #23/#24/#45) hardenings:
//
//   - `hasSandboxSkip` uses `lstat` instead of `existsSync`,
//     refusing symlinks. Pre-slice an attacker who could plant
//     a symlink at `~/.config/forja/sandbox_skip` pointing to
//     any existing file (e.g., /dev/null) would silence the
//     first-boot prompt without the operator ever running
//     `--i-know-what-im-doing` — the read-only check followed
//     the symlink and reported "marker present".
//
//   - `createSandboxSkip` opens the marker with `O_EXCL` +
//     `O_NOFOLLOW` + mode `0600` (was implicit 0644 via
//     writeFileSync). Pre-slice the TOCTOU between
//     `existsSync` and `writeFileSync` allowed a symlink to be
//     substituted in the window; writeFileSync then followed
//     the symlink, writing the marker body to whatever path
//     the attacker chose. The atomic open closes the window
//     (O_EXCL fails on race; O_NOFOLLOW fails on symlink).
//
//   - Parent directory `~/.config/forja/` created with mode
//     `0700` (was 0777-minus-umask). On multi-tenant hosts,
//     0755+ exposes the marker's existence to other users.

import { constants, closeSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

// File mode for the marker — owner read/write only. Multi-tenant
// hosts: other users can't probe whether `--i-know-what-im-doing`
// has ever been used.
const MARKER_FILE_MODE = 0o600;

// Directory mode for `~/.config/forja/` — owner-only. Prevents
// other users from listing the dir (which would reveal the
// marker's presence even with file-mode 0600).
const MARKER_DIR_MODE = 0o700;

// Path to the marker file. Honors `$XDG_CONFIG_HOME` per
// freedesktop spec; falls back to `$HOME/.config` (env-provided
// HOME, then `homedir()` system call). Linux/macOS only —
// Windows operators are out-of-scope per §13.2.
//
// The XDG branch requires `xdgConfig` to be ABSOLUTE. Per XDG
// Base Directory Spec, "if $XDG_CONFIG_HOME is either not set or
// empty, [...]. If $XDG_CONFIG_HOME is set to a relative path,
// the variable is to be ignored as defined in the spec." Without
// the guard, a relative value like `tmpcfg` would produce a
// CWD-relative marker path: `--i-know-what-im-doing` writes the
// marker into the current project, and a later session started
// from a different cwd never sees it — the operator would be
// re-prompted, then writing a second marker into a second
// project dir, fragmenting the "I've acknowledged unsafe mode"
// state across the filesystem.
export const sandboxSkipPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdgConfig = env.XDG_CONFIG_HOME;
  if (xdgConfig !== undefined && xdgConfig.length > 0 && isAbsolute(xdgConfig)) {
    return join(xdgConfig, 'forja', 'sandbox_skip');
  }
  // Prefer env.HOME so tests can pin the path without setting the
  // OS-level home directory; fall back to homedir() for runtime
  // production callers that haven't overridden env. Reached when
  // XDG_CONFIG_HOME is unset, empty, OR a relative value (treated
  // as "ignored" per the XDG spec).
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, '.config', 'forja', 'sandbox_skip');
};

// Filesystem primitives that touch the marker. The injectable
// shape lets tests substitute in-memory implementations while
// production wires up `node:fs` with symlink-defended flags.
//
// All primitives operate on the ABSOLUTE marker path. They MUST
// NOT follow symlinks — `lstat` returns symlink info as-is and
// `createExclusive` uses `O_NOFOLLOW`. Tests overriding these
// seams should preserve those semantics.
export interface SandboxSkipFs {
  // Stat the path WITHOUT following symlinks. Throw an
  // `ErrnoException` with `code === 'ENOENT'` when the path
  // doesn't exist. Any other error (EACCES, permissions, etc.)
  // is propagated by callers.
  lstat?: (path: string) => Stats;
  // Create the parent directory (idempotent). `mode` is applied
  // to the leaf segment; intermediate dirs use the OS default.
  // `recursive` semantics: no-op when target exists.
  mkdir?: (path: string, mode: number) => void;
  // Atomic create-and-write. MUST fail with EEXIST if `path`
  // already exists and MUST fail with ELOOP if `path` is a
  // symlink (i.e., open with `O_EXCL | O_NOFOLLOW`). `mode`
  // is the creation mode for the new file.
  createExclusive?: (path: string, content: string, mode: number) => void;
  // Read the marker's contents. Slice 123 (R9 P1): used by the
  // welcome flow to surface the marker's `# created: <iso>`
  // timestamp in the "Sandbox setup skipped" message. MUST NOT
  // follow symlinks (open with `O_NOFOLLOW`). Tests can return
  // a fixture body; production uses `node:fs` with the safe
  // flag set.
  readContent?: (path: string) => string;
}

const defaultLstat = lstatSync;
const defaultMkdir = (path: string, mode: number): void => {
  mkdirSync(path, { recursive: true, mode });
};
const defaultCreateExclusive = (path: string, content: string, mode: number): void => {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, mode);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
};
// Open the marker for read with `O_NOFOLLOW` so the read path
// inherits the same symlink defense as the write path. Falls
// through to a hard-bounded read (1 KiB) so a poisoned marker
// can't blow the read buffer.
const defaultReadContent = (path: string): string => {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const fd = openSync(path, flags);
  try {
    const buf = Buffer.alloc(MARKER_MAX_BYTES);
    const n = readSync(fd, buf, 0, MARKER_MAX_BYTES, 0);
    return buf.subarray(0, n).toString('utf-8');
  } finally {
    closeSync(fd);
  }
};

// Marker body cap. Production markers are < 500 bytes; cap at
// 1 KiB so a poisoned/large file at the marker path can't be
// slurped fully into memory.
const MARKER_MAX_BYTES = 1024;

// Resolve a node:fs ErrnoException-like error's `code`. Errors
// from `node:fs` carry a string `code` property (e.g., 'ENOENT',
// 'EEXIST', 'ELOOP'). Tests may throw plain Errors without code;
// helper coerces uniformly.
const errnoCode = (e: unknown): string | undefined => {
  if (e instanceof Error && 'code' in e) {
    const c = (e as NodeJS.ErrnoException).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
};

// True iff the marker exists AS A REGULAR FILE. Symlinks at
// the marker path return false — the operator never ran
// `--i-know-what-im-doing`, so the welcome prompt must fire.
//
// ANY error other than ENOENT propagates. We deliberately do
// NOT swallow EACCES / EIO / etc. — those indicate the operator
// has a permissions or storage issue worth surfacing instead of
// silently falling through to "marker absent → prompt".
export const hasSandboxSkip = (
  options: { env?: NodeJS.ProcessEnv; fs?: SandboxSkipFs } = {},
): boolean => {
  const env = options.env ?? process.env;
  const lstat = options.fs?.lstat ?? defaultLstat;
  const path = sandboxSkipPath(env);
  let st: Stats;
  try {
    st = lstat(path);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return false;
    throw e;
  }
  // Refuse symlinks, directories, sockets, etc. — only a regular
  // file counts as the marker. A symlink-shaped attack
  // (`ln -s /dev/null ~/.config/forja/sandbox_skip`) would have
  // silenced the prompt pre-slice; now it returns false and
  // welcome re-prompts.
  return st.isFile() && !st.isSymbolicLink();
};

// Create the marker file. Idempotent — re-creating an existing
// regular-file marker is a no-op (timestamps stay). Body carries
// a human-readable acknowledgment so operators inspecting the
// file can see WHEN + by which forja version it was created.
//
// Symlink defense: if the marker path is occupied by a SYMLINK
// (or any non-regular-file), throws an error rather than
// silently overwriting. The operator must inspect + delete
// manually before re-running `--i-know-what-im-doing` — a
// symlink at this path is a strong signal of compromise (or
// operator self-inflicted misconfiguration).
//
// Atomic create: even between the lstat-says-absent check and
// the openSync, an attacker could plant a symlink. The
// `O_EXCL | O_NOFOLLOW` open closes the TOCTOU window — EEXIST
// on race (file appeared), ELOOP on symlink (planted between
// our checks). Either way the call fails loud rather than
// writing to an attacker-chosen path.
export interface CreateSandboxSkipOptions {
  env?: NodeJS.ProcessEnv;
  fs?: SandboxSkipFs;
  now?: () => number;
  engineVersion?: string;
}

export const createSandboxSkip = (
  options: CreateSandboxSkipOptions = {},
): { path: string; created: boolean } => {
  const env = options.env ?? process.env;
  const lstat = options.fs?.lstat ?? defaultLstat;
  const mkdir = options.fs?.mkdir ?? defaultMkdir;
  const createExclusive = options.fs?.createExclusive ?? defaultCreateExclusive;
  const now = options.now ?? Date.now;
  const path = sandboxSkipPath(env);

  // Idempotency + symlink-attack check. lstat returns the
  // symlink itself (no follow), so a planted symlink shows up
  // as `isSymbolicLink() === true` and we refuse to overwrite.
  try {
    const st = lstat(path);
    if (st.isFile() && !st.isSymbolicLink()) {
      return { path, created: false };
    }
    throw new Error(
      `sandbox_skip path '${path}' exists but is not a regular file (symlink / directory / other); refusing to overwrite — inspect and remove manually`,
    );
  } catch (e) {
    // ENOENT is the expected "marker doesn't exist yet" branch.
    // Any other error (including the refuse above) propagates.
    if (errnoCode(e) !== 'ENOENT') throw e;
  }

  // Create parent dir with owner-only mode. mkdir with
  // recursive:true is idempotent — no-op when present (mode of
  // an existing dir is NOT updated, by design; we don't want to
  // surprise operators whose `~/.config/` is shared via group).
  mkdir(dirname(path), MARKER_DIR_MODE);

  const ts = new Date(now()).toISOString();
  const version = options.engineVersion ?? 'unknown';
  const body = [
    '# forja sandbox_skip marker',
    `# created: ${ts}`,
    `# version: ${version}`,
    '',
    '# This file suppresses the first-boot sandbox prompt for the',
    '# operator who acknowledged the unsafe-mode posture via',
    '# --i-know-what-im-doing. Delete this file to re-enable the',
    '# prompt. Does NOT bypass engine enforcement at runtime.',
    '',
  ].join('\n');

  // Atomic open with O_EXCL | O_NOFOLLOW | mode 0600. Closes
  // the TOCTOU window between the lstat above and the actual
  // write: a symlink planted in this window fails ELOOP; a
  // racing concurrent create fails EEXIST.
  createExclusive(path, body, MARKER_FILE_MODE);
  return { path, created: true };
};

// Read the marker's metadata for display in the welcome flow
// (slice 123, R9 P1). Returns null when the marker is absent OR
// when it exists but isn't a regular file (defense in depth: a
// symlink-shaped marker should fall through to the "absent"
// branch even if a future change weakens hasSandboxSkip).
//
// Parses the `# created: <iso>` and `# version: <string>` lines
// from the body. Missing fields stay undefined — the caller
// formats around them.
//
// Symlink defense matches the write path: read happens through
// `O_NOFOLLOW` so a planted symlink fails the open with ELOOP.
// Read errors return null to keep the welcome output graceful
// (the operator sees a no-timestamp message rather than a stack
// trace) — the failure modes worth surfacing already surfaced
// from `hasSandboxSkip`.
export interface SandboxSkipMetadata {
  path: string;
  createdAt?: string;
  version?: string;
}

export const readSandboxSkipMetadata = (
  options: { env?: NodeJS.ProcessEnv; fs?: SandboxSkipFs } = {},
): SandboxSkipMetadata | null => {
  const env = options.env ?? process.env;
  const lstat = options.fs?.lstat ?? defaultLstat;
  const readContent = options.fs?.readContent ?? defaultReadContent;
  const path = sandboxSkipPath(env);
  try {
    const st = lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  let body: string;
  try {
    body = readContent(path);
  } catch {
    return null;
  }
  const meta: SandboxSkipMetadata = { path };
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('# created:')) {
      const v = line.slice('# created:'.length).trim();
      if (v.length > 0) meta.createdAt = v;
    } else if (line.startsWith('# version:')) {
      const v = line.slice('# version:'.length).trim();
      if (v.length > 0) meta.version = v;
    }
  }
  return meta;
};
