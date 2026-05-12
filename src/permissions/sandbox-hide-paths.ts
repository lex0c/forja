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

// Directories carrying SSH keys, AWS creds, GCP creds, GPG
// secret keys, Kubernetes contexts. Masked as opaque empty
// directories inside the sandbox.
export const HIDE_PATHS_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.config/gcloud',
  '.gnupg',
  '.kube',
];

// Individual files: curl/wget HTTP/FTP creds (.netrc), Docker
// registry token (.docker/config.json), npm registry token
// (.npmrc), pip private-repo creds (.pypirc). Masked as
// non-existent / empty files inside the sandbox.
export const HIDE_PATHS_FILES: readonly string[] = [
  '.netrc',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
];
