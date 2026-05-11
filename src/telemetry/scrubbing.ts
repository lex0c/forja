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
  SealingFailureEvent,
  StateTransitionEvent,
  TelemetryEvent,
  TelemetrySink,
} from './index.ts';

// Capability-scope kinds whose value-after-colon is a filesystem
// path. The engine resolvers emit these (see src/permissions/
// resolvers/fs.ts). `git-write` is included because its scope is
// typically a repo path or `*`.
const FS_KINDS = new Set(['read-fs', 'write-fs', 'delete-fs', 'exec-fs', 'git-write']);

// Capability-scope kinds whose value-after-colon is a network
// host. Only `net-egress` today; future kinds (net-ingress,
// dns-resolve) would land here.
const NET_KINDS = new Set(['net-egress']);

const PLACEHOLDER_PATH = '<path>';
const PLACEHOLDER_HOST = '<host>';

// Path-shaped substrings inside free-form strings (reasons,
// notes). Matches a leading `/` followed by non-whitespace,
// non-quote, non-colon chars. Conservative: avoids over-redacting
// short tokens like `/etc` keys in operator-readable text. Worst
// case is a missed redaction surfacing in a metric label; the
// audit log has the unredacted text for forensic analysis.
const PATH_REGEX = /\/[^\s'":\\]{2,}/g;

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
  if (!opts.redactPaths) return text;
  return text.replace(PATH_REGEX, PLACEHOLDER_PATH);
};

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
