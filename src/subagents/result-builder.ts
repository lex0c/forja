import type { HarnessResult } from '../harness/index.ts';
import type { WorktreeOutcome } from './types.ts';

export interface RunSubagentResult {
  output: string;
  sessionId: string;
  status: HarnessResult['status'];
  // The harness's ExitReason union plus subagent-runtime reasons
  // for pre-run / IPC-layer failures the harness never sees.
  // Consumers that branch on this string should match positively
  // on known values (`done`, `maxSteps`, etc.) and treat the
  // rest as opaque diagnostic text — the union grows as new
  // failure modes are added (heartbeat_timeout,
  // subprocess_crashed, etc.).
  reason:
    | HarnessResult['reason']
    // Parent-runtime synthesized — set when the child never
    // reaches the harness loop OR dies before publishing a
    // payload. Never emitted by the child itself.
    | 'worktree_create_failed'
    | 'subprocess_crashed'
    | 'subprocess_spawn_failed'
    | 'heartbeat_stale'
    | 'ipc_version_mismatch'
    // Child-emitted (subagent-child.ts startup-refusal paths).
    // The child publishes these in `setSubagentPayload` BEFORE
    // entering the harness loop when its bootstrap detects an
    // unrecoverable misconfiguration. The parent's payload
    // validator preserves them verbatim so callers branching on
    // specific failure codes (audit telemetry, retry logic,
    // operator diagnostics) keep their fidelity.
    | 'unknown_model'
    | 'unknown_tool'
    | 'subagent_load_failed'
    // Child-emitted post-harness contract violation (PLAYBOOKS.md
    // §1.2). The harness ran cleanly to `done`, but the terminal
    // assistant text didn't match the playbook's declared
    // `output_schema` — even after the one-shot retry pass. The
    // child synthesizes this envelope in `subagent-child.ts` and
    // we preserve it verbatim so /<playbook> scrollback,
    // task_sync / task_await tool errors, and audit telemetry can
    // distinguish "model violated the contract" from generic
    // `internalError` (which would otherwise mask the cause).
    | 'playbook.output_invalid';
  costUsd: number;
  steps: number;
  durationMs: number;
  auditFailure?: { code: string; message: string };
  worktree?: WorktreeOutcome;
  worktreeError?: { code: string; message: string };
  // Abort discriminator. Populated only on
  // `reason === 'aborted'`:
  //   - 'soft' — operator pressed Esc once; the child's harness
  //     exited at the next step boundary cleanly (no preempted
  //     tool). Reached when the parent sent `interrupt:soft` over
  //     IPC and the child's session_finished arrived inside the
  //     grace window.
  //   - 'hard' — operator escalated; the child was preempted
  //     mid-step (signal abort in-flight). Reached when the
  //     parent sent `interrupt:hard` OR the soft escalation
  //     timed out.
  // Undefined for every non-abort outcome; set explicitly when
  // the wire carried the resolution.
  abortCause?: 'soft' | 'hard';
}

// Convert the child's payload envelope into a strongly-typed
// `RunSubagentResult`. Defensive on every field: a payload from
// a misconfigured / corrupted child must not crash the parent's
// poller. Each missing or wrong-typed field falls back to a
// safe default that surfaces as 'error' / reason='internalError'
// downstream when it matters.
// Closed sets of values the parent will accept from the child's
// envelope. Without validation here, a buggy or malicious child
// publishing `status: "evil"` would land downstream as
// `completeSession(db, id, 'evil', ...)`, where the `sessions.status`
// CHECK constraint throws and the caller's catch block silently
// swallows it. Result: phantom `running` row that no future
// stale-session sweeper can clean up. Validating at the trust
// boundary keeps every downstream consumer honest.
//
// Compile-time exhaustiveness: the maps are typed as
// `Record<Union, true>` so TypeScript refuses to compile if a new
// status / reason variant lands upstream (in HarnessResult) and
// this validator forgets to list it. The previous "list of
// strings" shape silently drifted when `providerError`,
// `maxToolErrors`, and `scriptExhausted` were added to ExitReason
// — children exiting on those landed as `internalError`,
// misclassifying real failures (provider outages, tool error
// budget exhaustion) and breaking telemetry that branched on the
// original reason. The Record shape catches that drift the next
// time someone extends the upstream union.
const VALID_STATUS_MAP: Record<RunSubagentResult['status'], true> = {
  done: true,
  interrupted: true,
  exhausted: true,
  error: true,
};
const VALID_STATUS: ReadonlySet<RunSubagentResult['status']> = new Set(
  Object.keys(VALID_STATUS_MAP) as RunSubagentResult['status'][],
);

