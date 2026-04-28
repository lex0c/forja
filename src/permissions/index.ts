export type {
  BashPolicy,
  Decision,
  FetchPolicy,
  PathPolicy,
  PermissionsView,
  Policy,
  PolicyCategory,
  PolicyDefaults,
  PolicyMode,
  PolicyToolsSection,
} from './types.ts';

export {
  firstMatchingCommand,
  firstMatchingHost,
  firstMatchingPath,
  matchCommand,
  matchHost,
  matchPath,
} from './matcher.ts';

export type { EngineOptions, PermissionEngine, ToolArgs } from './engine.ts';
export { createPermissionEngine } from './engine.ts';

export {
  defaultPolicy,
  loadPolicyFromFile,
  loadPolicyFromString,
  parsePolicy,
} from './config.ts';

export {
  enterprisePolicyPath,
  projectPolicyPath,
  userPolicyPath,
} from './paths.ts';

export type {
  Layer,
  LayerPolicy,
  LockConflict,
  ResolveOptions,
  ResolveResult,
} from './hierarchy.ts';
export { resolvePolicy } from './hierarchy.ts';
