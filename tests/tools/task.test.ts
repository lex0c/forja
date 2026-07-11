import { describe, expect, test } from 'bun:test';
import { taskTool } from '../../src/tools/builtin/task.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../../src/tools/types.ts';
import { isToolError } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const ranEnvelope = (
  overrides: Partial<Extract<SpawnSubagentResult, { kind: 'ran' }>> = {},
): SpawnSubagentResult => ({
  kind: 'ran',
  output: 'child output',
  sessionId: 'child-session',
  status: 'done',
  reason: 'done',
  costUsd: 0.001,
  steps: 2,
  durationMs: 42,
  ...overrides,
});

describe('task tool', () => {
  test('happy path: spawns subagent, returns envelope', async () => {
    const calls: SpawnSubagentArgs[] = [];
    const ctx = makeCtx({
      spawnSubagent: async (args) => {
        calls.push(args);
        return ranEnvelope();
      },
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.output).toBe('child output');
    expect(result.session_id).toBe('child-session');
    expect(result.status).toBe('done');
    expect(result.cost_usd).toBe(0.001);
    expect(calls).toEqual([{ name: 'explore', prompt: 'go', declaredCapabilities: [] }]);
  });

  // R3 — migration 058 wires `parent_approval_id` end-to-end.
  // `invoke-tool` populates `ctx.approvalId`; the task tool forwards
  // it via `SpawnSubagentArgs.parentApprovalId` so the spawned
  // child's audit row links back to the approval that admitted the
  // spawn. Pre-fix the task tool ignored ctx.approvalId entirely and
  // every spawn landed `subagent_runs.parent_approval_id = NULL`.
  test('R3 e2e: ctx.approvalId is forwarded as SpawnSubagentArgs.parentApprovalId', async () => {
    const calls: SpawnSubagentArgs[] = [];
    const ctx = makeCtx({
      approvalId: 'approval-xyz',
      spawnSubagent: async (args) => {
        calls.push(args);
        return ranEnvelope();
      },
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parentApprovalId).toBe('approval-xyz');
  });

  test('R3: ctx.approvalId absent ⇒ parentApprovalId omitted from spawn args', async () => {
    const calls: SpawnSubagentArgs[] = [];
    const ctx = makeCtx({
      spawnSubagent: async (args) => {
        calls.push(args);
        return ranEnvelope();
      },
    });
    await taskTool.execute({ subagent: 'explore', prompt: 'go', capabilities: [] }, ctx);
    expect(calls[0]?.parentApprovalId).toBeUndefined();
  });

  test('errors when no spawnSubagent is wired', async () => {
    const ctx = makeCtx();
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.unavailable');
  });

  test('errors on unknown subagent and surfaces available list', async () => {
    const ctx = makeCtx({
      spawnSubagent: async () => ({
        kind: 'unknown_subagent',
        requested: 'review',
        available: ['explore'],
      }),
    });
    const result = await taskTool.execute(
      { subagent: 'review', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.unknown');
    expect(result.error_message).toContain("'review' not found");
    expect(result.hint).toContain('explore');
    expect(result.details?.available).toEqual(['explore']);
  });

  test('preserves audit_failure on the run_failed branch (both signals matter)', async () => {
    // When the child both fails AND its snapshot insert fails,
    // operators investigating need to see both: the run outcome
    // tells them what went wrong; the audit_failure tells them
    // the forensic record is missing for the exact failure
    // they're trying to investigate. Dropping audit_failure on
    // the failure branch defeats the audit gap fix for the
    // failure-heavy cases that benefit from it most.
    const ctx = makeCtx({
      spawnSubagent: async () =>
        ranEnvelope({
          status: 'exhausted',
          reason: 'maxSteps',
          output: 'partial',
          auditFailure: { code: 'snapshot_insert_failed', message: 'storage broken' },
        }),
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.run_failed');
    expect(result.details?.status).toBe('exhausted');
    // The audit signal is preserved alongside the run-failure
    // envelope so investigators see both dimensions.
    expect(result.details?.audit_failure).toEqual({
      code: 'snapshot_insert_failed',
      message: 'storage broken',
    });
  });

  test('echoes audit_failure in the envelope when the child reports one', async () => {
    // M1 fix: when the runtime fails to persist the audit
    // snapshot, the run still completes successfully but the
    // tool result must surface the audit_failure so the parent
    // model + CLI can flag missing forensic record.
    const ctx = makeCtx({
      spawnSubagent: async () =>
        ranEnvelope({
          auditFailure: { code: 'snapshot_insert_failed', message: 'no such table: subagent_runs' },
        }),
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(false);
    if (isToolError(result)) return;
    expect(result.audit_failure).toBeDefined();
    expect(result.audit_failure?.code).toBe('snapshot_insert_failed');
    expect(result.audit_failure?.message).toContain('subagent_runs');
  });

  test('errors on depth_exceeded with depth + max_depth in details', async () => {
    const ctx = makeCtx({
      spawnSubagent: async () => ({
        kind: 'depth_exceeded',
        requested: 'review',
        depth: 5,
        maxDepth: 4,
      }),
    });
    const result = await taskTool.execute(
      { subagent: 'review', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.depth_exceeded');
    expect(result.error_message).toContain('depth 5');
    expect(result.error_message).toContain('max 4');
    expect(result.details?.depth).toBe(5);
    expect(result.details?.max_depth).toBe(4);
  });

  test('errors on playbook_model_unavailable with model + reason in details', async () => {
    const ctx = makeCtx({
      spawnSubagent: async () => ({
        kind: 'playbook_model_unavailable',
        requested: 'review',
        model: 'foo/bar',
        reason: "unknown model 'foo/bar' is not in the catalog",
      }),
    });
    const result = await taskTool.execute(
      { subagent: 'review', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.playbook_model_unavailable');
    expect(result.error_message).toContain('foo/bar');
    expect(result.details?.model).toBe('foo/bar');
    expect(result.details?.reason).toContain('not in the catalog');
  });

  test('appends `detail` to the run_failed error when the child forwarded one', async () => {
    // The child's HarnessResult.detail (e.g. provider error
    // message for reason='providerError') crosses IPC into
    // SpawnSubagentResult.detail. The tool error string must
    // surface it after the categorical reason or operators see
    // a bare "providerError" with no actionable cause. Test
    // covers what landed via the f4f8a79 → c (this fix) chain:
    // detail flows from harness → child envelope → result
    // builder → spawn result → tool error string → invoke-tool
    // errorMessage → TUI `└─` connector.
    const ctx = makeCtx({
      spawnSubagent: async () =>
        ranEnvelope({
          status: 'error',
          reason: 'providerError',
          output: '',
          detail: 'AnthropicError 401 invalid x-api-key',
        }),
    });
    const result = await taskTool.execute(
      { subagent: 'review', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.run_failed');
    expect(result.error_message).toContain("reason='providerError'");
    expect(result.error_message).toContain('AnthropicError 401 invalid x-api-key');
    // Format invariant: `: <detail>` suffixed AFTER the closing
    // single-quote, not embedded inside it. Prevents a future
    // regression where the suffix lands before the categorical
    // reason and the operator misreads cause.
    expect(result.error_message).toMatch(/reason='providerError': AnthropicError/);
  });

  test('omits the detail suffix when the child forwarded none (back-compat)', async () => {
    // Older runs / synthesized envelopes (subprocess crash with
    // no payload, etc.) lack detail. Tool error string must
    // stay backward-compatible: same shape as before this fix.
    const ctx = makeCtx({
      spawnSubagent: async () =>
        ranEnvelope({ status: 'error', reason: 'subprocess_crashed', output: '' }),
    });
    const result = await taskTool.execute(
      { subagent: 'review', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    // Plain trailing single-quote, no `:` suffix.
    expect(result.error_message).toMatch(/reason='subprocess_crashed'$/);
  });

  test('maps non-done child status to subagent.run_failed', async () => {
    const ctx = makeCtx({
      spawnSubagent: async () =>
        ranEnvelope({ status: 'exhausted', reason: 'maxSteps', output: 'partial' }),
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.run_failed');
    expect(result.retryable).toBe(true);
    expect(result.details?.status).toBe('exhausted');
    expect(result.details?.reason).toBe('maxSteps');
    // Child output is preserved on the failure envelope so the
    // parent can inspect what (if anything) the child produced.
    expect(result.details?.output).toBe('partial');
  });

  test('rejects empty / non-string args', async () => {
    const ctx = makeCtx({ spawnSubagent: async () => ranEnvelope() });
    const cases: Array<[unknown, RegExp]> = [
      [{ subagent: '', prompt: 'x', capabilities: [] }, /subagent.*non-empty/],
      [{ subagent: 'explore', prompt: '', capabilities: [] }, /prompt.*non-empty/],
      [{ subagent: 42, prompt: 'x' }, /subagent.*non-empty/],
      [{ subagent: 'explore', prompt: null }, /prompt.*non-empty/],
    ];
    for (const [args, re] of cases) {
      const result = await taskTool.execute(args as { subagent: string; prompt: string }, ctx);
      expect(isToolError(result)).toBe(true);
      if (!isToolError(result)) continue;
      expect(result.error_code).toBe('tool.invalid_arg');
      expect(result.error_message).toMatch(re);
    }
  });

  test('rejects oversized prompts', async () => {
    const ctx = makeCtx({ spawnSubagent: async () => ranEnvelope() });
    const huge = 'a'.repeat(33 * 1024);
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: huge, capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('tool.invalid_arg');
    expect(result.error_message).toContain('exceeds');
  });

  test('aborts before spawning when signal is already set', async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const ctx = makeCtx({
      signal: ac.signal,
      spawnSubagent: async () => {
        called = true;
        return ranEnvelope();
      },
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(called).toBe(false);
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('tool.aborted');
  });

  test('records gate decisions for all three refusal kinds (audit fix #3)', async () => {
    // The synchronous task path doesn't pre-flight; the
    // dispatcher returns a refusal kind, the tool maps it to
    // a tool error, and the recorder fires before returning.
    // All three rows attribute to `task_sync` (canonical per
    // spec §3.1) — the legacy `task` alias shares this
    // execute body.
    type Decision = {
      decisionType:
        | 'budget_exhausted'
        | 'unknown_subagent'
        | 'depth_exceeded'
        | 'subagent_escalation';
      toolName: 'task' | 'task_sync' | 'task_async';
      requestedName: string;
      details: Record<string, unknown>;
    };
    const recorded: Decision[] = [];
    const recordGateDecision = (d: Decision) => recorded.push(d);

    const ctxUnknown = makeCtx({
      spawnSubagent: async () => ({
        kind: 'unknown_subagent',
        requested: 'typo',
        available: ['explore'],
      }),
      recordGateDecision,
    });
    const r1 = await taskTool.execute(
      { subagent: 'typo', prompt: 'p', capabilities: [] },
      ctxUnknown,
    );
    expect(isToolError(r1)).toBe(true);

    const ctxDepth = makeCtx({
      spawnSubagent: async () => ({
        kind: 'depth_exceeded',
        requested: 'explore',
        depth: 5,
        maxDepth: 4,
      }),
      recordGateDecision,
    });
    const r2 = await taskTool.execute(
      { subagent: 'explore', prompt: 'p', capabilities: [] },
      ctxDepth,
    );
    expect(isToolError(r2)).toBe(true);

    const ctxBudget = makeCtx({
      spawnSubagent: async () => ({
        kind: 'budget_exhausted',
        requested: 'explore',
        spent: 4.5,
        estimate: 1.0,
        projected: 5.5,
        cap: 5.0,
      }),
      recordGateDecision,
    });
    const r3 = await taskTool.execute(
      { subagent: 'explore', prompt: 'p', capabilities: [] },
      ctxBudget,
    );
    expect(isToolError(r3)).toBe(true);

    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({
      decisionType: 'unknown_subagent',
      toolName: 'task_sync',
      requestedName: 'typo',
    });
    expect(recorded[0]?.details.available).toEqual(['explore']);
    expect(recorded[1]).toMatchObject({
      decisionType: 'depth_exceeded',
      toolName: 'task_sync',
      requestedName: 'explore',
    });
    expect(recorded[1]?.details).toEqual({ depth: 5, max_depth: 4 });
    expect(recorded[2]).toMatchObject({
      decisionType: 'budget_exhausted',
      toolName: 'task_sync',
      requestedName: 'explore',
    });
    expect(recorded[2]?.details).toMatchObject({
      spent: 4.5,
      estimate: 1.0,
      projected: 5.5,
      cap: 5.0,
    });
  });
});

describe('task tool — output summarization (OUTPUT_POLICY §3.1/§6)', () => {
  // > 16 KB across many short lines → many-lines head/tail path.
  const bigOutput = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');

  test('declares a head_tail summarize policy (inherited by task_sync via spread)', () => {
    expect(typeof taskTool.metadata.summarize).toBe('function');
  });

  test('passthrough: a small child output is not reduced', () => {
    const out = taskTool.metadata.summarize?.(
      {
        output: 'short conclusion',
        session_id: 's',
        status: 'done',
        reason: 'done',
        cost_usd: 0,
        steps: 1,
        duration_ms: 1,
      },
      {},
    );
    expect(out?.reduced).toBe(false);
    expect(out?.policy).toBe('noop');
    expect((out?.result as { output: string }).output).toBe('short conclusion');
  });

  test('reduction: a large child output is head-tailed, scalars preserved, audit raw untouched', () => {
    const raw = {
      output: bigOutput,
      session_id: 'child-x',
      status: 'done' as const,
      reason: 'done',
      cost_usd: 0.5,
      steps: 9,
      duration_ms: 1234,
    };
    const out = taskTool.metadata.summarize?.(raw, {});
    expect(out?.reduced).toBe(true);
    expect(out?.policy).toBe('head_tail');
    expect(out?.originalBytes).toBe(Buffer.byteLength(bigOutput, 'utf8'));
    const reduced = out?.result as typeof raw;
    // Output shrank and carries the elision marker the harness
    // surfaces as the digest signal.
    expect(reduced.output.length).toBeLessThan(bigOutput.length);
    expect(reduced.output).toContain('elided');
    // The function is pure — it returns a reduced COPY and never
    // mutates the input the harness already persisted to the audit
    // row (OUTPUT_POLICY §0.1).
    expect(raw.output).toBe(bigOutput);
    // Load-bearing scalars are passed through verbatim.
    expect(reduced.session_id).toBe('child-x');
    expect(reduced.cost_usd).toBe(0.5);
    expect(reduced.steps).toBe(9);
  });

  test('error path: a verbose failed child has details.output trimmed inline (summarize skips errors)', async () => {
    const ctx = makeCtx({
      spawnSubagent: async () =>
        ranEnvelope({ status: 'exhausted', reason: 'maxSteps', output: bigOutput }),
    });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: [] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    const detailsOutput = result.details?.output;
    expect(typeof detailsOutput).toBe('string');
    expect((detailsOutput as string).length).toBeLessThan(bigOutput.length);
    expect(detailsOutput as string).toContain('elided');
    // session_id stays as the pointer to the full child run.
    expect(result.details?.session_id).toBe('child-session');
  });
});
