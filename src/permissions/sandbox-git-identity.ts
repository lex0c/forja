// Delivers the operator's git COMMIT IDENTITY into the sandbox so a
// model-issued `git commit` (via the bash tool, run inside the spawn
// broker's bwrap/sandbox-exec worker) can succeed.
//
// Why this is needed: the sandbox masks `~/.gitconfig`
// (`sandbox-hide-paths.ts` — `core.sshCommand`/`credential.helper` are
// RCE, `[user] email` is PII) AND the kernel-boundary `--clearenv`
// allowlist (`safe-env-vars.ts`) drops every `GIT_*` var. So the
// sandboxed git has no `user.name`/`user.email` and fails with
// `fatal: unable to auto-detect email address`. Forja's own checkpoint
// commits already inject a synthetic identity (`checkpoints/git.ts`);
// this delivers the OPERATOR's real identity to the model's commit.
//
// TWO delivery mechanisms, one per platform (chosen so the identity does
// NOT clobber a repo's own configured identity):
//
//   Linux  — a SANITIZED global config file. The runner binds a file
//            containing ONLY `[user] name/email` (from the operator's
//            GLOBAL config) OVER the masked `~/.gitconfig`. It sits at
//            GLOBAL precedence, so a repo's own (unmasked) `.git/config
//            [user]` — including a nested repo / submodule the model
//            commits in — NATURALLY WINS, exactly as git resolves config
//            outside the sandbox. No env is touched, so no non-git
//            command sees the email either. The bind still hides the real
//            file's executable knobs (only `[user]` is exposed).
//            See `renderSanitizedGitconfig` + the runner's
//            `gitconfigMaskSource`.
//
//   macOS  — sandbox-exec has no bind primitive (it DENIES read of
//            `~/.gitconfig`), so we fall back to ENV injection of the four
//            declarative identity vars via `passthroughEnv`. Env identity
//            OUTRANKS repo-local config, so this is gated per field on the
//            session repo's local config to avoid overriding it — a
//            best-effort mitigation; a nested repo can't be protected this
//            way (documented residual, macOS only).
//
// Why the four env vars are safe to forward (macOS path): they're purely
// DECLARATIVE — no exec / no repo-redirect — unlike `GIT_SSH_COMMAND`,
// `GIT_CONFIG_*`, `GIT_EDITOR`, `GIT_PAGER`, `GIT_PROXY_COMMAND`,
// `GIT_EXTERNAL_DIFF`, `GIT_DIR`/`GIT_WORK_TREE` which `src/sanitize/env.ts`
// + the allowlist deliberately keep out.
//
// Resolution MUST run in the main (unsandboxed) bootstrap process — the
// sandboxed worker sees the masked config, so reading the identity there
// comes up empty.

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { defaultDataDir } from '../storage/paths.ts';
import { getGitBinaryWithEnvSync } from '../subagents/git-binary.ts';

export interface GitIdentity {
  name?: string;
  email?: string;
}

// A control char anywhere in a name/email would ride into the delivered
// identity and, since git keeps it in the commit's author string, fire as
// a terminal escape when the operator later views `git log` (title spoof,
// screen clear, OSC injection). The macOS runner already rejects CC0/CC1
// in PATHS for this exact threat (`sandbox-runner-macos.ts`); we reject
// them in identity VALUES too. Char-code scan (not a regex — permissions
// code is glob/prefix/scalar only per CLAUDE.md). Covers C0 (0x00–0x1F,
// incl. TAB/LF/CR — never legitimate in a single-line identity token) and
// DEL + C1 (0x7F–0x9F).
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
};

// Env for the git-config probe. Reuses the `getGitBinaryWithEnvSync`
// combinator (pins git's absolute path AND composes the spawn PATH in the
// correct order — the combinator exists to avoid the "env before binary"
// footgun) and FORWARDS the operator's real global-config location knobs
// so identities that don't live in a literal `~/.gitconfig` still resolve:
//   GIT_CONFIG_GLOBAL — Nix home-manager points this at /nix/store/…; the
//                       minimal `safeGitEnv()` drops it otherwise.
//   GIT_CONFIG_SYSTEM — analogous relocation of /etc/gitconfig.
//   XDG_CONFIG_HOME   — git reads `$XDG_CONFIG_HOME/git/config`.
// SAFE to forward: this probe runs UNSANDBOXED in the main bootstrap
// process, reading the operator's OWN config.
const probeGit = (
  cwd: string,
  scope: '--local' | '--global',
  key: string,
): { exitCode: number; value: string } | undefined => {
  try {
    const { git, env } = getGitBinaryWithEnvSync();
    const readEnv: Record<string, string> = { ...env };
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'XDG_CONFIG_HOME']) {
      const v = process.env[k];
      if (v !== undefined && v.length > 0) readEnv[k] = v;
    }
    const result = Bun.spawnSync({
      cmd: [git, 'config', scope, '--get', key],
      cwd,
      env: readEnv,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    // First line + trim: a `--get` value with an embedded newline escape
    // is truncated so it can never smuggle content past the single-line
    // identity contract downstream.
    const out = new TextDecoder().decode(result.stdout);
    const value = (out.split('\n', 1)[0] ?? '').trim();
    return { exitCode: result.exitCode, value };
  } catch {
    return undefined;
  }
};

