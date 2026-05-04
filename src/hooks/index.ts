// Hooks subsystem barrel.

export {
  BLOCKING_EVENTS,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_STDOUT_MAX_BYTES,
  MAX_HOOK_CHAIN_MS,
  MAX_HOOK_TIMEOUT_MS,
  MIN_HOOK_TIMEOUT_MS,
} from './types.ts';
export type {
  HookChainResult,
  HookConfigWarning,
  HookEvent,
  HookEventPayload,
  HookLayer,
  HookMatcher,
  HookRunResult,
  HookSpec,
  MemoryWriteData,
  NotificationData,
  PostToolUseData,
  PreCheckpointData,
  PreCompactData,
  ResolvedHookConfig,
  SessionStartData,
  StopData,
  ToolUseData,
  UserPromptSubmitData,
} from './types.ts';

export {
  enterpriseHooksPath,
  projectHooksPath,
  resolveHookPaths,
  userHooksPath,
} from './paths.ts';
export type { HookConfigPaths } from './paths.ts';

export { expandTemplate } from './template.ts';
export type { TemplateExpansionResult } from './template.ts';

export { resolveHookConfig } from './config.ts';

export { dispatchChain, dispatchOne, filterMatchingHooks } from './dispatcher.ts';
export type { DispatchedProcess, DispatcherDeps, SpawnFn, SpawnOpts } from './dispatcher.ts';
