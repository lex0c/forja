// Telemetry scrubbing layer — PERMISSION_ENGINE.md §18 line 1205
// ("OTEL export com scrubbing"). Wraps another `TelemetrySink`
// and redacts likely-PII fields before forwarding. Without this
// layer, raw events carry capability scopes that include paths
// (`read-fs:/home/john/secrets.env`), hosts
// (`net-egress:internal.corp.example.com`), and free-form
// reasons that may interpolate path strings — all of which leak
// information about the operator's filesystem and infrastructure
// to whatever metrics backend the OTEL adapter exports to.
//
// Threat model:
//   - In-scope: redact paths + hosts from capability scopes
//     before they leave the process boundary. Same defense
//     applied to `sealing.failure.path` (operator's seal file
//     location) and `state.transition.reason` (free-form text
//     that may quote underlying error messages).
//   - Out-of-scope: hash collisions / chosen-ciphertext attacks.
//     Scrubbing replaces with fixed placeholders (`<path>`,
//     `<host>`), not hashes — operators querying the metric
//     stream don't need to recover the original value (the
//     audit log has it).
//   - Out-of-scope: scoping individual operators' visibility
//     within a shared OTEL backend. Per-operator filtering is
//     OTEL-side ACLs, not the engine's job.
//
// Default policy: ALL scrubbing axes ON. Spec wording "with
// scrubbing" implies enable-by-default. Operators who explicitly
// want raw events (e.g., a local-only dev loop with no external
// export) skip wrapping with this sink entirely.

import type {
  ChainVerifyFailedEvent,
  ClassifierUnavailableEvent,
  PermissionDecisionEvent,
  SandboxDegradedActiveEvent,
  SealingFailureEvent,
  StateTransitionEvent,
  TelemetryEvent,
  TelemetrySink,
  WorkerCrashEvent,
} from './index.ts';

// Capability-scope kinds whose value-after-colon is a filesystem
// path or path-shaped identity. The engine resolvers emit these
// (see src/permissions/resolvers/fs.ts).
//
//   - `read-fs` / `write-fs` / `delete-fs` — operator filesystem
//     paths. PII-bearing.
//   - `git-write` — repo path or `*`. PII-bearing when it carries
//     a project root like `/home/op/work/private-monorepo`.
//   - `secret-access` (slice 99, R10 #46) — vault namespace or
//     credential file path. STRONGLY PII-bearing — a leaked
//     secret-access scope tells an external observer which
//     credential store the operator authorized, and an
//     adversary scraping the metric stream can target it. The
//     spec §3.1 declares secret-access scope as "identity (store
//     name)" — same shape as a path for redaction purposes.
//
// `exec-fs` was previously listed but is NOT a real capability
// kind in `CapabilityKind`. The execution kind is `exec` with a
// fixed enum scope (`shell` / `python` / `node` / `arbitrary`)
// — no path content. Slice 99 removes the dead entry (R10 #51).
const FS_KINDS = new Set(['read-fs', 'write-fs', 'delete-fs', 'git-write', 'secret-access']);

// Capability-scope kinds whose value-after-colon is a network
// host or port (slice 99, R10 #47). `net-egress` carries a host
// pattern; `net-ingress` carries a port pattern. Both leak
// infrastructure detail when surfaced to a metric backend (port
// numbers reveal internal services — 5432=postgres, 6443=k8s
// API — and bind addresses leak server identity). Both scrub
// under the same `redactHosts` axis.
const NET_KINDS = new Set(['net-egress', 'net-ingress']);

const PLACEHOLDER_PATH = '<path>';
const PLACEHOLDER_HOST = '<host>';

