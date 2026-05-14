// Canonical env-var allowlist for the sandbox kernel-boundary clearenv.
// Pre-slice 162 the list lived under `sandbox-runner.ts` and the
// macOS runner had no equivalent (relied entirely on userspace
// `scrubEnv`'s denylist). The asymmetry was the structural P0 from
// the 5-axis security-in-depth review: Linux had a kernel-level
// allowlist via `bwrap --clearenv --setenv KEY VAL`, macOS had only
// the denylist, so ad-hoc credential vars (VAULT_ADDR, BW_SESSION,
// OP_CONNECT_TOKEN, FLY_API_TOKEN_*, RAILWAY_TOKEN, novel SaaS
// tokens) reached the sandboxed bash on darwin.
//
// Slice 162 closes the asymmetry: extract the list here, the macOS
// runner emits `/usr/bin/env -i KEY=VAL ... -- <inner>` as a
// userland clearenv. The inner process inherits ONLY the allowed
// vars regardless of what the spawner's `Bun.spawn({env})` passed
// in. Symmetric with the Linux bwrap path.
//
// Membership rules (must hold for every entry):
//   - Var is required by common Unix utilities to function at all
//     (PATH, HOME, USER, SHELL) OR
//   - Var carries non-credential locale/timezone info (LANG, LC_*,
//     TZ, TMPDIR) that breaks tools when missing.
//
// What's IN (and why):
//   PATH        — binary lookup
//   HOME        — tilde expansion + tools that read $HOME
//   USER/LOGNAME— identity for tools that look it up (getpwuid fallback)
//   SHELL       — bash uses $SHELL for sub-shell invocation
//   TERM        — terminal type; ncurses-based tools (less, git
//                 diff paging, tput) need it to draw
//   LANG/LC_*   — locale; missing LANG silently switches glibc to
//                 C locale and tools garble non-ASCII output
//   TZ          — timezone for date/time output; without it
//                 timestamps report UTC instead of operator-local
//   TMPDIR      — temp dir; slices 156/157 per-sandbox TMPDIR
//                 honored via this var
//
// What's OUT (and why — these are dropped at the kernel boundary):
//   LD_*, DYLD_*    — dynamic-linker injection (sanitize/env.ts
//                     blocks too — defense in depth)
//   NODE_OPTIONS    — Node code injection (--require /tmp/x.js)
//   PYTHONPATH /
//   PYTHONSTARTUP   — Python module / startup injection
//   PERL5OPT,
//   RUBY*           — same threat for those interpreters
//   BASH_ENV, ENV   — bash auto-sources on every non-interactive
//                     shell start (exact shape bash -c takes)
//   PROMPT_COMMAND  — bash evaluates on every prompt
//   BASH_FUNC_*     — Shellshock surface
//   HTTP(S)_PROXY,
//   ALL_PROXY       — any HTTP-aware tool inside sandbox honors
//                     these → MITM the sandbox's network egress
//   XDG_*           — user dirs; defaults are fine
//   DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR — host service access
//                     (secret-service, gnome-keyring, etc.)
//   GIT_*           — git config-via-env injection (slice 129)
//   SSH_AUTH_SOCK,
//   GPG_AGENT_INFO  — agent socket access; sandbox could ssh-add -l
//                     or have gpg-agent sign on its behalf
//   *_TOKEN, *_KEY,
//   *_PASS, *_SECRET — credentials (scrubEnv catches these too)
//
// Anything that looks like a credential, session socket, or
// runtime-injection hook is NOT here. Those are also dropped by
// `scrubEnv`, but the kernel-boundary allowlist is the source of
// truth — `scrubEnv` is defense in depth.
//
// Adding a new entry requires explicit justification in the
// what's-IN block above + corresponding test coverage in
// sandbox-runner.test.ts AND sandbox-runner-macos.test.ts.
export const SANDBOX_SAFE_ENV_VARS: readonly string[] = [
  // Required by exec'd tools (PATH lookups, $HOME expansion,
  // getpwuid fallback paths).
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  // Terminal capability — without TERM, ncurses-based tools
  // (`less`, `git diff` paging, tput) fail to draw.
  'TERM',
  // Locale + collation. Missing LANG silently switches glibc to
  // C locale; some tools (`git log` for non-ASCII) garble output.
  // LC_ALL takes precedence; the granular LC_* allow operators to
  // mix locales.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_MONETARY',
  // Timezone — without TZ, `date` reports UTC; tools that infer
  // local time (git log timestamps, log-emitters) report wrong
  // offsets. Operator's TZ leaks via this — acceptable trade-off
  // (no credential content; per spec §8 timezone is operator
  // metadata, not secret).
  'TZ',
  // Temp dir hint. Slices 156/157 establish per-sandbox TMPDIR on
  // darwin; the inner process honors it via this var. Linux: the
  // bwrap `--tmpfs /tmp` mount already redirects; TMPDIR set here
  // is harmless additional hint.
  'TMPDIR',
];