// True iff the repo at `cwd` sets this key in its OWN local `.git/config`.
// `--local` errors (non-zero) outside a repo → treated as absent.
const hasLocalConfig = (cwd: string, key: string): boolean => {
  const r = probeGit(cwd, '--local', key);
  return r !== undefined && r.exitCode === 0 && r.value.length > 0;
};

// The operator's GLOBAL value for a field, or undefined (key unset →
// non-zero exit; empty; or control-char-tainted → rejected).
const globalValue = (cwd: string, key: string): string | undefined => {
  const r = probeGit(cwd, '--global', key);
  if (r === undefined || r.exitCode !== 0 || r.value.length === 0) return undefined;
  if (hasControlChar(r.value)) return undefined;
  return r.value;
};

// The operator's GLOBAL identity, UNGATED. Used for the Linux config-file
// delivery: the file sits at global precedence, so repo-local config wins
// naturally — no gate needed.
export const resolveGlobalGitIdentity = (cwd: string): GitIdentity => {
  const id: GitIdentity = {};
  const name = globalValue(cwd, 'user.name');
  if (name !== undefined) id.name = name;
  const email = globalValue(cwd, 'user.email');
  if (email !== undefined) id.email = email;
  return id;
};

// The operator's identity for the macOS ENV fallback, GATED per field on
// the session repo's local config: env identity outranks repo-local
// config, so we skip a field the repo sets locally (the visible local
// config drives it instead). Best-effort — only protects the session repo,
// not a nested one; the Linux file path has no such limitation.
export const resolveGitIdentity = (cwd: string): GitIdentity => {
  const id: GitIdentity = {};
  if (!hasLocalConfig(cwd, 'user.name')) {
    const name = globalValue(cwd, 'user.name');
    if (name !== undefined) id.name = name;
  }
  if (!hasLocalConfig(cwd, 'user.email')) {
    const email = globalValue(cwd, 'user.email');
    if (email !== undefined) id.email = email;
  }
  return id;
};

// gitconfig double-quoted value: escape `\` and `"` so a name/email
// containing `;`/`#` (config comment chars), quotes, or backslashes
// round-trips exactly instead of being truncated at a comment. Control
// chars are already rejected upstream, so no newline/tab can appear.
// split/join, not regex (permissions code is regex-free per CLAUDE.md).
const quoteConfigValue = (v: string): string =>
  `"${v.split('\\').join('\\\\').split('"').join('\\"')}"`;

// Render the SANITIZED global gitconfig — ONLY the `[user]` section, so the
// bind that masks the operator's real `~/.gitconfig` exposes the identity
// WITHOUT any of its executable knobs (core.sshCommand, credential.helper,
// aliases, …). null when there's nothing to deliver.
export const renderSanitizedGitconfig = (id: GitIdentity): string | null => {
  const lines: string[] = [];
  if (id.name !== undefined && id.name.length > 0) {
    lines.push(`\tname = ${quoteConfigValue(id.name)}`);
  }
  if (id.email !== undefined && id.email.length > 0) {
    lines.push(`\temail = ${quoteConfigValue(id.email)}`);
  }
  if (lines.length === 0) return null;
  return `[user]\n${lines.join('\n')}\n`;
};

// Write the sanitized gitconfig for `id` and return its absolute path, or
// null when there's no identity to deliver. Lives under the data dir;
// mode 0600 (holds the operator's email). Best-effort: null on write
// failure → no bind → the normal empty mask applies (identity absent,
// same as before this feature).
//
// CONTENT-ADDRESSED filename (`sandbox-gitconfig-<sha>`), NOT a shared
// mutable one: the broker captures this path at boot and re-reads it (as a
// bind SOURCE) on every later spawn, so a fixed `sandbox-gitconfig` would
// let a SECOND concurrent session's bootstrap overwrite it and hand the
// FIRST session the wrong author on its next commit. Hashing the content
// gives each distinct identity its own immutable file (same identity →
// same file, idempotent; bounded accumulation — one tiny file per distinct
// identity). Written to a pid-suffixed temp + atomic rename so a concurrent
// same-identity write can't expose a torn read to a mid-flight bind.
export const ensureSanitizedGitconfigFile = (
  id: GitIdentity,
  dir: string = defaultDataDir(),
): string | null => {
  const content = renderSanitizedGitconfig(id);
  if (content === null) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const p = joinPath(dir, `sandbox-gitconfig-${digest}`);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, p);
    return p;
  } catch {
    return null;
  }
};

// Map a resolved identity to the passthrough env for the macOS ENV path.
// Author and committer are set to the SAME identity, matching what
// `git commit` derives from a single `[user]` config block. Empty identity
// → empty map (no injection).
export const gitIdentityPassthroughEnv = (id: GitIdentity): Record<string, string> => {
  const out: Record<string, string> = {};
  if (id.name !== undefined && id.name.length > 0) {
    out.GIT_AUTHOR_NAME = id.name;
    out.GIT_COMMITTER_NAME = id.name;
  }
  if (id.email !== undefined && id.email.length > 0) {
    out.GIT_AUTHOR_EMAIL = id.email;
    out.GIT_COMMITTER_EMAIL = id.email;
  }
  return out;
};
