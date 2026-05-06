import type { Decision, PermissionsView } from '../../src/permissions/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const defaultView = (): PermissionsView => ({ mode: 'strict' });

// Default permission predicate for tests: allow everything. Tests
// that exercise leaf-gating (deny paths) override via the
// `permissionCheck` field. Making this explicit (instead of an
// `undefined` fall-through) is intentional — `permissionCheck` is
// REQUIRED on ToolContext, and the test default mirroring "the
// harness's auto-allow for misc" lets non-gating tests stay terse
// while making any future `permissionCheck`-using code path break
// loudly when the helper isn't updated.
const allowAll = (): Decision => ({ kind: 'allow', reason: 'test default allow-all' });

export const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: overrides.signal ?? new AbortController().signal,
  cwd: overrides.cwd ?? process.cwd(),
  sessionId: overrides.sessionId ?? 'test-session',
  stepId: overrides.stepId ?? 'test-step',
  permissions: overrides.permissions ?? defaultView(),
  permissionCheck: overrides.permissionCheck ?? allowAll,
  // Default true mirrors the post-trust-prompt reality of REPL boot:
  // by the time a tool runs, cwd has either been confirmed or the
  // process exited. Tests that exercise the untrusted path
  // (memory_write's §7.2.1 trust gate) override to false explicitly.
  isCwdTrusted: overrides.isCwdTrusted ?? true,
  ...(overrides.bgManager !== undefined ? { bgManager: overrides.bgManager } : {}),
  ...(overrides.todoStore !== undefined ? { todoStore: overrides.todoStore } : {}),
  ...(overrides.spawnSubagent !== undefined ? { spawnSubagent: overrides.spawnSubagent } : {}),
  ...(overrides.subagentHandleStore !== undefined
    ? { subagentHandleStore: overrides.subagentHandleStore }
    : {}),
  ...(overrides.subagentDepth !== undefined ? { subagentDepth: overrides.subagentDepth } : {}),
  ...(overrides.getCostBudget !== undefined ? { getCostBudget: overrides.getCostBudget } : {}),
  ...(overrides.getSubagentBudgetEstimate !== undefined
    ? { getSubagentBudgetEstimate: overrides.getSubagentBudgetEstimate }
    : {}),
  ...(overrides.getKnownSubagentNames !== undefined
    ? { getKnownSubagentNames: overrides.getKnownSubagentNames }
    : {}),
  ...(overrides.recordGateDecision !== undefined
    ? { recordGateDecision: overrides.recordGateDecision }
    : {}),
  ...(overrides.memoryRegistry !== undefined ? { memoryRegistry: overrides.memoryRegistry } : {}),
  ...(overrides.confirmMemoryWrite !== undefined
    ? { confirmMemoryWrite: overrides.confirmMemoryWrite }
    : {}),
  ...(overrides.confirmMemoryUserScope !== undefined
    ? { confirmMemoryUserScope: overrides.confirmMemoryUserScope }
    : {}),
  ...(overrides.emitWarn !== undefined ? { emitWarn: overrides.emitWarn } : {}),
  ...(overrides.fireHook !== undefined ? { fireHook: overrides.fireHook } : {}),
});
