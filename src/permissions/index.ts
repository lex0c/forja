export type {
  BashPolicy,
  Decision,
  FetchPolicy,
  PathPolicy,
  PermissionsView,
  Policy,
  PolicyCategory,
  PolicyDefaults,
  PolicyLayer,
  PolicyMode,
  PolicySource,
  PolicyToolsSection,
} from './types.ts';

export {
  escapeGlobMetacharacters,
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
export type { ParsePolicyContext } from './config.ts';

export type {
  AuditEmitInput,
  AuditSink,
  EmittedRow,
  ReasonChainEntry,
  VerifyResult,
} from './audit.ts';
export { computeGenesisHash, createNoopSink, createSqliteSink } from './audit.ts';

export type {
  SandboxAvailability,
  DetectSandboxAvailabilityOptions,
} from './sandbox-availability.ts';
export { detectSandboxAvailability } from './sandbox-availability.ts';

export type {
  SandboxProfile,
  SelectSandboxProfileOptions,
  SelectSandboxProfileResult,
} from './sandbox-plan.ts';
export { SANDBOX_PROFILE_ORDER, selectSandboxProfile } from './sandbox-plan.ts';

export type {
  BootstrapPermissionEngineInput,
  BootstrapPermissionEngineResult,
  PreflightInput,
  PreflightResult,
} from './bootstrap-engine.ts';
export { bootstrapPermissionEngine, preflightPermissionEngine } from './bootstrap-engine.ts';

export type {
  EngineState,
  StateController,
  StateControllerOptions,
  StateTransition,
  TransitionListener,
} from './state-machine.ts';
export {
  canTransition,
  createStateController,
  isRejectingState,
} from './state-machine.ts';

export type { InstallIdentity, EnsureInstallIdOptions } from './install_id.ts';
export { ensureInstallId } from './install_id.ts';

export {
  allProtectedRoots,
  classifyProtectedPath,
  protectedTargets,
} from './protected_paths.ts';
export type {
  ProtectedClassifyInput,
  ProtectedOp,
  ProtectedTargets,
  ProtectedTier,
} from './protected_paths.ts';

export { canonicalHash, canonicalize, sha256Hex } from './canonical.ts';

export {
  enterprisePolicyPath,
  installIdPath,
  projectPolicyPath,
  userPolicyPath,
} from './paths.ts';

export type {
  Layer,
  LayerPolicy,
  LockConflict,
  ResolveOptions,
  ResolveResult,
  SectionProvenance,
} from './hierarchy.ts';
export { resolvePolicy } from './hierarchy.ts';

export {
  RULE_LIST_CAP,
  formatBash,
  formatFetch,
  formatPath,
  formatRules,
  formatSections,
  renderPolicy,
} from './render.ts';
