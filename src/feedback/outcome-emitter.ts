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
import type { ScopeKind } from '../storage/repos/outcomes.ts';
import { createOutcome } from '../storage/repos/outcomes.ts';
import { lookupBashAlias } from './bash-aliases.ts';
import { extractLeadingBinary } from './bash-parser.ts';
import type { BuiltScopeChain } from './scope-detect.ts';

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
  // Raw tool input — used by L1 alias detection for bash tool
  // calls. When `toolName === 'bash'` and the input carries a
  // `command` string whose leading binary matches a known alias
  // (bash-aliases.ts), the emitter writes an ADDITIONAL outcome
  // row with signature `alias:<from>:<to>` so the loop frio can
  // accumulate tier-1 evidence for the adaptation. Optional —
  // callers that don't carry the input fall back to the generic
  // `flag:bash:default:default` outcome only.
  toolInput?: unknown;
  // Explicit L1 signature override. When a dispatch rewrite
  // (3.5b) fired, the toolInput.command is the REWRITTEN command
  // (e.g., 'ripgrep foo'), not the original 'grep foo'. The L1
  // signature we want to record is the policy's — the ORIGINAL
  // alias that drove the rewrite — so the loop frio's posterior
  // for `alias:grep:ripgrep` keeps accumulating evidence after
  // promotion. Without this override, the post-rewrite bash
  // parser would see 'ripgrep' (not in KNOWN_BASH_ALIASES) and
  // emit NO L1 outcome — the policy's effectiveness signal would
  // go dark the moment it became active. Callers (loop.ts) pass
  // the signature from `maybeRewriteBashCommand.appliedSignature`.
  appliedL1Signature?: string;
  // Operator's scope chain at dispatch time. When supplied AND
  // `chain.repo` is detected (not 'unknown'), outcomes land at
  // scope_kind='repo' so the loop frio can aggregate evidence for
  // repo-scoped policies (spec §6.1: "outcome de bash em repo X
  // alimenta policy per-repo X"). Without it (or with
  // repo='unknown'), the row falls back to scope_kind='session'
  // — session-scope adaptation still works but repo/user/
  // language policies would never accumulate evidence. Callers
  // build the chain via buildScopeChain (3.6b).
  scopeChain?: BuiltScopeChain;
}

// Extract a known L1 alias signature from a bash tool input when
// applicable. Returns null when the tool isn't bash, the input
// shape doesn't carry a string `command`, or the leading binary
// isn't in the known-aliases table.
const deriveL1AliasSignature = (toolName: string, toolInput: unknown): string | null => {
  if (toolName !== 'bash') return null;
  if (toolInput === null || typeof toolInput !== 'object') return null;
  const cmd = (toolInput as Record<string, unknown>).command;
  if (typeof cmd !== 'string' || cmd.length === 0) return null;
  const binary = extractLeadingBinary(cmd);
  if (binary === null) return null;
  const alias = lookupBashAlias(binary);
  if (alias === null) return null;
  return `alias:${alias.from}:${alias.to}`;
};

// Best-effort emit. Returns true when at least one row was written,
// false when the call was skipped (denied path; permission outcomes
// are in outcome_signals). Errors during INSERT surface on stderr
// and don't crash — the caller continues unaffected.
//
// Multi-row emit: for bash invocations of known L1-alias binaries
// (grep, find, awk, sed, etc.), the emitter writes an additional
// outcome row with signature `alias:<from>:<to>` so the loop frio
// can accumulate L1 evidence. The generic `flag:bash:default:default`
// row still lands too — coexistence is intentional, the two
// signatures track different adaptation surfaces.
export const emitToolCallOutcome = (db: DB, input: EmitOutcomeInput): boolean => {
  // Skip denied paths — they belong in outcome_signals per the
  // coexistence contract (AUDIT.md §1.1.1). The decision IS the
  // signal; there's no action_signature outcome to record because
  // the body never ran.
  if (input.denied === true) return false;

  // Unknown-tool guard: when invokeTool fails on an unknown tool,
  // it returns toolCallId='' (no tool_call row was created). FK
  // constraint on outcomes.tool_call_id would refuse the INSERT
  // and the catch below stderr-logs noise per dispatch. Skip
  // emission for those — no real action_signature outcome to
  // record when the tool body never ran.
  if (input.toolCallId === '') return false;

  const result = input.failed ? 'failure' : 'success';
  const baseEvidence: Record<string, unknown> = {
    tool_name: input.toolName,
    duration_ms: input.durationMs,
  };
  if (input.failed) {
    baseEvidence.failed = true;
    if (input.errorMessage !== undefined) {
      baseEvidence.error_message = input.errorMessage;
    }
  }

  // Signatures to emit. Generic flag signature always; L1 alias
  // signature when the bash command matches the table OR when the
  // caller forces it (post-rewrite: the policy's signature must
  // keep accumulating evidence even though the rewritten command
  // wouldn't derive it).
  const signatures: string[] = [`flag:${input.toolName}:default:default`];
  if (input.appliedL1Signature !== undefined) {
    signatures.push(input.appliedL1Signature);
  } else {
    const l1 = deriveL1AliasSignature(input.toolName, input.toolInput);
    if (l1 !== null) signatures.push(l1);
  }

  // Resolve emission scope. Spec §6.1: outcomes land at the scope
  // where the policy would fire. Per-repo adaptation is the
  // canonical default; session fallback keeps things flowing when
  // repo detection fails (operator running from tmp dir without
  // language markers).
  let scopeKind: ScopeKind;
  let scopeId: string;
  if (input.scopeChain !== undefined && input.scopeChain.repo !== 'unknown') {
    scopeKind = 'repo';
    scopeId = input.scopeChain.repo;
  } else {
    scopeKind = 'session';
    scopeId = input.sessionId;
  }

  let wroteAny = false;
  for (const actionSignature of signatures) {
    try {
      createOutcome(db, {
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        actionSignature,
        tier: 1,
        result,
        evidenceJson: JSON.stringify(baseEvidence),
        scopeKind,
        scopeId,
      });
      wroteAny = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `forja outcomes: emit failed for tool_call=${input.toolCallId} signature=${actionSignature} (${msg})\n`,
      );
    }
  }
  return wroteAny;
};
