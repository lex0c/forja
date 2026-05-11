import { describe, expect, test } from 'bun:test';
import { taskTool } from '../../src/tools/builtin/task.ts';
import { isToolError } from '../../src/tools/types.ts';
import type { SpawnSubagentArgs, SpawnSubagentResult } from '../../src/tools/types.ts';
import { makeCtx } from './_helpers.ts';

const ranEnvelope = (): SpawnSubagentResult => ({
  kind: 'ran',
  output: 'child output',
  sessionId: 'child-session',
  status: 'done',
  reason: 'done',
  costUsd: 0,
  steps: 1,
  durationMs: 1,
});

describe('task tool — capabilities input validation', () => {
  test('happy path: capabilities array forwarded as declaredCapabilities', async () => {
    const calls: SpawnSubagentArgs[] = [];
    const ctx = makeCtx({
      spawnSubagent: async (args) => {
        calls.push(args);
        return ranEnvelope();
      },
    });
    const result = await taskTool.execute(
      {
        subagent: 'explore',
        prompt: 'go',
        capabilities: ['read-fs:src/**', 'exec:shell'],
      },
      ctx,
    );
    expect(isToolError(result)).toBe(false);
    expect(calls[0]?.declaredCapabilities).toEqual(['read-fs:src/**', 'exec:shell']);
  });

  test('empty array forwarded verbatim (§10.1 pure-LLM)', async () => {
    const calls: SpawnSubagentArgs[] = [];
    const ctx = makeCtx({
      spawnSubagent: async (args) => {
        calls.push(args);
        return ranEnvelope();
      },
    });
    await taskTool.execute({ subagent: 'explore', prompt: 'go', capabilities: [] }, ctx);
    expect(calls[0]?.declaredCapabilities).toEqual([]);
  });

  test('omitting capabilities skips the field entirely', async () => {
    const calls: SpawnSubagentArgs[] = [];
    const ctx = makeCtx({
      spawnSubagent: async (args) => {
        calls.push(args);
        return ranEnvelope();
      },
    });
    await taskTool.execute({ subagent: 'explore', prompt: 'go' }, ctx);
    expect(calls[0]?.declaredCapabilities).toBeUndefined();
  });

  test('rejects non-array capabilities', async () => {
    const ctx = makeCtx({ spawnSubagent: async () => ranEnvelope() });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: 'read-fs:**' as unknown as string[] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_message).toContain('array');
  });

  test('rejects non-string entries', async () => {
    const ctx = makeCtx({ spawnSubagent: async () => ranEnvelope() });
    const result = await taskTool.execute(
      {
        subagent: 'explore',
        prompt: 'go',
        capabilities: ['read-fs:**', 42 as unknown as string],
      },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_message).toContain('capability strings');
  });

  test('rejects malformed capability strings', async () => {
    const ctx = makeCtx({ spawnSubagent: async () => ranEnvelope() });
    const result = await taskTool.execute(
      { subagent: 'explore', prompt: 'go', capabilities: ['not-a-real-kind:foo'] },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_message).toContain('not a valid capability');
  });
});

describe('task tool — subagent_escalation envelope', () => {
  test('surfaces subagent.escalation when spawn factory refuses', async () => {
    const recorded: Array<{ decisionType: string; requestedName: string; details: unknown }> = [];
    const ctx = makeCtx({
      spawnSubagent: async () => ({
        kind: 'subagent_escalation',
        requested: 'explore',
        excess: ['write-fs:foo', 'env-mutate'],
      }),
      recordGateDecision: (d) => recorded.push(d),
    });
    const result = await taskTool.execute(
      {
        subagent: 'explore',
        prompt: 'go',
        capabilities: ['write-fs:foo', 'env-mutate'],
      },
      ctx,
    );
    expect(isToolError(result)).toBe(true);
    if (!isToolError(result)) return;
    expect(result.error_code).toBe('subagent.escalation');
    expect(result.error_message).toContain('write-fs:foo');
    expect(result.error_message).toContain('env-mutate');
    expect(result.details?.excess).toEqual(['write-fs:foo', 'env-mutate']);
    expect(result.retryable).toBe(false);
    expect(result.hint).toContain('§10.1');

    expect(recorded.length).toBe(1);
    expect(recorded[0]?.decisionType).toBe('subagent_escalation');
    expect(recorded[0]?.requestedName).toBe('explore');
    expect((recorded[0]?.details as { excess: string[] }).excess).toEqual([
      'write-fs:foo',
      'env-mutate',
    ]);
  });
});
