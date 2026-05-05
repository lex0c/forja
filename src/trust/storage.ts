// Trusted-directories storage. Spec: AGENTIC_CLI.md §9.1.
//
// The store is intentionally minimal: a flat list of
// absolute paths in `~/.config/agent/trusted_dirs.json`. Once a path
// is added, subsequent boots from that cwd skip the trust prompt.
//
// Spec §9.1 also calls for an aggregate hash of the project's
// `.agent/` content + `AGENTS.md`, with re-prompt on any change.
// That hardening is deferred to a follow-up slice; absent it, an
// operator who clones into a previously-trusted path inherits the
// trust without a re-confirm. Acceptable for the operator-driven
// workflow we ship today (operator types `agent` in their own repo,
// not in arbitrary cloned tree); the hash check is the right answer
// when team-shared trust storage lands.
//
// File format: `{ "directories": [absolute-path, ...] }`.
// Plain JSON so the operator can inspect / hand-edit the list
// without tooling. Path matching is exact-string equality on the
// absolute path; we do NOT normalize symlinks or relative segments
// here — the caller is expected to pass a canonical absolute path
// (REPL passes `baseConfig.cwd`, which bootstrap already resolved).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface TrustFile {
  directories: string[];
}

const isTrustFile = (value: unknown): value is TrustFile => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { directories?: unknown };
  if (!Array.isArray(v.directories)) return false;
  return v.directories.every((d) => typeof d === 'string');
};

// Read the trust file. Returns an empty list when the file is
// missing OR malformed — a corrupt file shouldn't lock the
// operator out, just lose the persisted set (next confirm
// re-establishes). Never throws.
export const loadTrustedDirs = (path: string): readonly string[] => {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    const raw = readFileSync(path, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isTrustFile(parsed)) return [];
  return parsed.directories;
};

export const isTrusted = (path: string, cwd: string): boolean =>
  loadTrustedDirs(path).includes(cwd);

// Append a directory to the trust list and persist atomically. If
// the dir is already trusted, no-op (don't grow the file with
// duplicates). Creates the parent directory as needed (e.g., first
// ever forja boot when `~/.config/agent/` doesn't exist).
//
// Atomic write via tmp-then-rename. POSIX `rename(2)` is atomic
// when source and destination are on the same filesystem (always
// true here — same parent dir). Two concurrent `agent` invocations
// approving from different terminals can still race the read
// portion (A reads, B reads, A writes, B writes — B clobbers A's
// new entry), but the file itself never lands in a corrupt half-
// written state. The clobber is recoverable: next time the lost
// cwd is opened, the operator just re-confirms; trust is additive
// without delete semantics, so a missed entry is a re-prompt, not
// a leaked allowance.
//
// File mode 0o600 (owner read/write only). The trust list isn't
// secret in the credential sense, but it is operator-private
// project context — on a shared multi-user box the default 0644
// would let other users enumerate the directories you work in.
// Cheap defensive narrowing.
export const addTrustedDir = (path: string, cwd: string): void => {
  const current = loadTrustedDirs(path);
  if (current.includes(cwd)) return;
  const next: TrustFile = { directories: [...current, cwd] };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Suffix with PID so two concurrent processes don't fight over
  // the same tmp filename.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
};
