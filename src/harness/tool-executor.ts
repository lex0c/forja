// Per-tool executor extracted from the harness loop's runAgent (N7 — reduce the
// god-object). The ~250-line `invokeOne` closure — the worker BOTH the serial
// and parallel tool-dispatch paths call for each tool_use — moves here as
// `invokeOneTool(tu, deps)`. It runs one tool end to end: the FEEDBACK_ADAPTATION
// §9.1 bash dispatch-rewrite, the tool_invoking emit, invokeTool (permission
// check + checkpoint hook + exec + audit), the tool_decided / tool_finished
// emits, the verify-gate accounting, the deferred dispatch-rewrite audit row, the
// tool_error outcome_signal + the loop-quente outcome row, and the degraded-
// banner heartbeat — returning the tool_result + failed flag the caller
// aggregates. It takes an explicit snapshot of the ~10 run/step locals it used to
// close over plus a `resetVerifyAttempts` callback for the one mutation
// (verifyAttempts = 0 on a fresh mutation re-arming the gate). Behavior is
// preserved verbatim: the body is byte-for-byte the old closure with that single
// rename. The loop keeps a thin `invokeOne` wrapper; the tools / harness suites
// are the net.
import { maybeRewriteBashCommand } from '../feedback/dispatch-rewrite.ts';
import { emitToolCallOutcome } from '../feedback/outcome-emitter.ts';
import { buildScopeChain } from '../feedback/scope-detect.ts';
import type { HookChainResult, HookEventPayload } from '../hooks/index.ts';
import type { createDegradedBannerEmitter } from '../permissions/degraded-banner.ts';
import type { ProviderToolResultBlock } from '../providers/index.ts';
import { createDispatchRewrite } from '../storage/repos/dispatch-rewrites.ts';
import type { ToolContext } from '../tools/index.ts';
import type { CollectedToolUse } from './collect.ts';
import { safeEmit } from './emit.ts';
import { invokeTool } from './invoke-tool.ts';
import type { HarnessConfig } from './types.ts';
import { recordToolForVerify, type VerifyState } from './verify-gate.ts';

export interface InvokeOneToolDeps {
  config: HarnessConfig;
  sessionId: string;
  repoRoot: string;
  // The assistant message id for THIS step (the tool_calls parent).
  assistantMsgId: string;
  signal: AbortSignal;
  dispatchHooks: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  // Builds the per-tool ToolContext (the loop's buildCtx wrapper over
  // buildToolContext).
  buildCtx: (tu: CollectedToolUse) => ToolContext;
  verifyState: VerifyState;
  verifyCommands: readonly string[];
  degradedBannerEmitter: ReturnType<typeof createDegradedBannerEmitter>;
  // Reset the run's verify-gate nudge budget — invoked when a settled tool is a
  // fresh mutation that re-arms the gate (the loop owns the `verifyAttempts` let).
  resetVerifyAttempts: () => void;
}

