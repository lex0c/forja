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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { safeJsonParse } from '../broker/safe-json.ts';
import { probeSocket } from './transport.ts';
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
const lockPath = (dir: string, alias: string): string => join(dir, `${alias}.lock`);

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
  // 0600: only the owner reads a descriptor (it carries the repo path). Write to a
  // temp then atomically rename into place, so a concurrent listPeers never reads a
  // half-written (truncated) descriptor and transiently drops a live peer as
  // parse-failed. The temp ends in `.tmp` (not `.json`), so the discovery/sweep loop
  // — which keys on `.json` — never picks it up mid-write. Same dir → rename is atomic.
  const path = descriptorPath(dir, desc.alias);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(desc), { mode: 0o600 });
  renameSync(tmp, path);
};

// Remove ONLY the socket file for `alias`, not the descriptor. The alias-claim
// path (manager.startServing) uses this to clear a leftover .sock a probe has
// confirmed DEAD, without touching a .json — an orphan socket has no descriptor,
// and removing a live descriptor is the rollback's job, not the claim's. Guarded
// best-effort (force swallows ENOENT; catch the rest, e.g. EPERM on a resolved path).
export const removeSocket = (dir: string, alias: string): void => {
  try {
    rmSync(socketPath(dir, alias), { force: true });
  } catch {
    // best-effort
  }
};

// Remove ONLY the descriptor .json for `alias`, never the socket. The discovery
// SWEEP (listPeers) uses this: a stale/unreachable descriptor is dropped, but the
// .sock at the path is left untouched. Removing the socket in the sweep was a
// check-then-act race — the staleness decision (a dead pid, or a probe result that
// can be up to ~500 ms old) and the unlink are not atomic, so a peer that rebound
// the SAME alias in the window (a /relay off→on, or another same-repo session that
// derives the same alias) would lose its live socket and be left serving on an
// unlinked inode: permanently unreachable, since republish() only rewrites the
// .json, never rebinds the socket. A genuine dead-orphan .sock is harmless here
// (discovery keys on .json, so an orphan socket never surfaces) and is cleared,
// probe-guarded, by the next bindAlias claim. removeDescriptor (both files) stays
// for a server tearing down its OWN alias, where it holds the lock and no rebind
// can race.
export const removeDescriptorFile = (dir: string, alias: string): void => {
  // force:true swallows ENOENT; guard the rest (EISDIR/EPERM on a resolved path)
  // so a single poisoned entry can't throw out of the sweep loop.
  try {
    rmSync(descriptorPath(dir, alias), { force: true });
  } catch {
    // best-effort
  }
};

export const removeDescriptor = (dir: string, alias: string): void => {
  removeDescriptorFile(dir, alias);
  removeSocket(dir, alias);
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

// The holder pid written into an alias lock, or null if the file is gone/unreadable/
// malformed (all treated as "no valid holder" → the lock is stealable).
const readLockPid = (path: string): number | null => {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

// Atomically CLAIM an alias before binding its socket (§2). The O_EXCL create is the
// serializer: of N managers racing `/relay on` on one alias, exactly one creates
// <alias>.lock and the rest get EEXIST — so two can't both bind + publish even where the
// platform's socket bind doesn't reliably throw on an occupied path. Returns true if we
// hold the lock, false if a LIVE peer already does (a real collision). A stale lock from
// a crashed relay (holder pid no longer exists) is stolen: unlinked, then the exclusive
// create is retried ONCE — a live racer that grabbed it in the gap re-trips EEXIST and we
// refuse. Held for the serving lifetime; `releaseAliasLock` drops it on stop/rollback.
// (pid reuse is the one residual: a dead relay's pid re-assigned to an unrelated live
// process reads as "live holder" → a spurious refuse. Rare, and fail-safe.)
export const acquireAliasLock = (dir: string, alias: string, pid: number): boolean => {
  ensureMeshDirs(dir);
  const path = lockPath(dir, alias);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` = O_CREAT | O_EXCL | O_WRONLY — throws EEXIST if the path exists.
      writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLockPid(path);
      if (holder !== null && isAlive(holder)) return false; // live holder → collision
      try {
        rmSync(path, { force: true }); // stale → steal and retry the exclusive create
      } catch {
        // best-effort; a concurrent stealer may have removed it first
      }
    }
  }
  return false;
};

export const releaseAliasLock = (dir: string, alias: string): void => {
  try {
    rmSync(lockPath(dir, alias), { force: true });
  } catch {
    // best-effort
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

// List live peers. Descriptors with a dead pid or a socket no listener accepts
// are stale — skipped, and (unless sweep is disabled) their .json is removed so
// the registry self-heals (only the .json — never the .sock; see
// removeDescriptorFile). `selfAlias` excludes the caller's own
// descriptor (a Forja identifies itself by its logical alias, not pid). Async
// because liveness needs a connect PROBE, not a file-existence check (see below).
export const listPeers = async (
  dir: string,
  opts: { sweep?: boolean; selfAlias?: string } = {},
): Promise<PeerDescriptor[]> => {
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
    // so removeDescriptorFile targets exactly the file we read.
    if (basename(name, '.json') !== desc.alias) continue;
    if (!isAlive(desc.pid)) {
      if (opts.sweep !== false) removeDescriptorFile(dir, desc.alias);
      continue;
    }
    if (opts.selfAlias !== undefined && desc.alias === opts.selfAlias) continue;
    // Recompute the socket from OUR dir + the validated alias — never trust the
    // `socket` field a foreign descriptor wrote (it could aim mesh_send at an
    // arbitrary Unix socket). Liveness is a connect PROBE, not file existence
    // (§2): a crashed relay leaves its .sock file behind, and pid reuse makes the
    // dead descriptor's pid look alive again — so existsSync would advertise a
    // phantom that every mesh_send immediately loses AND trip startServing's
    // alias-collision check. probeSocket connects; only a live listener accepts.
    // Sweep the descriptor on refusal so the registry self-heals — but NOT the
    // socket: a probe refusal can be transient (a peer mid /relay off→on rebinds
    // the same alias), and a stale probe result must never authorize unlinking a
    // socket a live peer has since rebound (removeDescriptorFile).
    const canonicalSocket = socketPath(dir, desc.alias);
    if (!(await probeSocket(canonicalSocket))) {
      if (opts.sweep !== false) removeDescriptorFile(dir, desc.alias);
      continue;
    }
    out.push({ ...desc, socket: canonicalSocket });
  }
  return out;
};
