// Canonical credential-path lists per PERMISSION_ENGINE.md §9.
// Both the Linux bwrap runner and the macOS sandbox-exec runner
// mask these paths inside every sandbox profile to prevent the
// LLM from reading credentials (e.g. `cat ~/.ssh/id_rsa`) via a
// sandboxed bash process that bypasses the engine-side §11
// protected paths classifier (slice 97).
//
// The two runners apply different OS-level primitives:
//   Linux:  --tmpfs <dir>            / --ro-bind-try /dev/null <file>
//   macOS:  (deny file-read* (subpath ...)) /
//           (deny file-read* (literal ...))
//
// but the path list is identical — these are platform-agnostic
// credential locations defined by the spec, and divergence
// between the two runners would create cross-platform leaks.
//
// Slice 125 (R2 P0-5) expansion: pre-slice this list covered the
// §9 canonical set (.ssh / .aws / .config/gcloud / .gnupg / .kube
// + .netrc / .docker/config.json / .npmrc / .pypirc). Reviewer
// noted drift against `src/subagents/sensitive-paths.ts` (which
// listed `.git-credentials`) AND missing coverage for cloud /
// secret-manager creds that have proliferated since §9 was
// written. The list now includes:
//
//   .terraform.d         Terraform credentials.tfrc.json + cache
//   .config/azure        Azure CLI tokens
//   .config/op           1Password CLI session
//   .config/sops         SOPS encryption keys
//   .ansible             vault password file location
//   .local/share/forja   Forja's own audit DB — the sandboxed
//                        process must not be able to mutate the
//                        hash chain via direct sqlite writes
//                        (home-rw profile exposes ~/.local/...
//                        writable; the tmpfs overlay closes it).
//   .git-credentials     Git HTTP credentials store
//   .boto                Boto / legacy AWS SDK creds

// Directories masked as opaque empty directories inside the sandbox.
//
// Slice 128 (R4 P0-Sand-1/2): added `.config/agent` and `.config/forja`.
// The sandbox boundary isn't a one-way valve — `home-rw` profile
// gives writable home, and the sandboxed process can plant config
// that the NEXT boot's bootstrap reads as authoritative:
//   - `.config/agent/permissions.yaml` is the user-scope policy
//     layer. A sandboxed call can rewrite it to disable sandbox,
//     broaden allows, or set hostAllowed:true. Session N+1 boots
//     under the tampered policy.
//   - `.config/forja/sandbox_skip` is the marker that suppresses
//     the welcome prompt (slice 122). Sandboxed process forges
//     it; operator's next forja silently runs in unsafe mode
//     without ever opting in.
// Masking both dirs at sandbox boundary closes the plant vector.
export const HIDE_PATHS_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.config/azure',
  '.config/op',
  '.config/sops',
  '.config/agent',
  '.config/forja',
  '.gnupg',
  '.kube',
  '.terraform.d',
  '.ansible',
  '.local/share/forja',
];

// Individual files masked as non-existent / empty inside the sandbox.
export const HIDE_PATHS_FILES: readonly string[] = [
  '.netrc',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.boto',
];
