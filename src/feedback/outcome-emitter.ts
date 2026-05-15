// Loop quente outcome emitter (FEEDBACK_ADAPTATION §3.1).
//
// Wired from the harness loop right after each tool dispatch. Each
// finished tool call produces an `outcomes` row capturing the result
// + action_signature. The loop frio (3.4) reads aggregated outcomes
// to propose adaptation policies; this emitter is the write side.
//
// Coexistence with outcome_signals (PERMISSION_ENGINE §6.3.2): the
// two tables are intentionally distinct — `outcome_signals` is
// permission-derived audit keyed to approvals_log.seq; `outcomes`
// is the generic operational surface keyed to action_signature.
// Both write paths fire from the same dispatch site but emit
// different shapes to different tables (AUDIT.md §1.1.1 — no
// dual-write contract).
//
// Failure handling: best-effort. A failure to INSERT an outcome
// surfaces on stderr and the loop continues — adaptation data
// loss is preferable to crashing the operator's session.
//
// What this slice (3.2) writes:
//   - action_signature: `flag:<tool_name>:default:default` — a
//     baseline that captures "this tool was used; did it succeed?"
//     Future slices refine signatures (bash command parser for L1
//     aliases like alias:grep:ripgrep; flag-specific shapes per
//     tool). Today every tool call lands one row with the generic
//     signature; the aggregator filters by level when applicable.
//   - tier: 1 (deterministic — derived from tool exit status).
//     Tier 3 (humano explícito) requires linking the denial to
//     the operator action via approvals_log — deferred until
//     scope resolver (3.3) provides the cross-table link.
//   - result: 'success' (failed=false) | 'failure' (failed=true).
//     'partial' / 'ambiguous' require structural diff analysis
//     (tier 2) — deferred.
//   - scope_kind: 'session'. Scope hierarchy (repo/user/global)
//     lands in 3.3 once the scope resolver computes the active
//     scope per dispatch site.
//
// Spec compliance note: emitter is currently lossy on denials and
// permission-driven outcomes — those flow through outcome_signals
// per the coexistence contract. This module emits ONLY when the
// tool body actually ran (status='done' or 'error'), not when the
// call was denied before execution. Denied calls have no
// action_signature outcome to record; the permission decision IS
// the signal, and lives in approvals_log.

import type { DB } from '../storage/db.ts';
import { createOutcome } from '../storage/repos/outcomes.ts';

export interface EmitOutcomeInput {
  // The session that initiated the tool call.
  sessionId: string;
  // The tool_calls.id row this outcome derives from.
  toolCallId: string;
  // Tool name (e.g., 'bash', 'read_file').
  toolName: string;
  // True when the tool's body returned an error (ToolError, exception,
  // execution failure). False on clean success.
  failed: boolean;
  // True when the permission engine denied the call OR the operator
  // refused a confirm modal. Denials skip outcome emission per the
  // §3.1.1 coexistence contract — they live in outcome_signals
  // already. Caller still passes this flag so the emitter can decide.
  denied?: boolean;
  // Tool execution duration (ms).
  durationMs: number;
  // Human-readable error message when failed === true and !denied.
  // Surfaced in evidence_json for forensic queries.
  errorMessage?: string;
}

// Best-effort emit. Returns true when a row was written, false when
// the call was skipped (denied path; permission outcomes are in
// outcome_signals). Errors during INSERT surface on stderr and
// return false — the caller continues unaffected.
export const emitToolCallOutcome = (db: DB, input: EmitOutcomeInput): boolean => {
  // Skip denied paths — they belong in outcome_signals per the
  // coexistence contract (AUDIT.md §1.1.1). The decision IS the
  // signal; there's no action_signature outcome to record because
  // the body never ran.
  if (input.denied === true) return false;

  const actionSignature = `flag:${input.toolName}:default:default`;
  const result = input.failed ? 'failure' : 'success';
  const evidence: Record<string, unknown> = {
    tool_name: input.toolName,
    duration_ms: input.durationMs,
  };
  if (input.failed) {
    evidence.failed = true;
    if (input.errorMessage !== undefined) {
      evidence.error_message = input.errorMessage;
    }
  }

  try {
    createOutcome(db, {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      actionSignature,
      tier: 1,
      result,
      evidenceJson: JSON.stringify(evidence),
      scopeKind: 'session',
      scopeId: input.sessionId,
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `forja outcomes: emit failed for tool_call=${input.toolCallId} (${msg})\n`,
    );
    return false;
  }
};
