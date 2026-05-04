// Template for `.agent/permissions.yaml` written by `agent init`.
// Spec: AGENTIC_CLI.md §8 (the policy schema) + §2.1 (init mode).
//
// Posture: strict default-deny with a conservative whitelist that
// covers the common read-only operations (`git status`, `ls`, `rg`,
// `cat`) without prompting; observable mutations (`git push`,
// `git commit`, `rm`, package installs) ask for confirm; obvious
// catastrophes (`rm -rf /*`, `sudo`, `curl | sh`) are denied
// outright. Path-shape rules protect `.env`, `.git/`, and
// `node_modules` from accidental writes; fetch_url denies
// loopback to keep the model away from local services.
//
// Comments inline so an operator opening the file in their editor
// understands what each section does without flipping to the spec.
// The mode parameter tunes the header line so the rest of the
// posture stays correct under acceptEdits (write/edit confirms
// auto-resolve to allow there per AGENTIC_CLI §8).

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
    # Read-only / inspection commands run silently. Test runners
    # ('bun test', 'npm test') are here too: they execute the
    # operator-authored test contract, and confirming each run
    # would burn the operator's attention budget across a typical
    # iterate-on-failures loop.
    allow:
      - "git status"
      - "git diff*"
      - "git log*"
      - "git show*"
      - "git branch*"
      - "ls*"
      - "rg*"
      - "cat *"
      - "head *"
      - "tail *"
      - "wc *"
      - "pwd"
      - "echo *"
      - "bun test*"
      - "npm test*"
      - "bun run typecheck*"
      - "bun run lint*"
    # Observable mutations prompt the operator.
    confirm:
      - "git add*"
      - "git commit*"
      - "git push*"
      - "git pull*"
      - "git checkout*"
      - "git merge*"
      - "git rebase*"
      - "rm *"
      - "mv *"
      - "mkdir *"
      - "npm install*"
      - "npm run*"
      - "bun install*"
      - "bun run*"
    # Patterns we never want to see, even with confirm.
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
