// §7.3 external sealing — worm-file backend primitive.
//
// The local hash chain in `approvals_log` defends against
// piecemeal-silent edits (flip one row, chain breaks at verify).
// It does NOT defend against an adversary with root who rewrites
// EVERY row + recomputes hashes. Sealing externally raises that
// bar: periodically write the latest chain hash to a write-once-
// read-many surface that the adversary cannot retroactively edit.
//
// `worm-file` backend: append a line per seal event to a file that
// has been `chattr +a`'d. On ext4 with the IMMUTABLE_FILE_ATTRS
// allowed, append-only files reject any non-append write (truncate,
// edit, delete) — even from root, unless they FIRST run `chattr -a`
// (which a process can detect via lsattr). Mounted-WORM filesystems
// give a similar guarantee at the mount layer (no chattr needed).
//
// Threat model:
//   - In-scope: silently rewriting old seal entries.
//   - Out-of-scope: removing `chattr +a` before tampering (the
//     attacker leaves a trail — lsattr at audit time catches this).
//   - Out-of-scope: tampering with the LIVE chain in the SQLite DB
//     before the next seal lands; that's mitigated by frequent seals
//     (per-100-decisions / per-hour, configured in §7.3 [seal] block).
//
// This file is the PRIMITIVE only. Future slices wire:
//   - Sealing scheduler (interval_decisions + interval_seconds).
//   - Audit sink integration (auto-seal on emit when interval hits).
//   - Bootstrap wire-up + `[seal]` Policy section.
//
// Test seams: `onCreate` (chattr injection), `exists`, `read`,
// `append`. Production callers wire `onCreate` to `execFileSync
// ('/usr/bin/chattr', ['+a', path])`; tests mock as no-op or capture.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../storage/db.ts';
import { getApprovalsLogBySeq } from '../storage/repos/approvals-log.ts';
import { defaultRfc3161TsaFactory } from './sealing-rfc3161.ts';
import { defaultS3ObjectLockFactory } from './sealing-s3-object-lock.ts';
import type { SealMode, SealPolicy } from './types.ts';

export interface SealEntry {
  seq: number;
  ts: number;
  hash: string;
}

export type SealAppendResult = { ok: true } | { ok: false; reason: string };

export interface SealStore {
  // Append a single entry. First call on a non-existent file invokes
  // `onCreate(path)` AFTER the line is written — production wiring
  // runs `chattr +a` here so the file becomes append-only from the
  // very next write onward. Failure surfaces via `ok: false` with a
  // human-readable reason; the line is ALREADY persisted by then
  // (the caller's choice between degrade/refuse goes from there).
  append(entry: SealEntry): SealAppendResult;
  // Parse all entries from disk in append order. Malformed lines
  // throw — the seal file is security-critical, so corruption MUST
  // surface loudly rather than be silently skipped.
  list(): readonly SealEntry[];
  // Release any held resources. No-op for worm-file (no open
  // handles), but the interface keeps the same shape for future
  // backends (s3, rfc3161 TSA, git) that DO hold sockets/handles.
  close(): void;
}

export interface CreateWormFileSealerOptions {
  path: string;
  // Invoked exactly ONCE — on the append that first creates the
  // file. Production: `(p) => execFileSync('/usr/bin/chattr', ['+a', p])`.
  // Tests: no-op or capture-into-array. If `onCreate` throws, the
  // append still landed (the file now exists with one line) but the
  // append() result is `ok: false` so the caller can react per the
  // policy's `on_failure` knob (degrade vs refuse).
  onCreate?: (path: string) => void;
  // fs seams. Production callers leave undefined → defaults from
  // node:fs. Tests pin specific scenarios deterministically.
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  append?: (path: string, content: string) => void;
  ensureDir?: (dir: string) => void;
}

// Wire format. One entry per line, tab-separated `key=value` pairs.
// Forward-compatible: a v2 file can add `foo=bar` fields and the v1
// parser ignores them.
//
// The `hash` field is OPAQUE to the sealer — whatever the caller
// passes in `SealEntry.hash` is persisted byte-for-byte and compared
// byte-for-byte at verify time. This matches the audit chain's
// `approvals_log.this_hash` (raw sha256 hex, no `sha256:` prefix);
// callers that prefer the prefixed form pass it explicitly. The
// only restriction is no whitespace — the line is tab-separated, so
// any whitespace in the hash would break parsing.
const ENTRY_LINE = (e: SealEntry): string => `seq=${e.seq}\tts=${e.ts}\thash=${e.hash}\n`;

