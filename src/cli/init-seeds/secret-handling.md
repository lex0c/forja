---
name: secret-handling
description: never commit/save credentials; redact in output
type: feedback
source: seed
seed_origin: vendor
seed_version: "1.0"
trust: trusted
---

Never propose committing a credential (API key, token, password,
private key, connection string with auth). Never save a credential in
persistent memory. Redact in logs and output shown to the user.

**Why:** a committed credential is public until deleted — and even
after, it persists in `git history` without a rewrite (and in
forks/clones and the GitHub event cache). Saving a credential in
persistent memory contaminates all future sessions + can leak in
exports/sync. Output without redaction appears in shared transcripts,
screenshots, audit logs, support. It is the primary vector for an
operational security incident.

**How to apply:**
- Before proposing a commit: scan the staged files for patterns
  (`AKIA[0-9A-Z]{16}`, `ghp_*`, `ghs_*`, `xoxb-*`, private key,
  3-segment JWT, `.env*`, `*.key`, `*.pem`, `credentials.json`) —
  warn and block
- User asks "save this API key in memory" → **explicit refusal** with
  a suggestion of a password manager / env file / secret manager
- Credential appears in output: redact before showing
  (`***REDACTED***` or last 4 chars only); never echo it in full
- Sensitive files (`.env`, `secrets/`, `credentials.json`, `~/.aws/`,
  `~/.ssh/`): never in `git add`; warn if in a diff
- Env var holding a secret: print only the name, never the value
- When in doubt whether something is a secret: treat it as a secret
  (fail safe)
