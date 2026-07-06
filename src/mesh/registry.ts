// Mesh discovery: filesystem descriptors under the runtime dir. Each serving
// Forja writes <runtime>/forja/mesh/peers/<alias>.json and listens on
// <alias>.sock; peers readdir + liveness-check. No daemon (spec §2, §0.8).

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { safeJsonParse } from '../broker/safe-json.ts';
import {
  ALIAS_MAX,
  ALIAS_RE,
  PEER_STATUSES,
  type PeerDescriptor,
  type PeerStatus,
} from './types.ts';

// A descriptor is a handful of small fields; cap the raw file so a foreign
// writer can't hand us a multi-MB `branch`/`repoRoot` to read into memory and
// forward to the model. The wire has a 1 MiB framer cap; descriptors get their
// own, tighter one.
const MAX_DESCRIPTOR_BYTES = 8 * 1024;

// `branch` is the one model-facing descriptor field (mesh_peers, §2) whose value
// isn't a strict grammar the way alias/status are — a git ref is too permissive.
// Bound it and reject control bytes / newlines so a planted descriptor can't
// smuggle a fake tool boundary or ANSI into the model's context outside the
// nonce fence. Plain-text content past that is untrusted-but-gated, like any
// external string a tool surfaces.
const BRANCH_MAX = 256;
const hasControlChars = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};

