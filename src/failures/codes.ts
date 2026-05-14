// Failure code vocabulary per FAILURE_MODES.md §19 + §2 ("código
// = <classe>.<subtipo>.<detalhe>"). Codes are slow-changing and
// load-bearing: every operator query, dashboard, and retention
// policy keys on them. Drift between sites (one emits
// `sandbox.tool.unavailable`, another `sandbox.unavailable.tool`)
// would silently fragment audit history.
//
// This module is the single source of truth for:
//   1. Format rule — `^[a-z_]+(\.[a-z_]+){1,3}$`
//      (top-level class . subtype, optionally .detail.subdetail).
//   2. Vocabulary — every code the codebase actually emits, with
//      the corresponding `classe` it belongs to. Adding a new
//      code = adding an entry here AND wiring the emit site;
//      missing the entry trips `isFailureCode` at writer time.
//   3. Recovery-action conventions — TEXT-free at the DB layer
//      but a curated TS set, so typos in writer code don't ship
//      silently. New action shape = add here.
//
// Slice 130 ships 3 codes (sandbox.tool_unavailable,
// sandbox.mid_session_loss, storage.lock_contention). The rest
// of the spec catalog lands when the owning subsystem gets a
// wiring slice — better than 20 emit sites with no tests.

export type FailureClass =
  | 'provider'
  | 'tool'
  | 'sandbox'
  | 'permission'
  | 'subagent'
  | 'parse'
  | 'mcp'
  | 'storage'
  | 'bootstrap'
  | 'compliance';

export const FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'provider',
  'tool',
  'sandbox',
  'permission',
  'subagent',
  'parse',
  'mcp',
  'storage',
  'bootstrap',
  'compliance',
]);

// `<classe>.<subtipo>` minimum, up to `<classe>.<subtipo>.<detalhe>.<subdetail>`.
// Lower-case + underscore only — matches existing audit / capability
// naming conventions and keeps codes filename-safe (forensics bundle
// could one day shard NDJSON by code).
const CODE_FORMAT_RE = /^[a-z_]+(\.[a-z_]+){1,3}$/;

export const isFailureCodeFormat = (code: string): boolean => CODE_FORMAT_RE.test(code);

// Each registered code declares its top-level class. The writer
// checks both: code is in the vocabulary AND its declared class
// matches the input. A mismatch here is a bug at the call site
// (someone passed `classe: 'tool'` for `sandbox.tool_unavailable`).
//
// Slice 130 entries — each maps to a concrete emit site landed
// in this slice. Future slices append more.
export const CODE_VOCABULARY: ReadonlyMap<string, FailureClass> = new Map<string, FailureClass>([
  // Sandbox subsystem (slice 130).
  // sandbox.tool_unavailable: bootstrap detection reported no bwrap
  // / sandbox-exec on $PATH. Recovery = 'fatal' when policy
  // sandbox.required=true, otherwise 'degraded'.
  ['sandbox.tool_unavailable', 'sandbox'],
  // sandbox.mid_session_loss: tool was available at boot, no longer
  // present at spawn-time probe. The wrap silently degrades; this
  // event is the audit trail. Recovery = 'degraded'.
  ['sandbox.mid_session_loss', 'sandbox'],
  // Slice 165 (review — Batch C sandbox observability).
  // sandbox.path_resolved: detected at bootstrap, the sandbox tool
  // was found via $PATH walk instead of the canonical /usr/bin/
  // path. Recovery = 'degraded'. Pre-slice the resolver computed
  // `trustLevel='path-resolved'` + `trustWarnings` but no consumer
  // surfaced them — postmortems lost the "rodava com bwrap não-
  // canonical em /opt/bin" signal. This code is emitted from
  // bootstrap when `trustLevel !== 'canonical'`.
  ['sandbox.path_resolved', 'sandbox'],
  // Note: `sandbox.silent_passthrough` (when `maybeWrapSandboxArgv`
  // returns innerArgv unchanged due to missing sandbox tool at
  // spawn-time, despite the planner picking a non-host profile) is
  // a known observability gap. The wire-up requires plumbing a
  // failureSink reference into the per-spawn-site call chain (bg
  // manager → grep → broker), which is bigger than the slice 165
  // scope. Deferred to a future slice.
  // Storage subsystem (slice 130).
  // storage.lock_contention: SQLITE_BUSY (concurrent writer / WAL
  // checkpoint racing). Distinct from generic persist_failed so
  // operators can query "is the DB contention rate climbing?"
  // separately from "are we hitting other DB errors?".
  ['storage.lock_contention', 'storage'],
  // storage.persist_failed: any other DB exception during a
  // best-effort persistence path (FK violation post-cascade,
  // schema mismatch after a future migration, disk-full, etc.).
  // Payload carries the original error message; operator drills
  // in via the failure_events table for forensics.
  ['storage.persist_failed', 'storage'],
]);

export const isFailureCode = (code: string): boolean => CODE_VOCABULARY.has(code);

// Convention set for `recovery_action` strings. Free TEXT at the
// DB layer (the per-retry count makes a CHECK list unworkable),
// but the writer validates the SHAPE: either an exact match here,
// or one of the parameterized prefixes ('retried_<N>x',
// 'fallback_to_<name>'). Catches typos like 'retired_3x' before
// they hit the DB.
const RECOVERY_EXACT: ReadonlySet<string> = new Set([
  'fatal',
  'ignored',
  'degraded',
  'pending_repair',
]);

const RECOVERY_PREFIX_PATTERNS: readonly RegExp[] = [
  /^retried_\d+x$/, // retried_3x, retried_5x
  /^fallback_to_[a-z0-9_-]+$/, // fallback_to_anthropic_haiku
];

export const isRecoveryAction = (action: string): boolean => {
  if (RECOVERY_EXACT.has(action)) return true;
  return RECOVERY_PREFIX_PATTERNS.some((p) => p.test(action));
};

// Sentinel session_id for pre-session failures (bootstrap-tier,
// before a real session has been created). Documented here so emit
// sites and read queries agree on the literal — a typo
// ('bootsrap' / 'boot_strap') would orphan rows from forensics
// queries that filter by this sentinel.
export const BOOTSTRAP_SESSION_ID = 'bootstrap';