// Strict parser — every line MUST have the three expected keys in
// order. Skipping malformed lines would silently mask tampering;
// failing loudly is the secure default. Returns null on parse fail
// so the caller (list()) can throw with a more informative message
// that includes the offending line number.
const parseLine = (line: string): SealEntry | null => {
  if (line.length === 0) return null;
  // Tab-separated; exactly 3 fields.
  const parts = line.split('\t');
  if (parts.length !== 3) return null;
  const [seqField, tsField, hashField] = parts;
  if (
    seqField === undefined ||
    tsField === undefined ||
    hashField === undefined ||
    !seqField.startsWith('seq=') ||
    !tsField.startsWith('ts=') ||
    !hashField.startsWith('hash=')
  ) {
    return null;
  }
  const seq = Number(seqField.slice(4));
  const ts = Number(tsField.slice(3));
  const hash = hashField.slice(5);
  if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq < 1) return null;
  if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) return null;
  if (hash.length === 0) return null;
  return { seq, ts, hash };
};

const defaultExists = (p: string): boolean => existsSync(p);
const defaultRead = (p: string): string => readFileSync(p, 'utf8');
const defaultAppend = (p: string, content: string): void => {
  appendFileSync(p, content, 'utf8');
};
const defaultEnsureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

export const createWormFileSealer = (opts: CreateWormFileSealerOptions): SealStore => {
  const exists = opts.exists ?? defaultExists;
  const read = opts.read ?? defaultRead;
  const append = opts.append ?? defaultAppend;
  const ensureDir = opts.ensureDir ?? defaultEnsureDir;
  const onCreate = opts.onCreate;

  return {
    append: (entry: SealEntry): SealAppendResult => {
      // Validate before touching disk. Cheap defense against
      // garbage-in (caller passed NaN, negative seq, whitespace in
      // hash that would break tab-separated parsing).
      if (
        !Number.isInteger(entry.seq) ||
        entry.seq < 1 ||
        !Number.isInteger(entry.ts) ||
        entry.ts < 0 ||
        typeof entry.hash !== 'string' ||
        entry.hash.length === 0 ||
        /\s/.test(entry.hash)
      ) {
        return { ok: false, reason: `invalid seal entry: ${JSON.stringify(entry)}` };
      }
      // First write needs the parent directory.
      const wasMissing = !exists(opts.path);
      if (wasMissing) {
        try {
          ensureDir(dirname(opts.path));
        } catch (e) {
          return {
            ok: false,
            reason: `ensureDir failed for ${dirname(opts.path)}: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      try {
        append(opts.path, ENTRY_LINE(entry));
      } catch (e) {
        return {
          ok: false,
          reason: `append failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      // Chattr step. Runs ONLY on the append that created the file —
      // subsequent writes hit a file that's already +a'd. If onCreate
      // throws, the line IS persisted (data integrity is preserved),
      // but we surface the failure so the caller can degrade.
      if (wasMissing && onCreate !== undefined) {
        try {
          onCreate(opts.path);
        } catch (e) {
          return {
            ok: false,
            reason: `onCreate failed for ${opts.path}: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }
      return { ok: true };
    },
    list: (): readonly SealEntry[] => {
      if (!exists(opts.path)) return [];
      const content = read(opts.path);
      if (content.length === 0) return [];
      // Split on \n; a trailing newline produces a trailing empty
      // string that parseLine returns null for and we filter.
      const lines = content.split('\n');
      const out: SealEntry[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.length === 0) continue;
        const parsed = parseLine(line);
        if (parsed === null) {
          throw new Error(`malformed seal entry at line ${i + 1}: ${JSON.stringify(line)}`);
        }
        out.push(parsed);
      }
      return out;
    },
    close: (): void => {
      // No-op for worm-file. Reserved for future backends.
    },
  };
};

// §7.3 verification — cross-references each seal entry against the
// `approvals_log` chain. Mismatch ⇒ either the seal was tampered
// (entry edited) OR the chain was tampered (DB row mutated) OR a
// rotation reset the chain between seal and verify (rare but
// documented).
//
// The first mismatch wins — we report `firstMismatchAt` so the
// operator can investigate ONE point of divergence rather than
// chase a cascading hash mismatch downstream.

export type VerifySealResult =
  | { ok: true; entriesChecked: number }
  | { ok: false; reason: string; firstMismatchAt?: number };

// Production-default `SealStore` factory for the worm-file backend.
// Invokes `/usr/bin/chattr +a` on first append via the sealer's
// `onCreate` hook so the file becomes append-only from the next
// write onward. Non-Linux platforms (no chattr binary) →
// execFileSync throws → sealer returns ok:false → caller routes
// the failure (scheduler's `onSealFailed`, or the CLI verb's
// error rendering).
//
// `stdio: 'ignore'` suppresses chattr's normal silence on success
// while keeping a noisy stderr off the operator's terminal in the
// happy path. Failures throw with the exit code in the Error,
// which `createWormFileSealer` wraps into the standard ok:false
// reason string.
//
// Slice 58 hoisted this from bootstrap-engine.ts so both the
// bootstrap wire-up AND the `agent permission seal-*` CLI verbs
// can construct the same store without duplication. Future
// backends (`s3-object-lock`, `rfc3161-tsa`, `git-anchored`) ship
// alongside this factory with their own `defaultXFactory`
// functions; the CLI dispatch reads `config.mode` to pick.
export const defaultWormFileFactory = (config: SealPolicy): SealStore => {
  if (config.path === undefined) {
    // parsePolicy enforces this for mode='worm-file' — branch is
    // unreachable in well-formed input. Explicit error keeps the
    // contract visible at the call site.
    throw new Error('defaultWormFileFactory: config.path is required for worm-file mode');
  }
  return createWormFileSealer({
    path: config.path,
    onCreate: (p) => {
      execFileSync('/usr/bin/chattr', ['+a', p], { stdio: 'ignore' });
    },
  });
};

// §7.3 git-anchored backend (slice 63). Append-only by virtue of
// git's commit semantics: each `append` writes the entry to a
// designated file inside a pre-initialized git repository, then
// runs `git add + git commit` so the seal entry is also recorded
// as an immutable commit in the repo's history. An operator who
// later pushes the repo to a remote (out-of-band — slice 63 keeps
// it local) gets external anchoring without the chattr / WORM-FS
// dependencies the worm-file backend requires.
//
// Threat model:
//   - In-scope: silent edits to past seal entries. `git status`
//     surfaces uncommitted modifications; `git log -p` shows the
//     full history; `git reset --hard <earlier>` is detectable.
//   - Out-of-scope: rewriting the repo's history (force-push,
//     `git filter-branch`). Operator's responsibility to push to
//     a protected remote that disallows force-push.
//   - Out-of-scope: the repo dir being world-writable. Operator
//     sets repo permissions; sealer doesn't enforce.
//
// Wire format is byte-identical to worm-file (same `seq=<n>\tts=<n>\thash=<H>\n`
// lines), so verifySealAgainstChain works on either backend
// without dispatch — the SealStore interface is the only seam.
//
// Test seams: `exec` (git invocations), `exists` / `read` /
// `append` (fs). Production callers leave them undefined.

export interface CreateGitAnchoredSealerOptions {
  // Path to a pre-existing git repository directory. Initialization
  // (`git init`, configuring user.name/email if needed) is the
  // operator's responsibility — the sealer doesn't init repos
  // because that would create surprising side effects if the path
  // was wrong.
  repoPath: string;
  // Filename within the repo for seal entries. Default 'seal.log'.
  // Operators with multi-engine deployments can use distinct names
  // per install_id to avoid commit collisions.
  sealFile?: string;
  // Production: shells out to /usr/bin/git via execFileSync.
  // Tests: capture-into-array stub so unit tests don't need a real
  // repo. Throws on git failure; the sealer's catch translates to
  // SealAppendResult.
  exec?: (cmd: string, args: readonly string[], opts: { cwd: string }) => void;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  append?: (path: string, content: string) => void;
}

const defaultGitExec = (cmd: string, args: readonly string[], opts: { cwd: string }): void => {
  execFileSync(cmd, args, { cwd: opts.cwd, stdio: 'ignore' });
};

export const createGitAnchoredSealer = (opts: CreateGitAnchoredSealerOptions): SealStore => {
  const sealFile = opts.sealFile ?? 'seal.log';
  const fullPath = `${opts.repoPath.replace(/\/+$/, '')}/${sealFile}`;
  const exists = opts.exists ?? defaultExists;
  const read = opts.read ?? defaultRead;
  const append = opts.append ?? defaultAppend;
  const exec = opts.exec ?? defaultGitExec;

  return {
    append: (entry: SealEntry): SealAppendResult => {
      if (
        !Number.isInteger(entry.seq) ||
        entry.seq < 1 ||
        !Number.isInteger(entry.ts) ||
        entry.ts < 0 ||
        typeof entry.hash !== 'string' ||
        entry.hash.length === 0 ||
        /\s/.test(entry.hash)
      ) {
        return { ok: false, reason: `invalid seal entry: ${JSON.stringify(entry)}` };
      }
      try {
        append(fullPath, ENTRY_LINE(entry));
      } catch (e) {
        return {
          ok: false,
          reason: `append failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      // git add + commit. We commit per seal entry — the operator's
      // `interval_decisions` / `interval_seconds` controls cadence,
      // so per-entry commits naturally match the spec's "periodic"
      // wording. Commit message embeds seq + hash so `git log`
      // alone is a human-readable seal trail.
      try {
        exec('git', ['add', sealFile], { cwd: opts.repoPath });
      } catch (e) {
        return {
          ok: false,
          reason: `git add failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      try {
        exec('git', ['commit', '-m', `seal: seq=${entry.seq} hash=${entry.hash}`], {
          cwd: opts.repoPath,
        });
      } catch (e) {
        return {
          ok: false,
          reason: `git commit failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return { ok: true };
    },
    list: (): readonly SealEntry[] => {
      if (!exists(fullPath)) return [];
      const content = read(fullPath);
      if (content.length === 0) return [];
      const lines = content.split('\n');
      const out: SealEntry[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.length === 0) continue;
        const parsed = parseLine(line);
        if (parsed === null) {
          throw new Error(`malformed seal entry at line ${i + 1}: ${JSON.stringify(line)}`);
        }
        out.push(parsed);
      }
      return out;
    },
    close: (): void => {
      // No-op for git-anchored. Reserved for future backends.
    },
  };
};

// Production default factory for git-anchored mode. Maps
// `config.path` (semantically a repo directory) to the
// `createGitAnchoredSealer` constructor's `repoPath` field. The
// SealPolicy schema uses `path` polymorphically per backend
// (worm-file: seal file; git-anchored: repo directory).
export const defaultGitAnchoredFactory = (config: SealPolicy): SealStore => {
  if (config.path === undefined) {
    throw new Error('defaultGitAnchoredFactory: config.path is required for git-anchored mode');
  }
  return createGitAnchoredSealer({ repoPath: config.path });
};

// Dispatcher: returns the production-default factory for the given
// mode, or null when no factory is wired yet. Consumers
// (bootstrap, seal-now, seal-verify, doctor) call this to avoid
// replicating per-mode branches at every call site. Tests can
// still inject a `sealStoreFactory` seam that bypasses this
// dispatcher entirely.
export const factoryForSealMode = (mode: SealMode): ((c: SealPolicy) => SealStore) | null => {
  if (mode === 'worm-file') return defaultWormFileFactory;
  if (mode === 'git-anchored') return defaultGitAnchoredFactory;
  if (mode === 'rfc3161-tsa') return defaultRfc3161TsaFactory;
  if (mode === 's3-object-lock') return defaultS3ObjectLockFactory;
  return null;
};

export const verifySealAgainstChain = (store: SealStore, db: DB): VerifySealResult => {
  let entries: readonly SealEntry[];
  try {
    entries = store.list();
  } catch (e) {
    return {
      ok: false,
      reason: `seal file corrupted: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  for (const entry of entries) {
    const row = getApprovalsLogBySeq(db, entry.seq);
    if (row === null) {
      return {
        ok: false,
        reason: `seal references seq=${entry.seq} which is missing from approvals_log`,
        firstMismatchAt: entry.seq,
      };
    }
    if (row.this_hash !== entry.hash) {
      return {
        ok: false,
        reason: `hash mismatch at seq=${entry.seq}: seal=${entry.hash}, db=${row.this_hash}`,
        firstMismatchAt: entry.seq,
      };
    }
  }
  return { ok: true, entriesChecked: entries.length };
};
