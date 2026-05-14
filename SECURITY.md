# Security Policy

This file describes how to report a security issue in Forja and what to expect after reporting. For the technical architecture (threat model, permission engine internals, sandbox profiles, audit chain), see [`docs/SECURITY.md`](docs/SECURITY.md). For the operator audit guide, see [`docs/AUDIT.md`](docs/AUDIT.md).

## Supported versions

Forja is pre-1.0 and solo-maintained. Only the `main` branch and the most recent tag receive security fixes. Older tags are not patched in place — please update to current before reporting.

## Reporting a vulnerability

**Use GitHub's private security advisory channel:**

→ https://github.com/lex0c/forja/security/advisories/new

This gives the maintainer a private space to triage, develop a fix, and coordinate disclosure without exposing the vulnerability publicly.

**Do not open a public issue** for vulnerabilities. Functional bugs (crashes, wrong outputs, performance regressions) are fine to file in the public tracker; vulnerabilities that allow bypassing the security model are not.

If for some reason you cannot use GitHub's advisory channel, reach out via the contact info on the maintainer's GitHub profile.

## What to include

A useful report contains:

1. **Forja version / commit hash** the issue reproduces on.
2. **Reproduction steps** — minimal, deterministic if possible.
3. **Impact** — what the attacker can achieve. Be specific: "exfil credentials from `~/.ssh/`" beats "the sandbox is broken".
4. **Proof of concept** — exploit code, screenshots, audit log excerpts. Redact your own secrets before sharing.
5. **Suggested fix or mitigation** if you have one (optional).

## Response timeline

This is a solo-maintained project. Realistic targets, not contractual commitments:

- **Acknowledgment**: within 72 hours of report.
- **Triage + severity assessment**: within 1 week.
- **Fix landed in `main`**: depends on severity, targeting 30 days for critical, 90 days for medium, best-effort for low.
- **Coordinated public disclosure**: after a fix lands and reasonable time has passed for users to update (typically 7–14 days post-fix).

Reporters get credited in release notes unless they request anonymity.

## In scope

Issues affecting the security model documented in [`docs/SECURITY.md`](docs/SECURITY.md):

- **Permission engine bypass** — making the engine return `allow` when policy + rules + score should refuse, or making it return `deny`/`confirm` skip a step that should fire.
- **Sandbox escape** — reading or writing outside the profile's declared scope, bypassing `HIDE_PATHS`, escaping the PID/network namespace.
- **Audit chain forgery** — rewriting `approvals_log` rows undetected by `agent permission verify`, or forging seal store entries that pass `seal-verify`.
- **Credential exfiltration** — paths that leak env vars / file contents from masked directories despite `scrubEnv` + `HIDE_PATHS`.
- **Cross-session pollution** — failure events or outcome signals attributed to the wrong session, or audit rows from session A planted on session B.
- **MCP tool injection** — malicious MCP server inducing engine to authorize calls outside its declared capabilities.
- **Subagent envelope escape** — child subagent operating outside the parent's `effective_capabilities` envelope.
- **Resolver bypass** — bash AST shapes, fetch URLs, or fs paths the resolver accepts which should refuse (capability laundering, SSRF, protected-path read/write).
- **Proto-pollution** at IPC boundaries (broker, subagent permission proxy).
- **TOCTOU windows** the resolver decided on path X but the tool acted on different content.

## Out of scope

Documented in [`docs/SECURITY.md`](docs/SECURITY.md) §1.2 and §8. Reports falling exclusively in these categories will be acknowledged but treated as functional/operational issues, not security vulnerabilities:

- **Kernel-level adversary** — root on the operator's machine defeats every defense above. The audit chain detects post-facto rewrites; it cannot prevent them.
- **Multi-tenant assumptions** — Forja is single-operator software. Reports of "tenant A can attack tenant B in shared infra" are out of scope.
- **Side channels** — timing, cache, power, memory residue. The sandbox does not isolate below the syscall layer.
- **Social engineering** — operator deliberately confirming a malicious modal is not a Forja bug.
- **Third-party dependencies** — please report to the upstream first; if a Forja-specific exploitation chain exists, then report here.
- **Provider-side issues** — prompt injection at the LLM provider, model hallucinations, provider API bugs. Forja's defenses are downstream of provider output; the upstream channel is the right venue.
- **Denial of service via budget exhaustion** — `maxSteps` / `maxCostUsd` / `maxWallClockMs` are intentional bounds, not bypasses. Reports of "LLM can be made to hit maxSteps and stop the session" are working-as-intended.
- **Windows platform support** — sandbox is unimplemented on Windows by design (`docs/SECURITY.md` §1.2 #1).

## Public disclosure of past issues

Disclosed security issues are documented in release notes. The first slice with a CVE or coordinated disclosure will populate this section.

(None to date.)

## Acknowledgments

Researchers credited for responsible disclosure will be listed here once any reports come in.

(None to date.)
