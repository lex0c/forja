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
//            KNOWN LIMITATION (deferred): when the operator HAS a real
//            `~/.gitconfig`, the env identity is largely MOOT. git reads the
//            global config unconditionally, and the SBPL `(deny file-read*)`
//            makes that open() fail with EPERM — which git does NOT tolerate
//            (unlike EACCES; see `access_or_die` + `ACCESS_EACCES_OK`), so it
//            aborts with `fatal: reading the configuration files` BEFORE the
//            identity env is consulted. The fix would be to point git away
//            from the denied file (`GIT_CONFIG_GLOBAL=/dev/null` or a readable
//            sanitized file), but `scrubEnv` drops all `GIT_CONFIG_*` before
//            the inner bash, so that redirect can't be delivered without a
//            handler-level re-admission — a security-boundary change that is
//            UNTESTABLE from a Linux host. Tracked with the parallel
//            config-EPERM note in `sandbox-runner-macos.ts`. Linux (the
//            config-file bind) is unaffected.
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
const probeScoped = (
  cwd: string,
  key: string,
): Array<{ scope: string; value: string }> | undefined => {
  try {
    const { git, env } = getGitBinaryWithEnvSync();
    const readEnv: Record<string, string> = { ...env };
    // `GIT_CONFIG_NOSYSTEM` is forwarded alongside the location knobs:
    // `safeGitEnv()` builds a fresh env (doesn't inherit process.env), so
    // without this the probe would READ /etc/gitconfig even when the
    // operator disabled system config — capturing a system-level identity
    // that their real `git commit` ignores, and mis-attributing commits.
    for (const k of [
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'XDG_CONFIG_HOME',
    ]) {
      const v = process.env[k];
      if (v !== undefined && v.length > 0) readEnv[k] = v;
    }
    // `--show-scope --get-all` lists EVERY value with its origin scope in
    // increasing precedence (last wins). Crucially it EVALUATES
    // `includeIf "gitdir:"` against `cwd`'s repo — unlike `--global --get`,
    // which returns only the UNCONDITIONAL global value and silently ignores
    // conditional includes (verified). Operators commonly select
    // work/personal identity via `includeIf`; run from `cwd` so git resolves
    // the conditional the same way `git commit` in that repo would.
    const result = Bun.spawnSync({
      cmd: [git, 'config', '--show-scope', '--get-all', key],
      cwd,
      env: readEnv,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    // exit 1 = key unset; other non-zero = not-a-repo / git too old for
    // --show-scope (2.26+). Either way → no identity resolved (fail-soft).
    if (result.exitCode !== 0) return undefined;
    const out = new TextDecoder().decode(result.stdout);
    const lines: Array<{ scope: string; value: string }> = [];
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t'); // format: `<scope>\t<value>`
      if (tab < 0) continue; // blank / continuation of a multi-line value
      lines.push({ scope: line.slice(0, tab), value: line.slice(tab + 1) });
    }
    return lines;
  } catch {
    return undefined;
  }
};

// From ONE scoped read of `key`, derive both signals:
//   - `global`: the GLOBAL-LEVEL effective value — the LAST value whose
//     scope is `global` or `system`. `includeIf`'d files report `global`, so
//     this honors conditional (work/personal) identities; `local`/`worktree`
//     are EXCLUDED, keeping the attacker-controllable, precedence-handled
//     repo config out of what we deliver. Empty / control-char-tainted →
//     dropped (terminal-escape guard).
//   - `hasLocal`: whether the repo sets the key in its OWN config.
const readField = (cwd: string, key: string): { global?: string; hasLocal: boolean } => {
  const lines = probeScoped(cwd, key);
  if (lines === undefined) return { hasLocal: false };
  let lastGlobalRaw: string | undefined;
  let hasLocal = false;
  for (const { scope, value } of lines) {
    if (scope === 'global' || scope === 'system') lastGlobalRaw = value;
    else if (scope === 'local' || scope === 'worktree') hasLocal = true;
  }
  if (lastGlobalRaw === undefined) return { hasLocal };
  const v = lastGlobalRaw.trim();
  if (v.length === 0 || hasControlChar(v)) return { hasLocal };
  return { global: v, hasLocal };
};

// The operator's GLOBAL-LEVEL identity (includeIf-aware), UNGATED. Used for
// the Linux config-file delivery: the file sits at global precedence, so
// repo-local config wins naturally — no gate needed. Resolved for `cwd`'s
// repo so a `gitdir:`-conditional include picks the right identity. (The
// resolution is frozen to the session cwd; a nested repo under a DIFFERENT
// includeIf condition would see the session's resolved identity — narrow,
// and repo-local still wins for any repo that sets it.)
export const resolveGlobalGitIdentity = (cwd: string): GitIdentity => {
  const id: GitIdentity = {};
  const name = readField(cwd, 'user.name').global;
  if (name !== undefined) id.name = name;
  const email = readField(cwd, 'user.email').global;
  if (email !== undefined) id.email = email;
  return id;
};

// The operator's identity for the macOS ENV fallback, GATED per field on
// the session repo's local config: env identity outranks repo-local config,
// so we skip a field the repo sets locally (the visible local config drives
// it instead). Best-effort — only protects the session repo, not a nested
// one; the Linux file path has no such limitation.
export const resolveGitIdentity = (cwd: string): GitIdentity => {
  const id: GitIdentity = {};
  const name = readField(cwd, 'user.name');
  if (!name.hasLocal && name.global !== undefined) id.name = name.global;
  const email = readField(cwd, 'user.email');
  if (!email.hasLocal && email.global !== undefined) id.email = email.global;
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