// Path-shaped substrings inside free-form strings (reasons,
// notes, stderr). Worst case is a missed redaction surfacing in
// a metric label; the audit log has the unredacted text for
// forensic analysis. Slice 99 (R10 #49) extends the original
// posix-only pattern to three independent shapes — applied in
// sequence so each captures its own canonical form without
// stepping on the others:
//
//   - Posix paths: `\/...` (leading slash + non-whitespace body).
//   - Windows paths: `C:\Users\foo` (drive letter + colon + back-
//     slash) AND UNC shares `\\server\share\...`.
//   - Tilde-rooted paths: `~/...` and `~user/...`. Shells expand
//     these on execution; the resolver also expands them (slice
//     97), but operator-quoted free-form text in a reason might
//     still embed the unexpanded form.
//
// Conservative on length: posix and tilde shapes require >= 2
// non-empty chars after the prefix to avoid over-redacting short
// tokens like `/etc` written as keys in operator-readable text.
// Slice 128 (R4 P1-Inj): exclude `<>|()` from the negated class so
// paths containing shell-metachar-like chars don't truncate
// mid-redaction. Aligns with the Windows variant below.
const PATH_REGEX_POSIX = /\/[^\s'":\\<>|()]{2,}/g;
const PATH_REGEX_WINDOWS = /[A-Za-z]:[\\/][^\s'":<>|]+/g;
const PATH_REGEX_UNC = /\\\\[^\s'":<>|]+/g;
const PATH_REGEX_TILDE = /~[A-Za-z0-9_-]*\/[^\s'":\\]+/g;

// Host-shaped substrings inside free-form strings (slice 99,
// R10 #50). Pre-slice `scrubReason` only redacted paths — a
// reason like "bwrap connection failed to internal.corp.example
// .com:8080" passed through with the internal hostname intact.
// Two independent shapes:
//
//   - Explicit URLs with scheme: `https://internal.corp/path`,
//     `ssh://host`, `file://...`. Matched holistically — the
//     scheme prefix is the discriminator that avoids false
//     positives in version strings ("v1.2.3" has dots but no
//     scheme).
//   - IPv4 dotted-quad: `192.168.1.1`. Bounded to four octets
//     so version strings ("99.99") and decimals ("3.14.15")
//     don't trigger.
//
// Bare DNS hostnames (`api.github.com` with no scheme) are
// intentionally NOT matched — the surrounding context is too
// often legitimate (version tuples, package names with dots).
// Falling back to the audit log for those is acceptable; the
// metric label loses fidelity but doesn't gain false-positive
// redaction noise that would hide real signals.
// Slice 128 (R4 P1-Inj): RFC 3986 scheme grammar `[a-z][a-z0-9+.-]*`
// captures any well-formed URL scheme — pre-slice the explicit
// allowlist missed `s3://`, `postgres://`, `redis://`, `vault://`,
// `mongodb+srv://`, `data:`, `git+ssh://`, etc. The captured-and-
// replaced text is operator-visible reason fields where the
// scheme + host together are the secret-bearing context.
const URL_REGEX = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>\]\)]+/g;
const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
// Slice 125 (R2 P1): IPv6 with optional bracketed port.
// Matches `[::1]:8080`, `[2001:db8::1]:443`, also bare
// `[::1]`. Conservative — only the bracketed form is matched
// to avoid false positives on hex strings.
const IPV6_BRACKETED_REGEX = /\[[0-9a-fA-F:]+\](?::\d{1,5})?/g;
// Git SSH form: `git@github.com:org/repo.git`,
// `user@host:path`. Distinguish from `user@host` URLs by the
// trailing `:path` segment. The `:path` must not start with
// `/` (that would be `host:/abs` which is rare and could
// confuse with scp's local-path-with-colon shape; the user@
// prefix here is the discriminator).
//
// Slice 128 (R4 P1-Inj): `+` added to the username class to
// match email-as-username shapes (`firstname+tag@example.com`).
// Email local-parts legally include `+`; some operators ssh
// as `user+alias@host`. Pre-slice these slipped redaction.
const GIT_SSH_REGEX = /\b[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+/g;
// Domain-only hostname with port: `internal.corp:443`,
// `db.example.com:5432`. Matches `<dnsname>:<port>` where the
// dnsname contains at least one dot. Conservative on dots to
// avoid matching `version.bumped.to:something`.
const DOMAIN_PORT_REGEX = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:\d{1,5}\b/g;

export interface ScrubOptions {
  // Redact path scopes in capability strings + path-shaped
  // substrings in reason fields. Default true.
  redactPaths?: boolean;
  // Redact host scopes in capability strings + the seal config
  // path (which is also operator-controlled FS state). Default
  // true.
  redactHosts?: boolean;
}

const scrubCapability = (cap: string, opts: Required<ScrubOptions>): string => {
  const colonIdx = cap.indexOf(':');
  if (colonIdx === -1) return cap;
  const kind = cap.slice(0, colonIdx);
  if (opts.redactPaths && FS_KINDS.has(kind)) {
    return `${kind}:${PLACEHOLDER_PATH}`;
  }
  if (opts.redactHosts && NET_KINDS.has(kind)) {
    return `${kind}:${PLACEHOLDER_HOST}`;
  }
  // Unknown kinds (e.g., `exec:shell` whose scope is a fixed enum)
  // pass through untouched.
  return cap;
};

const scrubReason = (text: string, opts: Required<ScrubOptions>): string => {
  let scrubbed = text;
  if (opts.redactPaths) {
    // Apply each path shape independently. Order matters when
    // patterns can overlap: URLs (matched below under redactHosts)
    // contain `/` characters that would otherwise be partially
    // chewed by `PATH_REGEX_POSIX`. Running URLs FIRST consumes
    // the whole scheme://path token before the posix matcher
    // sees it. The runtime cost is small — each regex scans the
    // already-reduced string left over by the previous pass.
    scrubbed = scrubbed.replace(URL_REGEX, PLACEHOLDER_HOST);
    scrubbed = scrubbed.replace(PATH_REGEX_WINDOWS, PLACEHOLDER_PATH);
    scrubbed = scrubbed.replace(PATH_REGEX_UNC, PLACEHOLDER_PATH);
    scrubbed = scrubbed.replace(PATH_REGEX_TILDE, PLACEHOLDER_PATH);
    scrubbed = scrubbed.replace(PATH_REGEX_POSIX, PLACEHOLDER_PATH);
  }
  if (opts.redactHosts) {
    // URLs already redacted above under the path axis — running
    // again is idempotent (the placeholder doesn't match the
    // scheme regex). IPv4 stays here because it's purely a host
    // axis: a reason like "192.168.1.10:5432" carries no path
    // shape but should still scrub.
    //
    // Slice 125 (R2 P1) additions: IPv6 brackets, git SSH
    // (`user@host:path`), domain:port. Ordering matters — git
    // SSH must come BEFORE domain:port because both can match
    // `host:path` shapes, and git-ssh's user@ prefix needs the
    // longer pattern. IPv6 first because brackets disambiguate
    // immediately.
    scrubbed = scrubbed.replace(URL_REGEX, PLACEHOLDER_HOST);
    scrubbed = scrubbed.replace(IPV6_BRACKETED_REGEX, PLACEHOLDER_HOST);
    scrubbed = scrubbed.replace(GIT_SSH_REGEX, PLACEHOLDER_HOST);
    scrubbed = scrubbed.replace(IPV4_REGEX, PLACEHOLDER_HOST);
    scrubbed = scrubbed.replace(DOMAIN_PORT_REGEX, PLACEHOLDER_HOST);
  }
  return scrubbed;
};

// Exposed (slice 130) so failure_events payload scrub can share
// the canonical regex set instead of forking. Caller passes
// optional ScrubOptions; defaults to both axes on (path + host)
// matching the medium-sensitivity profile of audit rows per
// AUDIT.md §1.
export const scrubFreeformText = (text: string, opts: ScrubOptions = {}): string =>
  scrubReason(text, {
    redactPaths: opts.redactPaths ?? true,
    redactHosts: opts.redactHosts ?? true,
  });

const scrubPermissionDecision = (
  e: PermissionDecisionEvent,
  opts: Required<ScrubOptions>,
): PermissionDecisionEvent => ({
  ...e,
  capabilities: e.capabilities.map((c) => scrubCapability(c, opts)),
});

const scrubSealingFailure = (
  e: SealingFailureEvent,
  opts: Required<ScrubOptions>,
): SealingFailureEvent => {
  if (!opts.redactPaths || e.path === undefined) return e;
  // The seal path is operator-controlled FS state; redact under
  // the same axis as capability paths.
  const { path: _path, ...rest } = e;
  return { ...rest, path: PLACEHOLDER_PATH };
};

const scrubStateTransition = (
  e: StateTransitionEvent,
  opts: Required<ScrubOptions>,
): StateTransitionEvent => ({
  ...e,
  reason: scrubReason(e.reason, opts),
});

const scrubChainVerifyFailed = (
  e: ChainVerifyFailedEvent,
  _opts: Required<ScrubOptions>,
): ChainVerifyFailedEvent => {
  // install_id is a hash; broken_at is numeric; expected/actual
  // are sha256 hex. None are PII-bearing. Pass through.
  return e;
};

const scrubClassifierUnavailable = (
  e: ClassifierUnavailableEvent,
  _opts: Required<ScrubOptions>,
): ClassifierUnavailableEvent => {
  // Tool name + classifier hash + reason enum: no PII. Pass through.
  return e;
};

const scrubWorkerCrashed = (
  e: WorkerCrashEvent,
  opts: Required<ScrubOptions>,
): WorkerCrashEvent => {
  // stderr is free-form text — handler crashes typically include
  // a stack trace with absolute paths. Same path regex used for
  // state.transition reasons. Tool name + sandboxProfile + cause
  // + exitCode + elapsedMs carry no PII.
  return { ...e, stderr: scrubReason(e.stderr, opts) };
};

const scrubSandboxDegradedActive = (
  e: SandboxDegradedActiveEvent,
  opts: Required<ScrubOptions>,
): SandboxDegradedActiveEvent => {
  // `reason` is free-form text — operator subsystems may quote
  // paths ("bwrap binary missing at /usr/local/bin/bwrap"). Same
  // path scrub as state.transition.reason. sessionId is
  // engine-generated UUID; firstEmission + ts are PII-free.
  return { ...e, reason: scrubReason(e.reason, opts) };
};

// Top-level dispatcher. New event types added to the union must
// add a branch here — the exhaustive switch via `kind` makes
// TS surface the missing case.
export const scrubEvent = (event: TelemetryEvent, options?: ScrubOptions): TelemetryEvent => {
  const opts: Required<ScrubOptions> = {
    redactPaths: options?.redactPaths ?? true,
    redactHosts: options?.redactHosts ?? true,
  };
  switch (event.kind) {
    case 'permission.decision':
      return scrubPermissionDecision(event, opts);
    case 'sealing.failure':
      return scrubSealingFailure(event, opts);
    case 'state.transition':
      return scrubStateTransition(event, opts);
    case 'chain.verify_failed':
      return scrubChainVerifyFailed(event, opts);
    case 'classifier.unavailable':
      return scrubClassifierUnavailable(event, opts);
    case 'worker.crashed':
      return scrubWorkerCrashed(event, opts);
    case 'sandbox.degraded_active':
      return scrubSandboxDegradedActive(event, opts);
  }
};

// Production constructor. Wraps an inner sink (typically the OTEL
// adapter, slice 77+) and redacts every event before forwarding.
// `inner.emit` throwing is propagated — same posture as direct
// sink calls; the scrubbing layer doesn't add try/catch on top
// because the wider engine's try/catch already absorbs at every
// emission site (slices 70-74).
export const createScrubbingTelemetrySink = (
  inner: TelemetrySink,
  options?: ScrubOptions,
): TelemetrySink => ({
  emit: (event) => {
    inner.emit(scrubEvent(event, options));
  },
});
