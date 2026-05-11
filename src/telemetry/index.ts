// Telemetry abstraction — PERMISSION_ENGINE.md §18 line 1175-1215.
//
// Spec calls for "OTEL export com scrubbing". This module ships
// the FOUNDATION: a typed event surface + a sink interface +
// in-memory recording sink for tests / dev. The OTEL adapter is
// a follow-up slice; the scrubbing layer is another.
//
// Design decisions for slice 70 (the foundation):
//   - Single `TelemetrySink` interface with one method (`emit`).
//     Same shape as `AuditSink` for consistency — operators who
//     understand one understand the other.
//   - Typed events as a discriminated union by `kind`. New event
//     types add a new branch; consumers (sinks, adapters) match
//     on `kind` to route. Spec's seven listed metric streams
//     (approval_rate, score_distribution, classifier_unavailable_
//     total, chain_verification_failures_total, sealing_failures_
//     total, state_transitions, approval_fatigue_proxy) each map
//     to one or more event types as later slices ship them.
//   - `permission.decision` ships first (the highest-volume +
//     most-load-bearing event — every audit emit produces one).
//     Follow-up slices add chain.verify_failed, sealing.failure,
//     state.transition, etc.
//
// Threat model surface: telemetry events carry resolved
// capabilities, policy_hash, classifier_hash, and decision
// outcomes. They do NOT carry raw args or tool outputs — those
// stay in the audit log's SQLite store, never exported. The
// scrubbing layer (future slice) adds further redaction for
// PII-likely fields (paths, hosts) before OTEL emission.

// Decision shape mirrors the audit row's union — engine emits
// 'allow' | 'deny' | 'confirm'; the bootstrap's chain-break-
// accepted path uses 'confirm-allowed' / 'confirm-denied'.
export type TelemetryDecision = 'allow' | 'deny' | 'confirm' | 'confirm-allowed' | 'confirm-denied';

export type TelemetryConfidence = 'high' | 'medium' | 'low';

// State-machine label set — mirrors `EngineState` from
// state-machine.ts. Duplicated here as a string union (rather
// than imported) so telemetry stays independent of the engine
// module. Drift between the two is caught by the wire-up types
// in bootstrap (and the conformance suite's engine_state cases).
export type TelemetryEngineState =
  | 'init'
  | 'loading-policy'
  | 'validating-chain'
  | 'ready'
  | 'degraded'
  | 'refusing';

// §7.3 sealing modes — mirrors `SealMode` from types.ts. Same
// rationale as `TelemetryEngineState`: kept as a string union
// instead of an import so telemetry stays independent of the
// permission types module. Drift caught at the bootstrap's
// wire-up where the assignment happens.
export type TelemetrySealMode = 'none' | 'worm-file' | 'git-anchored';
export type TelemetrySealOnFailure = 'degrade' | 'refuse';

// Event: one decision, one row in the audit chain. Spec §18 line
// 1179-1202 lists every field. `engine_state` is optional —
// sources that don't have access to the state controller omit
// it; production wiring (follow-up slice) plumbs a state getter
// through the sink construction.
export interface PermissionDecisionEvent {
  kind: 'permission.decision';
  ts: number;
  approval_id: number;
  parent_approval_id: string | null;
  tool: string;
  tool_version: string;
  resolver_version: string;
  capabilities: readonly string[];
  decision: TelemetryDecision;
  score: number;
  score_components: Record<string, number>;
  confidence: TelemetryConfidence;
  policy_hash: string;
  classifier_hash: string | null;
  classifier_adjust: number | null;
  sandbox_profile: string | null;
  ttl_expires_at: number | null;
  engine_state?: string;
}

// State-machine transition event — emitted on every successful
// `controller.transition(to, reason)`. Spec §18 line 1214 lists
// `state_transitions{from,to}` as a tracked metric; any
// transition INTO `refusing` is the P0 trigger. Bootstrap wires
// the controller's `onTransition` listener to forward into the
// telemetry sink so engine-driven transitions (engine.degrade,
// engine.refuse, engine.restore) also produce events via the
// shared controller.
export interface StateTransitionEvent {
  kind: 'state.transition';
  ts: number;
  from: TelemetryEngineState;
  to: TelemetryEngineState;
  reason: string;
}

