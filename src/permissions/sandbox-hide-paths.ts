// Canonical credential-path lists. Both the Linux bwrap runner
// and the macOS sandbox-exec runner mask these paths inside every
// sandbox profile to prevent the LLM from reading credentials
// (e.g. `cat ~/.ssh/id_rsa`) via a sandboxed bash process that
// bypasses the engine-side protected-paths classifier.
//
// The two runners apply different OS-level primitives:
//   Linux:  --tmpfs <dir>            / --ro-bind-try /dev/null <file>
//   macOS:  (deny file-read* (subpath ...)) /
//           (deny file-read* (literal ...))
//
// but the path list is identical — these are platform-agnostic
// credential locations, and divergence between the two runners
// would create cross-platform leaks.
//
// Coverage:
//   .ssh / .aws / .config/gcloud / .gnupg / .kube — canonical
//                          cloud + secret-manager creds.
//   .terraform.d         — Terraform credentials.tfrc.json + cache
//   .config/azure        — Azure CLI tokens
//   .config/op           — 1Password CLI session
//   .config/sops         — SOPS encryption keys
//   .ansible             — vault password file location
//   .local/share/forja   — Forja's own audit DB — the sandboxed
//                          process must not mutate the hash chain
//                          via direct sqlite writes (home-rw
//                          profile exposes ~/.local/... writable;
//                          the tmpfs overlay closes it).
//   .git-credentials     — Git HTTP credentials store
//   .boto                — Boto / legacy AWS SDK creds

// Directories masked as opaque empty directories inside the sandbox.
//
// `.config/forja`: the sandbox boundary isn't a one-way valve —
// `home-rw` profile gives writable home, and the sandboxed process
// can plant config that the NEXT boot's bootstrap reads as
// authoritative:
//   - `.config/forja/permissions.yaml` is the user-scope policy
//     layer. A sandboxed call can rewrite it to disable sandbox,
//     broaden allows, or set hostAllowed:true. Session N+1 boots
//     under the tampered policy.
//   - `.config/forja/sandbox_skip` is the marker that suppresses
//     the welcome prompt. Sandboxed process forges it; operator's
//     next forja silently runs in unsafe mode without ever
//     opting in.
//
// `.rustup` holds the operator's installed toolchains AND
// `settings.toml` (defaults, proxies, profile metadata). A
// hostile bg process could pin a malicious default-toolchain
// pointing at a planted binary in
// `.rustup/toolchains/<x>/bin/`. `cargo`'s shim resolves via
// `~/.rustup` so the planted binary runs on the operator's next
// `cargo build` outside the sandbox.
//
// `.subversion/auth` is the credentials cache (Windows-style
// keyring fallback path, used on Linux/macOS when no system
// keyring is available). Plain-text on disk before recent svn
// versions; even modern svn stores enough in this dir to ship to
// a remote. Mask the `auth` subdir only, not all of
// `.subversion` — the rest of svn config is legitimate to read.
export const HIDE_PATHS_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.config/azure',
  '.config/op',
  '.config/sops',
  '.config/forja',
  '.gnupg',
  '.kube',
  '.terraform.d',
  '.ansible',
  '.local/share/forja',
  '.rustup',
  '.subversion/auth',
];

// Individual files masked as non-existent / empty inside the
// sandbox.
//
// `.gitconfig` is NOT just config — `core.sshCommand`,
// `core.pager`, `core.editor`, `core.askpass`, `[alias] *`,
// `credential.helper` are ALL executable hooks that fire on
// standard git operations. A sandboxed write to ~/.gitconfig
// followed by an outside-sandbox `git pull` runs the planted
// `core.sshCommand` value as a shell. Read access alone leaks
// `[user] email` / `[github] user` PII; write access is RCE.
//
// `.cargo/credentials.toml` holds the crates.io API token; a
// read leak grants the LLM publish rights on every crate the
// operator owns.
export const HIDE_PATHS_FILES: readonly string[] = [
  '.netrc',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.boto',
  '.gitconfig',
  '.cargo/credentials.toml',
  // Package-manager auth/config that can carry registry tokens. Exposed
  // read-only by the base `--ro-bind / /`, so without masking a sandboxed
  // `cat` could read them. The opt-in persistent cache exposes only the
  // package managers' CACHE subdirs (`~/.cache/forja/cache/{nuget,composer}`),
  // NEVER these credential files — masked here to keep that boundary.
  '.nuget/NuGet/NuGet.Config', // NuGet packageSourceCredentials (registry tokens)
  '.config/NuGet/NuGet.Config', // NuGet config — canonical XDG location on Linux/macOS
  '.config/composer/auth.json', // Composer auth (http-basic, github-oauth, gitlab-token)
  '.composer/auth.json', // Composer auth — legacy COMPOSER_HOME location
];
