import { type Broker, createBashHandler, createInProcessBroker } from '../../src/broker/index.ts';
import type { Decision, PermissionsView } from '../../src/permissions/index.ts';
import { scrubEnv } from '../../src/sanitize/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const defaultView = (): PermissionsView => ({ mode: 'strict', posture: 'supervised' });

// Default permission predicate for tests: allow everything. Tests
// that exercise leaf-gating (deny paths) override via the
// `permissionCheck` field. Making this explicit (instead of an
// `undefined` fall-through) is intentional — `permissionCheck` is
// REQUIRED on ToolContext, and the test default mirroring "the
// harness's auto-allow for misc" lets non-gating tests stay terse
// while making any future `permissionCheck`-using code path break
// loudly when the helper isn't updated.
const allowAll = (): Decision => ({ kind: 'allow', reason: 'test default allow-all' });

// Default broker for tests — in-process degenerate (slice 78) wired
// to the bash handler from slice 81. Mirrors the production worker
// registry (src/broker/worker.ts) so the bash tool's broker-routed
// path is exercised by every existing test that goes through
// makeCtx, without those tests needing to know about the broker
// architecture. Tests that need a different broker (or none) pass
// `broker: undefined` in overrides — but bash explicitly requires
// one and surfaces `bash.spawn_failed` if missing.
const defaultBroker = (): Broker => {
  const bashHandler = createBashHandler({ scrubEnv });
  return createInProcessBroker({
    exec: (request, callOptions) => bashHandler.execute(request, callOptions),
  });
};

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
  ...(overrides.skillCatalog !== undefined ? { skillCatalog: overrides.skillCatalog } : {}),
  ...(overrides.retrieveContext !== undefined
    ? { retrieveContext: overrides.retrieveContext }
    : {}),
  ...(overrides.confirmMemoryWrite !== undefined
    ? { confirmMemoryWrite: overrides.confirmMemoryWrite }
    : {}),
  ...(overrides.confirmMemoryUserScope !== undefined
    ? { confirmMemoryUserScope: overrides.confirmMemoryUserScope }
    : {}),
  ...(overrides.contextPinsStore !== undefined
    ? { contextPinsStore: overrides.contextPinsStore }
    : {}),
  ...(overrides.clarify !== undefined ? { clarify: overrides.clarify } : {}),
  ...(overrides.emitWarn !== undefined ? { emitWarn: overrides.emitWarn } : {}),
  ...(overrides.emitDiff !== undefined ? { emitDiff: overrides.emitDiff } : {}),
  ...(overrides.fireHook !== undefined ? { fireHook: overrides.fireHook } : {}),
  ...(overrides.sandboxProfile !== undefined ? { sandboxProfile: overrides.sandboxProfile } : {}),
  ...(overrides.toolCallId !== undefined ? { toolCallId: overrides.toolCallId } : {}),
  ...(overrides.approvalId !== undefined ? { approvalId: overrides.approvalId } : {}),
  broker: overrides.broker ?? defaultBroker(),
});