// §6.4 classifier-unavailable event — emitted from inside
// `engine.check` when the classifier returns null, throws, or
// produces a schema-invalid response. Spec §18 line 1211 lists
// `classifier_unavailable_total > 5% das decisões` as the
// calibration-alarm threshold.
//
// Fires regardless of `classifierRequired`: lenient mode emits
// the event AND continues with the deterministic score; strict
// mode emits the event AND transitions the engine to degraded
// via the state controller (which produces a paired
// `state.transition` event). The `strict` field distinguishes
// the two operationally.
//
// `tool` carries the tool that was being checked — operators
// can isolate per-tool unavailability rates (e.g., the classifier
// might fail more often on bash than on read_file due to longer
// context summaries).
export interface ClassifierUnavailableEvent {
  kind: 'classifier.unavailable';
  ts: number;
  tool: string;
  classifier_hash: string;
  // Categorical failure mode. 'unavailable' = classifier returned
  // null (offline / no response); 'threw' = classifier function
  // raised an exception (schema or runtime error); 'invalid' =
  // classifier returned a value that didn't validate against the
  // expected schema.
  reason: 'unavailable' | 'threw' | 'invalid';
  // Whether `classifierRequired` was set. true → engine transitions
  // to degraded; false → engine continues with the deterministic
  // score.
  strict: boolean;
}

// §7.2 chain integrity failure event — emitted from the
// bootstrap's chain-verify branch when `sink.verifyChain()`
// returns ok:false. Fires on BOTH paths: (a) no override →
// engine transitions to refusing, (b) `acceptBrokenChain: true`
// → audit-loud `chain-break-accepted` row + engine proceeds.
// `accepted` field distinguishes the two for OTEL filtering.
//
// Spec §18 line 1212 lists `chain_verification_failures_total >
// 0` as a P0 metric — any chain break (accepted or not) is a
// retrospective tamper signal that operators must investigate.
//
// Reason values mirror `VerifyResult.reason` from audit.ts:
// `prev_hash_mismatch` (row's prev_hash doesn't link to the
// previous row's this_hash) and `this_hash_mismatch` (recomputed
// this_hash doesn't match the stored value — typically a field
// in the hash payload was mutated).
export interface ChainVerifyFailedEvent {
  kind: 'chain.verify_failed';
  ts: number;
  install_id: string;
  broken_at: number;
  reason: 'prev_hash_mismatch' | 'this_hash_mismatch';
  expected: string;
  actual: string;
  // Whether the operator opted to continue under the broken
  // chain via `--accept-broken-chain`. false → engine transitions
  // to refusing; true → chain-break-accepted audit row + engine
  // proceeds (audit-loud path).
  accepted: boolean;
}

// §7.3 sealing failure event — emitted from the bootstrap's
// `onSealFailed` callback (registered with the
// `SealingScheduler`). Each event corresponds to one rejected
// seal attempt: `store.append` returned ok:false, or the
// scheduler's `sealLatestInternal` could not produce a valid
// entry. The companion `state.transition` event (slice 71)
// fires with `to: degraded` or `to: refusing` per the policy's
// `on_failure` knob; the `sealing.failure` event carries the
// per-event diagnostic (mode + path + reason) that the
// transition's free-form `reason` field can't structurally
// expose. Spec §18 line 1213 lists `sealing_failures_total > 0
// em strict mode` as a P0 metric.
export interface SealingFailureEvent {
  kind: 'sealing.failure';
  ts: number;
  mode: TelemetrySealMode;
  // Polymorphic path (worm-file: seal file path; git-anchored:
  // repo directory). Absent for `mode: 'none'` (in practice
  // unreachable here — sealing is disabled and no scheduler is
  // wired — but the field is optional for completeness).
  path?: string;
  reason: string;
  // Configured response to this failure. The actual state
  // transition lands in a separate `state.transition` event;
  // this field documents the operator's INTENT regardless of
  // whether the engine was already in the target state (e.g.,
  // a second failure with on_failure=degrade against an already-
  // degraded engine is a no-op transition but still produces
  // this telemetry event).
  on_failure: TelemetrySealOnFailure;
}

