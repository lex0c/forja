// Template for `.agent/permissions.yaml` written by `agent init`.
// Spec: AGENTIC_CLI.md §8 (the policy schema) + §2.1 (init mode).
//
// Posture: ask-on-everything for bash with a deny-list of obvious
// catastrophes. Every command the model proposes surfaces a modal
// to the operator — there is no silent-execute allowlist — so the
// operator stays in the loop on every shell side effect. The
// catch-all `confirm: ['*']` rule takes the spot the prior
// curated allowlist filled; deny rules still win and short-
// circuit the modal for patterns that should never run.
//
// Trade-off the operator is opting into:
//   + every bash call is observed; no silent execution path
//   + the YAML is short and readable (one rule, not 16 patterns)
//   + the operator sees the literal command before approval
//   - frequent safe ops (`git status`, `ls`) pop a modal each
//     time; iterate-on-failures loops feel slower
//   - operators who prefer per-pattern allow can still narrow
//     down by replacing the catch-all with explicit allow lists
//
// fs.read / fs.write / fs.edit / search keep the curated path-
// shape rules — the bash catch-all is deliberately scoped to
// shell commands, where the surface is most adversarial and the
// command text itself is the audit signal. Path-rule symmetry
// can be a follow-up if operators ask for it.
//
// Path-shape rules protect `.env`, `.git/`, and `node_modules`
// from accidental writes; fetch_url denies loopback to keep the
// model away from local services.
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
    # Catch-all: every bash command pops a modal asking the
    # operator. No silent allowlist. The operator sees the literal
    # command text and decides per invocation. Replace this rule
    # with explicit allow patterns (e.g. "bun test*", "git status")
    # to silence frequent safe ops once you're comfortable with the
    # agent's behavior in this project.
    confirm:
      - "*"
    # Patterns we never want to see, even via the catch-all confirm.
    # Deny rules win over confirm regardless of mode.
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
`;
