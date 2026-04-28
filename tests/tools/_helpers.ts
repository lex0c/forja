import type { PermissionsView } from '../../src/permissions/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';

const defaultView = (): PermissionsView => ({ mode: 'strict' });

export const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  signal: overrides.signal ?? new AbortController().signal,
  cwd: overrides.cwd ?? process.cwd(),
  sessionId: overrides.sessionId ?? 'test-session',
  stepId: overrides.stepId ?? 'test-step',
  permissions: overrides.permissions ?? defaultView(),
});