// Resolve the mesh runtime root. Prefer $XDG_RUNTIME_DIR (0700, per-user by
// construction on Linux); fall back to a per-uid tmpdir where it is unset.
export const meshRuntimeDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime.length > 0) {
    // $XDG_RUNTIME_DIR is /run/user/<uid> — created 0700 per-user by the OS, so
    // the ancestors above our `forja` subtree are already private and ours.
    return join(runtime, 'forja', 'mesh');
  }
  // No XDG_RUNTIME_DIR → fall back under a per-uid tmpdir. /tmp is world-writable,
  // so /tmp/forja-<uid> and its `forja` intermediate are the FIRST directories the
  // FS-permission auth boundary (§0.7) rests on. A DIFFERENT local user can
  // pre-create /tmp/forja-<uid> world-writable before we boot; the recursive mkdir
  // in ensureMeshDirs silently reuses it and only asserts the LEAF, so the
  // attacker-owned ancestor stays swappable (plant fake descriptors / sockets).
  // Create + assert BOTH ancestors as 0700-current-user HERE, before anything under
  // them is trusted — assertOwnedPrivateDir throws if a foreign owner pre-positioned
  // the base (fail-closed: the caller disables the mesh, §0.7).
  // Key the tmp base off the SAME env (env.TMPDIR, else os.tmpdir()) so the whole
  // resolution is a pure function of `env` — testable without mutating process.env.
  const tmpBase = env.TMPDIR !== undefined && env.TMPDIR.length > 0 ? env.TMPDIR : tmpdir();
  const base = join(tmpBase, `forja-${process.getuid?.() ?? 0}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  assertOwnedPrivateDir(base);
  const forjaDir = join(base, 'forja');
  mkdirSync(forjaDir, { recursive: true, mode: 0o700 });
  assertOwnedPrivateDir(forjaDir);
  return join(forjaDir, 'mesh');
};

const peersDir = (dir: string): string => join(dir, 'peers');

export const socketPath = (dir: string, alias: string): string => join(dir, `${alias}.sock`);
const descriptorPath = (dir: string, alias: string): string => join(peersDir(dir), `${alias}.json`);

// The FS permission IS the auth boundary (§0.7). mkdir's `mode` only applies to
// dirs it CREATES — a pre-existing world-writable dir (e.g. an attacker
// pre-creating /tmp/forja-<uid>/... before we boot) would be silently reused.
// After ensuring, assert the socket/descriptor dirs are ours and private;
// tighten in place if possible, refuse to serve if not.
const assertOwnedPrivateDir = (p: string): void => {
  const st = lstatSync(p);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`mesh: runtime dir ${p} is not owned by the current user (refusing, §0.7)`);
  }
  if ((st.mode & 0o077) !== 0) {
    try {
      chmodSync(p, 0o700);
    } catch {
      throw new Error(`mesh: runtime dir ${p} is group/other-accessible (refusing, §0.7)`);
    }
  }
};

export const ensureMeshDirs = (dir: string): void => {
  const peers = peersDir(dir);
  mkdirSync(peers, { recursive: true, mode: 0o700 });
  assertOwnedPrivateDir(dir);
  assertOwnedPrivateDir(peers);
};

export const publishDescriptor = (dir: string, desc: PeerDescriptor): void => {
  ensureMeshDirs(dir);
  // 0600: only the owner reads a descriptor (it carries the repo path).
  writeFileSync(descriptorPath(dir, desc.alias), JSON.stringify(desc), { mode: 0o600 });
};

export const removeDescriptor = (dir: string, alias: string): void => {
  // force:true swallows ENOENT; guard the rest (EISDIR/EPERM on a resolved path)
  // so a single poisoned entry can't throw out of the sweep loop.
  try {
    rmSync(descriptorPath(dir, alias), { force: true });
  } catch {
    // best-effort
  }
  try {
    rmSync(socketPath(dir, alias), { force: true });
  } catch {
    // best-effort
  }
};

// A pid is alive if signal 0 doesn't throw ESRCH. EPERM ⇒ alive but not ours
// (shouldn't happen same-user); treat as alive so we never sweep a live peer.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Parse + STRICTLY validate a descriptor written by another process. Every field
// is attacker-controllable (same-user, §0.7): `alias` must match the path-safe
// grammar (blocks `../` traversal through descriptorPath/socketPath + removeDescriptor's
// rmSync), `pid` must be a positive integer (pid:0 signals our own process group
// → phantom-alive forever), and `status`/`branch` are model-facing (mesh_peers)
// so they're bounded — `status` to the enum, `branch` to BRANCH_MAX with no
// control bytes — since an arbitrary string there is an unenveloped injection
// channel.
const parseDescriptor = (raw: string): PeerDescriptor | null => {
  if (raw.length > MAX_DESCRIPTOR_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = safeJsonParse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.alias !== 'string' ||
    o.alias.length > ALIAS_MAX ||
    !ALIAS_RE.test(o.alias) ||
    typeof o.repoRoot !== 'string' ||
    typeof o.branch !== 'string' ||
    o.branch.length > BRANCH_MAX ||
    hasControlChars(o.branch) ||
    typeof o.pid !== 'number' ||
    !Number.isInteger(o.pid) ||
    o.pid <= 0 ||
    typeof o.socket !== 'string' ||
    typeof o.status !== 'string' ||
    !PEER_STATUSES.has(o.status as PeerStatus) ||
    typeof o.startedAt !== 'number'
  ) {
    return null;
  }
  return o as unknown as PeerDescriptor;
};

// List live peers. Descriptors with a dead pid or a missing socket are stale —
// skipped, and (unless sweep is disabled) their .json + .sock are removed so the
// registry self-heals. `selfAlias` excludes the caller's own descriptor (a Forja
// identifies itself by its logical alias, not pid).
export const listPeers = (
  dir: string,
  opts: { sweep?: boolean; selfAlias?: string } = {},
): PeerDescriptor[] => {
  const dirPath = peersDir(dir);
  if (!existsSync(dirPath)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return [];
  }
  const out: PeerDescriptor[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(dirPath, name);
    let raw: string;
    try {
      // Bound + shape-check BEFORE reading into memory. lstat (not stat) so a
      // symlink is caught as a non-regular file and skipped — otherwise the read
      // would follow it to an arbitrary target, and an oversized descriptor would
      // be slurped wholesale before parseDescriptor's post-read cap can reject it.
      const st = lstatSync(filePath);
      if (!st.isFile() || st.size > MAX_DESCRIPTOR_BYTES) continue;
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const desc = parseDescriptor(raw);
    if (desc === null) continue; // invalid/foreign-shaped → leave it, never act on it
    // The sweep + discovery key on the FILE we read, NOT the alias INSIDE it
    // (attacker-controllable). A descriptor whose filename doesn't match its own
    // alias is malformed/planted — acting on it would sweep a DIFFERENT, possibly
    // live, peer's <alias>.json/.sock (removeDescriptor keys on desc.alias). Skip:
    // never surface, never sweep. With this guard, desc.alias === basename(name),
    // so removeDescriptor targets exactly the file we read.
    if (basename(name, '.json') !== desc.alias) continue;
    if (!isAlive(desc.pid)) {
      if (opts.sweep !== false) removeDescriptor(dir, desc.alias);
      continue;
    }
    if (opts.selfAlias !== undefined && desc.alias === opts.selfAlias) continue;
    // Recompute the socket from OUR dir + the validated alias — never trust the
    // `socket` field a foreign descriptor wrote (it could aim mesh_send at an
    // arbitrary Unix socket). Require it to exist (§2 liveness: pid alive AND
    // socket present; a full connect-probe is Slice 7).
    const canonicalSocket = socketPath(dir, desc.alias);
    if (!existsSync(canonicalSocket)) {
      if (opts.sweep !== false) removeDescriptor(dir, desc.alias);
      continue;
    }
    out.push({ ...desc, socket: canonicalSocket });
  }
  return out;
};
