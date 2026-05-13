// Per-installation identity. Persisted at first start under
// `$XDG_CONFIG_HOME/agent/install_id` (or the platform equivalent —
// see `installIdPath`). Two roles:
//
//   1. Genesis derivation for the audit hash chain
//      (PERMISSION_ENGINE.md §7.2). The first row of `approvals_log`
//      uses `prev_hash = "GENESIS:" || sha256(install_id || created_at_ms)`,
//      so the chain is bound to this installation — a copied DB
//      from another machine fails `verifyChain` because the
//      genesis can't reproduce without the matching identity.
//
//   2. Cross-session attribution: every audit row carries
//      install_id so multi-install fleets (CI runners, devbox +
//      laptop) keep separate ledgers without colliding seq
//      numbers.
//
// File format: single-line JSON `{install_id, created_at_ms}`. Mode
// 0600 so other users on a shared host can't read it (the install_id
// itself isn't a credential, but exposing it lets an attacker forge
// the genesis if they also know the timestamp). Created_at is the
// wall-clock ms at first write — combined with the UUID it gives a
// genesis hash that's globally unique even if `crypto.randomUUID`
// is somehow biased (it isn't, but defense in depth costs nothing).

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { installIdPath } from './paths.ts';

export interface InstallIdentity {
  install_id: string;
  created_at_ms: number;
}

const isInstallIdentity = (v: unknown): v is InstallIdentity => {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.install_id === 'string' && typeof o.created_at_ms === 'number';
};

export interface EnsureInstallIdOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  // Test seam: pin the timestamp instead of reading wall clock.
  // Production never sets this.
  now?: () => number;
  // Test seam: pin the UUID. Production never sets this.
  uuid?: () => string;
  // Test seam: override the file path the identity is read/written
  // to. When set, bypasses `installIdPath` discovery entirely.
  pathOverride?: string;
}

export interface IsFirstBootOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathOverride?: string;
}

// True when the install_id file doesn't exist yet — slice 46 uses
// this to render a one-line nudge ("try `agent welcome`") on the
// operator's first invocation of any normal verb. Returns false when
// the path can't be derived (no $HOME / $XDG_CONFIG_HOME / %APPDATA%)
// so the nudge stays silent in degraded environments; ensureInstallId
// will throw on bootstrap and surface the actionable error there.
export const isFirstBoot = (options: IsFirstBootOptions = {}): boolean => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = options.pathOverride ?? installIdPath(env, platform);
  if (path === null) return false;
  return !existsSync(path);
};

// Reads existing identity or generates+writes a fresh one. Idempotent:
// repeated calls in the same install return the same identity. Throws
// when:
//   - no home-rooted config dir is available (no HOME / no XDG /
//     no APPDATA): the audit chain can't bootstrap without a stable
//     genesis, so fail closed rather than degrade silently.
//   - the existing file is corrupted (malformed JSON or wrong shape):
//     the chain that was anchored to it can't be reproduced from
//     unverifiable identity. Operator must run `agent permission
//     verify` and decide rotation vs accept-broken-chain.
export const ensureInstallId = (options: EnsureInstallIdOptions = {}): InstallIdentity => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = options.pathOverride ?? installIdPath(env, platform);
  if (path === null) {
    throw new Error(
      'install_id: cannot determine config directory ($HOME / $XDG_CONFIG_HOME / %APPDATA% all missing)',
    );
  }

  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      throw new Error(`install_id: cannot read ${path}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`install_id: ${path} is not valid JSON: ${(err as Error).message}`);
    }
    if (!isInstallIdentity(parsed)) {
      throw new Error(
        `install_id: ${path} has wrong shape (expected {install_id: string, created_at_ms: number})`,
      );
    }
    return parsed;
  }

  // Fresh install — generate identity and write atomically. The
  // mkdir+write here is the ONLY point that creates `agent/`
  // config dir (path.ts is read-only). Mode 0700 on the dir to
  // match the file mode; if the dir already exists at a wider
  // mode we leave it (don't tighten silently, an operator's
  // umask might be deliberate).
  //
  // Slice 128 (R4 P0-Race-2): atomic write via O_WRONLY | O_CREAT |
  // O_EXCL. Pre-slice the existsSync→writeFileSync sequence had a
  // TOCTOU: two parallel `forja` first-boots both pass the
  // existsSync false check, each generates its own UUID, last-
  // writer wins. The loser's audit rows are orphaned on next
  // start because the genesis hash derived from their UUID
  // mismatches the file on disk. The fix mirrors slice 122's
  // sandbox-skip pattern: openSync with O_EXCL fails EEXIST when
  // someone else won the race; the loser then re-reads the
  // winner's identity and returns it.
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const identity: InstallIdentity = {
    install_id: uuid(),
    created_at_ms: now(),
  };
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Someone else won the race; re-read their identity. Recurse
      // through the existsSync branch this time (the file now
      // exists). One re-entry is enough — if THAT read also fails
      // ENOENT (the rare delete-between-the-write-and-our-read
      // case), we let the error propagate so the operator sees
      // the real problem rather than masking it with a fresh
      // identity that would orphan even more rows.
      return ensureInstallId(options);
    }
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(identity));
  } finally {
    closeSync(fd);
  }
  return identity;
};
