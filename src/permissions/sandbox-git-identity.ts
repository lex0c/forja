// Forwards the operator's git COMMIT IDENTITY across the sandbox
// boundary so a model-issued `git commit` (via the bash tool, run
// inside the spawn broker's bwrap/sandbox-exec worker) can succeed.
//
// Why this is needed: the sandbox masks `~/.gitconfig`
// (`sandbox-hide-paths.ts` — `core.sshCommand`/`credential.helper` are
// RCE, `[user] email` is PII) AND the kernel-boundary `--clearenv`
// allowlist (`safe-env-vars.ts`) drops every `GIT_*` var. So the
// sandboxed git has no `user.name`/`user.email` and fails with
// `fatal: unable to auto-detect email address`. Forja's own checkpoint
// commits already inject a synthetic identity (`checkpoints/git.ts`);
// this does the same for the model's own commits, but with the
// OPERATOR's real identity.
//
// Why forwarding these four vars is safe (unlike the rest of `GIT_*`):
// `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/
// `GIT_COMMITTER_EMAIL` are purely DECLARATIVE — they set the commit
// author/committer strings and carry NO executable or repo-redirect
// behavior. Contrast `GIT_SSH_COMMAND`, `GIT_CONFIG_*`, `GIT_EDITOR`,
// `GIT_PAGER`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF` (exec vectors)
// and `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` (repo redirect), which
// `src/sanitize/env.ts` + the allowlist deliberately keep out. This is
// the whole justification for the carve-out.
//
// GLOBAL-only, gated on repo-local absence (review hardening):
//   - Repo-local `.git/config [user]` is NOT masked (it lives in the
//     writable cwd), so it already drives `git commit` inside the
//     sandbox. When a field is present locally we inject NOTHING for it
//     — env identity outranks repo-local config, so injecting would
//     silently OVERRIDE the repo's own identity (and, in a hostile
//     checkout, forward attacker-controlled `.git/config` content into
//     the env of every sandboxed command). We only forward the
//     GLOBAL value (the masked one — the actual bug) for fields the
//     repo does NOT set locally.
//   - Reading GLOBAL (not the merged view) keeps repo-controlled values
//     out of the injected env entirely; the injected value is always the
//     operator's own trusted global identity.
//
// Resolution MUST run in the main (unsandboxed) bootstrap process — the
// sandboxed worker sees the masked (empty) `~/.gitconfig`, so reading
// the identity there would come up empty. The resolved values are then
// handed to the runner's `passthroughEnv` channel, which re-`--setenv`s
// them past `--clearenv`.
//
// Known residual (accepted under the env-injection approach): a repo
// that relies on the GLOBAL identity gets that identity `--setenv` into
// EVERY sandboxed command's env (not just `git commit`), so a sandboxed
// process can read `$GIT_AUTHOR_EMAIL`. That is the operator's own
// global identity; scoping it per-binary is impossible over the shared
// bash-broker env channel. And a session rooted in repo A (no local
// identity) that then commits in a nested repo B lacking its own
// identity would attribute B to A's global identity — a narrow
// nested-repo edge inherent to a single session-wide env.

import { getGitBinaryWithEnvSync } from '../subagents/git-binary.ts';

export interface GitIdentity {
  name?: string;
  email?: string;
}

// A control char anywhere in a name/email would ride into GIT_AUTHOR_*
// and, since git keeps it in the commit's author string, fire as a
// terminal escape when the operator later views `git log` (title spoof,
// screen clear, OSC injection). The macOS runner already rejects CC0/CC1
// in PATHS for this exact threat (`sandbox-runner-macos.ts`); we reject
// them in VALUES too. Char-code scan (not a regex — permissions code is
// glob/prefix/scalar only per CLAUDE.md). Covers C0 (0x00–0x1F, incl.
// TAB/LF/CR — never legitimate in a single-line identity token) and
// DEL + C1 (0x7F–0x9F).
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
};

// Env for the git-config probe. Reuses the `getGitBinaryWithEnvSync`
// combinator (pins git's absolute path AND composes the spawn PATH in
// the correct order — the combinator exists to avoid the "env before
// binary" footgun) and FORWARDS the operator's real global-config
// location knobs so identities that don't live in a literal
// `~/.gitconfig` still resolve:
//   GIT_CONFIG_GLOBAL — Nix home-manager points this at /nix/store/…;
//                       the minimal `safeGitEnv()` drops it, so a plain
//                       `git config` would miss the real global config.
//   GIT_CONFIG_SYSTEM — analogous relocation of /etc/gitconfig.
//   XDG_CONFIG_HOME   — git reads `$XDG_CONFIG_HOME/git/config`; a custom
//                       value is otherwise dropped and git falls back to
//                       `~/.config/git/config`, missing the identity.
// SAFE to forward: this probe runs UNSANDBOXED in the main bootstrap
// process, reading the operator's OWN config — the sandbox boundary is
// downstream of resolution.
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
    // is truncated so it can never smuggle a second `--setenv` argv line.
    const out = new TextDecoder().decode(result.stdout);
    const value = (out.split('\n', 1)[0] ?? '').trim();
    return { exitCode: result.exitCode, value };
  } catch {
    return undefined;
  }
};

// True iff the repo at `cwd` sets this key in its OWN local `.git/config`
// (presence gate — value cleanliness is irrelevant here; a present local
// field means the visible config drives it in-sandbox, so we must NOT
// inject and override it). `--local` errors (non-zero) outside a repo →
// treated as absent.
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

// Resolve one identity field: skip entirely if the repo sets it locally
// (visible in-sandbox, must not be overridden); else forward the
// operator's global value.
const resolveField = (cwd: string, key: string): string | undefined => {
  if (hasLocalConfig(cwd, key)) return undefined;
  return globalValue(cwd, key);
};

// Resolve the operator's git identity to FORWARD for `cwd`. Fields are
// independent: only the field(s) the repo lacks locally are pulled from
// global. Never throws.
export const resolveGitIdentity = (cwd: string): GitIdentity => {
  const id: GitIdentity = {};
  const name = resolveField(cwd, 'user.name');
  if (name !== undefined) id.name = name;
  const email = resolveField(cwd, 'user.email');
  if (email !== undefined) id.email = email;
  return id;
};

// Map a resolved identity to the passthrough env the sandbox runner
// forwards across `--clearenv`. Empty identity → empty map (no
// injection; a bare git commit then fails exactly as it would without a
// sandbox — the operator's responsibility to configure an identity).
//
// Author and committer are set to the SAME identity, matching what
// `git commit` derives from a single `[user]` config block.
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
