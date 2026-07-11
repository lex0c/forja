// Hooks subsystem barrel.

export { resolveHookConfig } from './config.ts';
export type {
  DispatchedProcess,
  DispatcherDeps,
  HookShellResolution,
  ResolveHookShellOpts,
  SpawnFn,
  SpawnOpts,
} from './dispatcher.ts';
export { dispatchChain, dispatchOne, filterMatchingHooks, resolveHookShell } from './dispatcher.ts';
export type { HookConfigPaths } from './paths.ts';
export {
  enterpriseHooksPath,
  projectHooksPath,
  resolveHookPaths,
  userHooksPath,
} from './paths.ts';
export type { TemplateExpansionResult } from './template.ts';
export { expandTemplate } from './template.ts';
export type {
  EvictionEventData,
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
  BLOCKING_EVENTS,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_STDOUT_MAX_BYTES,
  MAX_HOOK_CHAIN_MS,
  MAX_HOOK_TIMEOUT_MS,
  MIN_HOOK_TIMEOUT_MS,
} from './types.ts';
