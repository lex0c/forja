// Lightweight git probes used by the system-prompt environment
// section. Returns null when not in a git repo (graceful — the
// env section just omits the git block). All probes are
// best-effort: any failure (git missing, permission denied,
// detached state) collapses to undefined for that field rather
// than throwing — the system prompt is informational, not
// load-bearing.
//
// Runs synchronously at session boot via Bun.spawnSync. Each
// probe is one git invocation; total cost ~5-15ms on a warm
// disk. Acceptable for a once-per-session call.
//
// Surface scope: branch name, dirty/clean counts, and ahead/
// behind distance. We DO NOT include recent commit subjects
// (`git log --oneline`) because commit messages are repo-
// controlled text — a malicious commit on a third-party fork
// or merged PR can carry instruction-like payloads, and
// embedding them at the TOP of the system prompt elevates
// repo content to system-level context before the operator's
// request lands. Same threat the AGENTS.md pointer pattern
// avoids: project text stays lazy, accessed via tools the
// model invokes deliberately, not eager-loaded by the
// bootstrap. The model can run `bash git log --oneline -10`
// on demand when commit history matters.
//
// Branch name is repo metadata too, but the surface is much
// smaller (refs/heads/ char restrictions) and operator-
// controlled at checkout time. Numeric fields (modified,
// untracked, ahead, behind) carry zero injection surface.

import { getGitBinarySync, safeGitEnv } from '../subagents/git-binary.ts';

export interface GitContext {
  // Current branch, e.g. "feat/m4-context-tuning". Falls back
  // to undefined for detached HEAD or probe failure — the env
  // section omits the branch line in that case.
  branch?: string;
  // Counts of dirty paths from `git status --porcelain`.
  // Together they answer "is the working tree clean?". Both
  // present at zero when clean; absent on probe failure.
  modified?: number;
  untracked?: number;
  // Distance from origin's tracking branch (when one exists).
  // Both undefined when the branch has no upstream.
  ahead?: number;
  behind?: number;
}

const runGit = (cwd: string, args: string[]): string | null => {
  try {
    // Pinned git path + canonical PATH closes the `~/bin/git`
    // shim vector (slice 178 hardening C2). spawnSync because
    // git-context is built synchronously before the harness
    // event loop is up.
    const git = getGitBinarySync();
    const result = Bun.spawnSync({
      cmd: [git, ...args],
      cwd,
      env: safeGitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
};

const probeBranch = (cwd: string): string | undefined => {
  const out = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (out === null || out.length === 0) return undefined;
  // `HEAD` literal indicates detached state — not a branch
  // name; the env section is more useful when omitting the
  // line entirely than when claiming the branch is "HEAD".
  if (out === 'HEAD') return undefined;
  return out;
};

const probeStatus = (cwd: string): { modified: number; untracked: number } | undefined => {
  // `--porcelain=v1` keeps the output stable across git versions
  // (v2 adds extra columns we don't parse). Each line is
  // `XY path`, where X/Y in {' ', 'M', 'A', 'D', 'R', '?', ...}.
  // `??` prefix marks untracked; everything else marks tracked
  // changes (modifications, additions, renames, deletions).
  const out = runGit(cwd, ['status', '--porcelain=v1']);
  if (out === null) return undefined;
  if (out.length === 0) return { modified: 0, untracked: 0 };
  let modified = 0;
  let untracked = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('??')) untracked += 1;
    else if (line.length > 0) modified += 1;
  }
  return { modified, untracked };
};

const probeAheadBehind = (cwd: string): { ahead: number; behind: number } | undefined => {
  // `@{u}` resolves to the upstream tracking branch. Fails when
  // no upstream is configured (new branch never pushed). The
  // env section just drops the ahead/behind line in that case
  // rather than rendering "ahead 0, behind 0" (misleading —
  // implies an upstream that doesn't exist).
  const out = runGit(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  if (out === null) return undefined;
  const parts = out.split('\t').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return undefined;
  }
  return { behind: parts[0] ?? 0, ahead: parts[1] ?? 0 };
};

// Probe the env-relevant fields. Returns null when the cwd is
// not a git repo (probed via `rev-parse --is-inside-work-tree`
// — fails outside a repo). The env-prompt composer treats null
// as "skip the git block entirely".
//
// `git log` is intentionally NOT probed here — see the module
// docstring above for the threat model that motivates that
// omission.
export const probeGitContext = (cwd: string): GitContext | null => {
  // Use rev-parse --is-inside-work-tree as the cheap "is this a
  // git repo" probe. Returns "true" when inside, fails otherwise.
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return null;
  const branch = probeBranch(cwd);
  const status = probeStatus(cwd);
  const aheadBehind = probeAheadBehind(cwd);
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(status !== undefined ? { modified: status.modified, untracked: status.untracked } : {}),
    ...(aheadBehind !== undefined ? aheadBehind : {}),
  };
};
