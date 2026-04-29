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
  ...(overrides.bgManager !== undefined ? { bgManager: overrides.bgManager } : {}),
});