const VALID_REASON_MAP: Record<RunSubagentResult['reason'], true> = {
  // HarnessResult['reason'] (= ExitReason in harness/types.ts)
  done: true,
  maxSteps: true,
  maxWallClockMs: true,
  maxOutputTokens: true,
  maxCostUsd: true,
  maxToolErrors: true,
  degenerateLoop: true,
  aborted: true,
  providerError: true,
  internalError: true,
  scriptExhausted: true,
  userPromptBlocked: true,
  // Parent-side synthesized — never appears in a child's
  // envelope, but listed for symmetry with the type union.
  worktree_create_failed: true,
  subprocess_crashed: true,
  subprocess_spawn_failed: true,
  heartbeat_stale: true,
  ipc_version_mismatch: true,
  // Child-emitted startup-refusal reasons (subagent-child.ts).
  // The child publishes these in `setSubagentPayload` BEFORE
  // the harness loop runs, when its bootstrap detects an
  // unrecoverable misconfiguration. Validator preserves them
  // verbatim so audit telemetry / retry logic / operator
  // diagnostics keep their fidelity instead of seeing every
  // startup failure as `internalError`.
  unknown_model: true,
  unknown_tool: true,
  subagent_load_failed: true,
  // Child-emitted post-harness output_schema violation
  // (PLAYBOOKS.md §1.2). Without this entry the parent's
  // validator downgrades the child's specific verdict to
  // `internalError`, blinding consumers / telemetry to the
  // contract-violation cause.
  'playbook.output_invalid': true,
};
const VALID_REASON: ReadonlySet<RunSubagentResult['reason']> = new Set(
  Object.keys(VALID_REASON_MAP) as RunSubagentResult['reason'][],
);

export const buildResultFromPayload = (
  payload: Record<string, unknown>,
  sessionId: string,
): RunSubagentResult => {
  // Status / reason validated against closed sets. Anything
  // unrecognized collapses to status='error' / reason='internalError'
  // — safe interpretation that the row CAN be finalized via
  // `completeSession`'s CHECK constraint without a swallowed
  // throw leaving the row as `running`.
  const rawStatus = payload.status;
  const status: RunSubagentResult['status'] =
    typeof rawStatus === 'string' && VALID_STATUS.has(rawStatus as RunSubagentResult['status'])
      ? (rawStatus as RunSubagentResult['status'])
      : 'error';
  const rawReason = payload.reason;
  const reason: RunSubagentResult['reason'] =
    typeof rawReason === 'string' && VALID_REASON.has(rawReason as RunSubagentResult['reason'])
      ? (rawReason as RunSubagentResult['reason'])
      : 'internalError';
  // Abort discriminator: trust the child only when the
  // payload's `abort_cause` is a known value AND the reason is
  // 'aborted'. A producer bug that stamped `abort_cause` on a
  // non-abort path would otherwise mislead the parent's audit;
  // gating on `reason === 'aborted'` keeps the field's invariant
  // honest across the wire.
  const rawAbort = payload.abort_cause;
  const abortCause: 'soft' | 'hard' | undefined =
    reason === 'aborted' && (rawAbort === 'soft' || rawAbort === 'hard') ? rawAbort : undefined;
  return {
    output: typeof payload.output === 'string' ? payload.output : '',
    sessionId,
    status,
    reason,
    costUsd: typeof payload.cost_usd === 'number' ? payload.cost_usd : 0,
    steps: typeof payload.steps === 'number' ? payload.steps : 0,
    durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : 0,
    ...(abortCause !== undefined ? { abortCause } : {}),
  };
};

// Surface the spec'd "structured" envelope for the calling tool.
// Stable shape — consumers depend on the keys here.
export interface SubagentEnvelope {
  output: string;
  session_id: string;
  status: HarnessResult['status'];
  reason:
    | HarnessResult['reason']
    | 'worktree_create_failed'
    | 'subprocess_crashed'
    | 'subprocess_spawn_failed'
    | 'heartbeat_stale'
    | 'ipc_version_mismatch'
    | 'unknown_model'
    | 'unknown_tool'
    | 'subagent_load_failed'
    | 'playbook.output_invalid';
  cost_usd: number;
  steps: number;
  duration_ms: number;
  // Soft/hard abort discriminator. Snake_cased for the
  // tool-facing envelope; mirrors the camelCased
  // `RunSubagentResult.abortCause`. Absent for non-abort outcomes.
  abort_cause?: 'soft' | 'hard';
}

export const toEnvelope = (result: RunSubagentResult): SubagentEnvelope => ({
  output: result.output,
  session_id: result.sessionId,
  status: result.status,
  reason: result.reason,
  cost_usd: result.costUsd,
  steps: result.steps,
  duration_ms: result.durationMs,
  ...(result.abortCause !== undefined ? { abort_cause: result.abortCause } : {}),
});