// Run ONE tool_use end to end and return its tool_result + failed flag. Called
// per-tool by both the serial and parallel dispatch paths.
export const invokeOneTool = async (
  tu: CollectedToolUse,
  deps: InvokeOneToolDeps,
): Promise<{ toolResult: ProviderToolResultBlock; failed: boolean }> => {
  const {
    config,
    sessionId,
    repoRoot,
    assistantMsgId,
    signal,
    dispatchHooks,
    buildCtx,
    verifyState,
    verifyCommands,
    degradedBannerEmitter,
    resetVerifyAttempts,
  } = deps;
  // FEEDBACK_ADAPTATION §9.1 dispatch rewrite. When the
  // model issues a bash command whose leading binary has an
  // active L1 alias policy in the operator's scope chain,
  // rewrite before the permission engine + tool dispatch
  // see the call. CRITICAL: the engine sees the REWRITTEN
  // command, so target validation (bare-binary name only,
  // no shell metas) lives inside maybeRewriteBashCommand
  // — a poisoned action_json with shell injection would
  // otherwise bypass the allow-list.
  //
  // Structured audit: the pre-rewrite (original) command IS
  // persisted — the dispatch_rewrites row written below
  // (createDispatchRewrite, after invokeTool creates the
  // tool_calls row it FK-references) carries originalCommand +
  // rewrittenCommand + policyId, so operator forensic queries
  // recover the original. tool_calls.input captures the
  // rewritten value; stderr below also logs the rewrite event.
  // Tracks the L1 signature that drove a successful rewrite
  // (null when no rewrite happened). Threaded into the
  // outcome emitter so the policy's signature keeps
  // accumulating evidence after promotion — without this,
  // the post-rewrite command's bash-parser pass would
  // either pick the rewritten binary (not in alias table)
  // or nothing, and the policy's effectiveness signal
  // would go dark immediately after promotion.
  let appliedL1Signature: string | null = null;
  // Pending rewrite audit deferred until after invokeTool
  // creates the tool_calls row. `tu.id` is the provider's
  // tool_use id; `tool_calls.id` is a separate UUID that
  // invokeTool generates inside the same call. Persisting
  // here with tu.id would always hit the FK on
  // dispatch_rewrites.tool_call_id → tool_calls.id and
  // fall into the catch path — the behavior change happened
  // but the structured audit row never landed.
  let pendingRewriteAudit: {
    policyId: string;
    actionSignature: string;
    originalCommand: string;
    rewrittenCommand: string;
    matchedScope: 'global' | 'language' | 'repo' | 'user' | 'session';
  } | null = null;
  if (tu.name === 'bash' && typeof tu.input.command === 'string') {
    const originalCommand = tu.input.command;
    const rewrite = maybeRewriteBashCommand(
      config.db,
      originalCommand,
      buildScopeChain({ sessionId, repoCwd: repoRoot }),
    );
    if (
      rewrite.rewritten &&
      rewrite.appliedPolicyId !== null &&
      rewrite.appliedSignature !== null &&
      rewrite.matchedScope !== null
    ) {
      appliedL1Signature = rewrite.appliedSignature;
      tu.input = { ...tu.input, command: rewrite.command };
      pendingRewriteAudit = {
        policyId: rewrite.appliedPolicyId,
        actionSignature: rewrite.appliedSignature,
        originalCommand,
        rewrittenCommand: rewrite.command,
        matchedScope: rewrite.matchedScope as 'global' | 'language' | 'repo' | 'user' | 'session',
      };
    }
  }
  safeEmit(config.onEvent, {
    type: 'tool_invoking',
    toolUseId: tu.id,
    toolName: tu.name,
    args: tu.input,
  });
  const inv = await invokeTool(
    {
      toolUseId: tu.id,
      toolName: tu.name,
      args: tu.input,
      messageId: assistantMsgId,
    },
    {
      db: config.db,
      registry: config.toolRegistry,
      engine: config.permissionEngine,
      ctx: buildCtx(tu),
      ...(config.confirmPermission !== undefined
        ? { confirmPermission: config.confirmPermission }
        : {}),
      ...(config.systemPromptHash !== undefined
        ? { systemPromptHash: config.systemPromptHash }
        : {}),
      fireHook: dispatchHooks,
      signal,
      onExecutionStart: () => {
        safeEmit(config.onEvent, { type: 'tool_execution_started', toolUseId: tu.id });
      },
    },
  );
  if (inv.decision !== null) {
    safeEmit(config.onEvent, {
      type: 'tool_decided',
      toolUseId: tu.id,
      decision: inv.decision,
    });
  }
  safeEmit(config.onEvent, {
    type: 'tool_finished',
    toolUseId: tu.id,
    toolName: tu.name,
    failed: inv.failed,
    durationMs: inv.durationMs,
    ...(inv.denied === true ? { denied: true } : {}),
    ...(inv.errorMessage !== undefined ? { errorMessage: inv.errorMessage } : {}),
    ...(inv.outputTruncated === true ? { outputTruncated: true } : {}),
    ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
    ...(inv.resultDetail !== undefined ? { resultDetail: inv.resultDetail } : {}),
  });
  // Verify-gate accounting (STATE_MACHINE §3.2.1): fold this settled tool
  // into the run's mutation/verification evidence so the claim-time gate
  // at no_tool_use is deterministic. No-op when the gate is off.
  // Use the EXECUTED args (`inv.effectiveArgs`) — a PreToolUse hook can
  // rewrite a `bun test` call into another command that exits 0, and the
  // gate must match what actually ran, not the model's pre-hook args.
  // A fresh mutation re-arms the gate (starts a new verification cycle),
  // so reset the per-cycle nudge budget — otherwise a later edit inherits
  // attempts spent on an earlier one and, once the run-wide count hits the
  // max, every subsequent post-edit claim is accepted with only a warning.
  if (
    recordToolForVerify(
      verifyState,
      verifyCommands,
      tu.name,
      inv.effectiveArgs ?? tu.input,
      inv.failed,
      inv.exitCode,
    )
  ) {
    resetVerifyAttempts();
  }
  // Persist the dispatch-rewrite audit row now that invokeTool
  // created the tool_calls row that the FK points at. Skipped
  // when invokeTool returned an empty toolCallId (unknown
  // tool — no tool_call row to anchor against). Best-effort:
  // FK / IO failure stderr-logs and lets the rewrite proceed;
  // the behavior change already happened on tu.input mutation
  // upstream, only the forensic surface degrades.
  if (pendingRewriteAudit !== null && inv.toolCallId !== '') {
    try {
      createDispatchRewrite(config.db, {
        toolCallId: inv.toolCallId,
        sessionId,
        policyId: pendingRewriteAudit.policyId,
        actionSignature: pendingRewriteAudit.actionSignature,
        originalCommand: pendingRewriteAudit.originalCommand,
        rewrittenCommand: pendingRewriteAudit.rewrittenCommand,
        matchedScope: pendingRewriteAudit.matchedScope,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `forja adaptation: dispatch_rewrites insert failed for tool_call=${inv.toolCallId} (${msg})\n`,
      );
    }
  }
  // Slice 131 wire: when a tool execution fails AFTER
  // permission allowed it (failed=true, denied!=true)
  // AND we have an approval_seq from the decision, emit
  // an outcome_signal kind=tool_error. Calibration sweeps
  // use this as a weak proxy for "the allow decision led
  // to a bad outcome". Best-effort: outcome-sink failure
  // surfaces to stderr but never crashes the loop. Skip
  // denied paths — denials are by construction the
  // engine refusing the call; outcome of a deny is
  // already encoded in the decision itself.
  if (
    config.outcomeSink !== undefined &&
    inv.failed === true &&
    inv.denied !== true &&
    inv.decision?.approvalSeq !== undefined
  ) {
    try {
      config.outcomeSink.emit({
        approval_seq: inv.decision.approvalSeq,
        signal_kind: 'tool_error',
        payload: {
          tool_name: tu.name,
          duration_ms: inv.durationMs,
          ...(inv.errorMessage !== undefined ? { error_message: inv.errorMessage } : {}),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `forja outcome_signals: tool_error wire failed for approval_seq=${inv.decision.approvalSeq} (${msg})\n`,
      );
    }
  }
  // FEEDBACK_ADAPTATION §3.1 loop quente write — emit a
  // `outcomes` row capturing the (action_signature, tier,
  // result) tuple for the dispatch. Coexists with the
  // outcome_signals emission above per AUDIT.md §1.1.1:
  // the two tables record different audit dimensions and
  // never dual-write the same fact. The signal_kind=
  // 'tool_error' block above feeds the permission engine's
  // calibration; THIS row feeds the loop frio adaptation
  // engine (3.4). Best-effort — failures stderr but don't
  // crash. Denied calls are skipped inside the emitter (no
  // body ran, no action_signature outcome to record).
  emitToolCallOutcome(config.db, {
    sessionId,
    toolCallId: inv.toolCallId,
    toolName: tu.name,
    failed: inv.failed,
    ...(inv.denied === true ? { denied: true } : {}),
    durationMs: inv.durationMs,
    ...(inv.errorMessage !== undefined ? { errorMessage: inv.errorMessage } : {}),
    // Pass tool input so the emitter can derive L1 alias
    // signatures from bash commands (3.5a). Other tools
    // ignore the input; only `bash` carries a `command`
    // field the parser inspects.
    toolInput: tu.input,
    // When a dispatch rewrite manifested, pin the L1
    // signature to the policy's — the post-rewrite
    // command's leading binary (rg) isn't in the alias
    // table, so without this override the emitter would
    // skip the L1 row entirely and the policy would lose
    // its evidence stream immediately after promotion
    // (3.6d).
    ...(appliedL1Signature !== null ? { appliedL1Signature } : {}),
    // Pass the scope chain so outcomes land at scope=repo
    // (when detected). Without this, every outcome lands
    // at scope=session and repo/user/language-scoped
    // policies never accumulate evidence (3.7b — fixes
    // H1 from the branch review).
    scopeChain: buildScopeChain({ sessionId, repoCwd: repoRoot }),
  });
  // §13.6 degraded banner heartbeat (slice 92). Fires after
  // every tool call; emitter is cheap + queries engine state
  // internally. Emits a `sandbox_degraded_active` harness
  // event on first-entry to degraded + every N calls
  // thereafter (default 10).
  degradedBannerEmitter.notifyToolCall(sessionId);
  return { toolResult: inv.toolResult, failed: inv.failed };
};