// §13.7 broker worker crash event — emitted from the spawn
// broker (slice 84) when a worker subprocess exits without a
// usable response. Three distinct causes the broker can detect
// post-spawn:
//   - `no_response`: worker exited but emitted no parseable line
//     on stdout. Likely a hard crash (panic, OOM, signal) before
//     the handler could write its response.
//   - `invalid_response`: worker emitted a final stdout line but
//     it failed JSON.parse. Likely a corrupted write or a partial
//     emission (e.g., kill mid-flush).
//   - `missing_fields`: worker emitted a parseable JSON object
//     but the shape didn't match BrokerResponse. Indicates a
//     buggy handler or a protocol mismatch.
//
// Not emitted for: timeout (operator-known), abort (caller-
// known), spawn failure (pre-exec), sandbox wrap refusal
// (pre-exec), broker-closed errors (configuration issue),
// stdin write failed (pre-exec ish), broker-self-bug errors
// (control-plane invariant violation). Those have their own
// telemetry paths or are not crash signals.
//
// Spec §18 doesn't enumerate this metric — slice 84 adds it
// because §13.7 ("CLI main não tem exec privilege") shifts the
// failure surface to the worker, and silent crashes there
// were invisible. Operator value: `worker_crashed_total{cause}`
// is a leading indicator for broker-stack regressions
// (handler bugs, OOM under load, hostile inputs).
export interface WorkerCrashEvent {
  kind: 'worker.crashed';
  ts: number;
  cause: 'no_response' | 'invalid_response' | 'missing_fields';
  // Worker exit code. Undefined when the spawn broker never
  // observed an exit (extremely rare — would mean wait failed
  // before exited resolved, which produces a different broker
  // error). When defined, 0 = worker exited cleanly without
  // writing (a logic bug), non-zero = worker crashed.
  exitCode?: number;
  // Captured stderr — scrubbed by the scrubbing layer (path
  // regex applied). Useful for postmortem: handler crashes
  // typically dump a stack trace here. Bounded by the spawn
  // broker's stream cap (currently unlimited inside `new
  // Response().text()` — a future slice may add capping).
  stderr: string;
  // Time from spawn to detection. Discriminates fast-crash
  // (likely binary issue) from slow-crash (likely handler
  // logic). Includes the wait for `proc.exited` to resolve;
  // does NOT include broker-side translation.
  elapsedMs: number;
  // Tool name + sandbox profile for correlation with the audit
  // row that fired this call. Capabilities are deliberately
  // omitted — they'd be scrubbed anyway, and tool+profile is
  // the actionable signal for operators.
  toolName: string;
  sandboxProfile: string | null;
}

// Discriminated union of every event kind the engine emits.
// All five spec-listed metric streams have a corresponding event
// type as of slice 74. Slice 84 adds `worker.crashed` for the
// §13.7 broker-stack failure surface. Future event types
// (audit-derived aggregates like approval_fatigue_proxy) ship as
// the OTEL adapter slices wire them.
export type TelemetryEvent =
  | PermissionDecisionEvent
  | StateTransitionEvent
  | SealingFailureEvent
  | ChainVerifyFailedEvent
  | ClassifierUnavailableEvent
  | WorkerCrashEvent;

export interface TelemetrySink {
  // Fire-and-forget. Sinks MUST NOT throw — telemetry is
  // observability, not a critical path. Failures inside an
  // adapter (e.g., OTEL export down) get logged but never
  // propagate. Production sinks implement queueing /
  // backpressure to absorb burst loads.
  emit(event: TelemetryEvent): void;
}

// No-op sink — default for callers that don't wire telemetry.
// Constructed once + reused; matches the createNoopSink shape
// from audit.ts.
export const createNoopTelemetrySink = (): TelemetrySink => ({
  emit: () => {},
});

// Recording sink — captures every emitted event in-memory.
// Used by tests + the dev loop's `agent telemetry tail` verb
// (follow-up slice). Production OTEL adapter never uses this.
export interface RecordingTelemetrySink extends TelemetrySink {
  // Read-only view of every event emitted since construction
  // OR the last `clear()`.
  events(): readonly TelemetryEvent[];
  clear(): void;
}

export const createRecordingTelemetrySink = (): RecordingTelemetrySink => {
  const buffer: TelemetryEvent[] = [];
  return {
    emit: (event) => {
      buffer.push(event);
    },
    events: () => buffer.slice(),
    clear: () => {
      buffer.length = 0;
    },
  };
};

export type { ScrubOptions } from './scrubbing.ts';
export { createScrubbingTelemetrySink, scrubEvent } from './scrubbing.ts';

export type { CreateJsonLinesTelemetrySinkOptions } from './jsonlines.ts';
export { createJsonLinesTelemetrySink } from './jsonlines.ts';
