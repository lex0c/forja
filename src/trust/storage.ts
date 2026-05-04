// Trusted-directories storage. Spec: AGENTIC_CLI.md §9.1.
//
// The store is intentionally minimal in this slice: a flat list of
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
// Atomic-ish via write-then-rename would be safer against partial
// writes, but Bun's `Bun.file().write()` is sync-write to the same
// path — a SIGINT mid-write could leave a partial file. For the
// trust list (small, infrequent writes) the practical risk is low
// and a corrupted file just wipes back to empty (next boot
// re-prompts). Accept the simpler implementation; tighten if a
// real incident surfaces.
export const addTrustedDir = (path: string, cwd: string): void => {
  const current = loadTrustedDirs(path);
  if (current.includes(cwd)) return;
  const next: TrustFile = { directories: [...current, cwd] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
};
