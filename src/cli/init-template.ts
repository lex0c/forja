// Template for `.agent/permissions.yaml` written by `agent init`.
// Spec: AGENTIC_CLI.md §8 (the policy schema) + §2.1 (init mode).
//
// Posture: conservative allowlist for read-only inspection commands
// + catch-all confirm for everything else + deny for the obvious
// catastrophes. The allow list cuts modal fatigue on the very
// frequent dev-loop commands (git status, ls, version probes)
// without surfacing the question every iteration. Anything not
// in the allow list still pops a modal; deny rules still win.
//
// Allowlist scope is deliberately narrow:
//   - read-only inspection (no commands that read FILE CONTENTS
//     like cat/head/tail/rg — those can target .env or other
//     secrets and the bash matcher doesn't honor fs.read's
//     deny_paths)
//   - no writes (no `git commit`, no `git branch -d`, no
//     redirects)
//   - exact patterns where flag space would be risky
//     (versions; pwd; whoami)
//
// Glob-injection caveat: a pattern like `git status*` admits
// `git status; rm -rf .` because `*` matches `;`, `&&`, `|`,
// `$(...)`. The deny list below catches the most catastrophic
// shapes (rm -rf root/home, sudo, curl|sh) but cannot enumerate
// every injection. Operators concerned about command injection
// in untrusted agent code should narrow allows to exact patterns
// or migrate to a sandboxed shell (TODO Tier 4: AST-based bash
// matching).
//
// fs.read / fs.write / fs.edit / search keep their curated
// path-shape rules. Path-shape rules protect `.env`, `.git/`,
// and `node_modules` from accidental writes; fetch_url denies
// loopback to keep the model away from local services.
//
// Comments inline so an operator opening the file in their editor
// understands what each section does without flipping to the spec.
// The mode parameter tunes the header line so the rest of the
// posture stays correct under acceptEdits (write/edit confirms
// auto-resolve to allow there per AGENTIC_CLI §8; the bash
// catch-all is `confirm`, not `allow`, so acceptEdits does NOT
// auto-resolve it — bash always asks unless the operator narrows
// the rule).

export type InitMode = 'strict' | 'acceptEdits';

export const renderInitTemplate = (
  mode: InitMode,
): string => `# .agent/permissions.yaml — Forja permission policy.
#
# Spec: AGENTIC_CLI.md §8. Hierarchy: enterprise > user > project
# (this file) > session. Matching is prefix + glob (no regex).
#
# Modes:
#   strict       confirm what is confirmable, deny the rest (default)
#   acceptEdits  auto-allow confirm rules; still respect deny
#   bypass       no gating (requires explicit --dangerous; not
#                scaffolded by 'agent init' — set by hand)

defaults:
  mode: ${mode}

tools:
  bash:
    # Read-only inspection that the agent runs constantly during
    # iterate-on-failures loops. Allow silences these so the
    # operator only sees a modal for novel actions. Add or remove
    # patterns to fit your project's most-frequent safe ops.
    #
    # Note on glob injection: a pattern like "git status*" admits
    # "git status; <anything>" because the trailing "*" matches
    # shell metacharacters (";", "&&", "|", "$(...)"). The deny
    # list below catches the most catastrophic shapes; for
    # hardened isolation, switch the allow patterns to exact-match
    # (drop the trailing "*").
    allow:
      # Git inspection (read-only flows).
      - "git status"
      - "git status -*"
      - "git status --*"
      - "git diff"
      - "git diff -*"
      - "git diff --*"
      - "git diff HEAD*"
      - "git log"
      - "git log -*"
      - "git log --*"
      - "git show"
      - "git show -*"
      - "git show HEAD*"
      # File listing (NOT reading content — cat/head/tail/rg
      # stay confirm because their args can target .env or
      # other secret files).
      - "ls"
      - "ls -*"
      - "ls --*"
      # Working directory + identity (exact, no flags).
      - "pwd"
      - "whoami"
      # Tool version probes (exact). Universally safe and
      # frequent during environment debugging.
      - "git --version"
      - "node --version"
      - "bun --version"
      - "npm --version"

    # Everything else surfaces a modal so the operator sees the
    # literal command before approval.
    confirm:
      - "*"

    # Patterns we never want to see, even via the catch-all confirm.
    # Deny rules win over allow / confirm regardless of mode.
    deny:
      - "rm -rf /*"
      - "rm -rf ~*"
      - "rm -rf $HOME*"
      - "sudo*"
      - "curl * | sh*"
      - "wget * | sh*"
      - "* > /dev/sd*"
      - ":(){ :|:& };:"

  read_file:
    allow_paths:
      - "./**"
    deny_paths:
      - "**/.env*"
      - "**/secrets/**"
      - "**/*.pem"
      - "**/*.key"
      - "**/.git/objects/**"

  write_file:
    confirm_paths:
      - "./**"
    deny_paths:
      - "**/.env*"
      - "**/secrets/**"
      - "**/.git/**"
      - "**/node_modules/**"

  edit_file:
    confirm_paths:
      - "./**"
    deny_paths:
      - "**/.env*"
      - "**/secrets/**"
      - "**/.git/**"
      - "**/node_modules/**"

  glob:
    allow_paths:
      - "./**"
    deny_paths:
      - "**/.git/objects/**"

  grep:
    allow_paths:
      - "./**"
    deny_paths:
      - "**/.git/objects/**"

  fetch_url:
    # Loopback + cloud metadata. Private network ranges (10/8,
    # 172.16/12, 192.168/16) need CIDR support the matcher
    # doesn't have; add explicit hosts here when you need them.
    # Metadata addresses are common SSRF targets (a fetched URL
    # redirecting to 169.254.169.254 exfiltrates IAM creds), so
    # they're denied even when the operator hasn't configured an
    # internal network policy.
    deny_hosts:
      - "localhost"
      - "127.0.0.1"
      - "::1"
      - "0.0.0.0"
      - "169.254.169.254"
      - "metadata.google.internal"
      - "metadata.goog"
      - "fd00:ec2::254"

    # Additive over the hardcoded DEFAULT_TRUSTED_HOSTS (github.com
    # + npm/yarn/pypi/crates registries). Hosts listed here do NOT
    # trigger the risk-score's untrusted_egress feature for this
    # project — useful for internal CDNs, GitHub Enterprise, or
    # other endpoints outside the public default set. NOT an
    # allowlist: deny_hosts above still wins.
    trusted_hosts: []
`;
