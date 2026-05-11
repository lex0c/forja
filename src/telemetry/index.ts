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

// Discriminated union of every event kind the engine emits.
// Future slices extend with chain.verify_failed,
// sealing.failure, state.transition, etc.
export type TelemetryEvent = PermissionDecisionEvent;

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
