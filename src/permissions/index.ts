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
  SealMode,
  SealOnFailure,
  SealPolicy,
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

export type { EngineOptions, PermissionEngine, ReloadPolicyResult, ToolArgs } from './engine.ts';
export { DEFAULT_SCORE_CONFIRM_THRESHOLD, createPermissionEngine } from './engine.ts';

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
export type { ChainBreakAcceptedRow } from './audit.ts';
export {
  computeGenesisHash,
  createNoopSink,
  createSqliteSink,
  listChainBreakAcceptedRows,
} from './audit.ts';

export type {
  AcquireSandboxTmpdirOptions,
  SandboxAvailability,
  SandboxTmpdir,
  DetectSandboxAvailabilityOptions,
} from './sandbox-availability.ts';
export {
  acquireSandboxTmpdir,
  defaultSandboxTmpdir,
  detectSandboxAvailability,
} from './sandbox-availability.ts';

export type {
  SandboxProfile,
  SelectSandboxProfileOptions,
  SelectSandboxProfileResult,
} from './sandbox-plan.ts';
export { SANDBOX_PROFILE_ORDER, isSandboxProfile, selectSandboxProfile } from './sandbox-plan.ts';

export type { BuildBwrapArgvOptions, MaybeWrapSandboxArgvOptions } from './sandbox-runner.ts';
export { buildBwrapArgv, maybeWrapSandboxArgv } from './sandbox-runner.ts';
export type { BuildSandboxExecArgvOptions } from './sandbox-runner-macos.ts';
export { buildSandboxExecArgv, buildSbplProfile } from './sandbox-runner-macos.ts';

export type {
  BuildContextSummaryOptions,
  ContextSummaryBuffer,
  ContextSummaryEntry,
} from './context-summary.ts';
export {
  DEFAULT_CONTEXT_SUMMARY_DEPTH,
  DEFAULT_CONTEXT_SUMMARY_MAX_BYTES,
  buildContextSummary,
  createContextSummaryBuffer,
} from './context-summary.ts';

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

export type { InstallIdentity, EnsureInstallIdOptions, IsFirstBootOptions } from './install_id.ts';
export { ensureInstallId, isFirstBoot } from './install_id.ts';

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
  SandboxProvenance,
  SectionProvenance,
} from './hierarchy.ts';
export { mergeLayers, resolvePolicy } from './hierarchy.ts';

export type { PolicyWatcher, WatchAndReloadOptions } from './policy-watcher.ts';
export { watchAndReload } from './policy-watcher.ts';

export type {
  CreateGitAnchoredSealerOptions,
  CreateWormFileSealerOptions,
  SealAppendResult,
  SealEntry,
  SealStore,
  VerifySealResult,
} from './sealing.ts';
export {
  createGitAnchoredSealer,
  createWormFileSealer,
  defaultGitAnchoredFactory,
  defaultWormFileFactory,
  factoryForSealMode,
  verifySealAgainstChain,
} from './sealing.ts';

export type {
  CreateSealingSchedulerOptions,
  SealingScheduler,
  SealNowResult,
} from './sealing-scheduler.ts';
export {
  DEFAULT_SEAL_INTERVAL_DECISIONS,
  DEFAULT_SEAL_INTERVAL_SECONDS,
  createSealingScheduler,
} from './sealing-scheduler.ts';

// Slice 142 (review minor): canonical export surface for symbols
// referenced by tests, bootstrap, and future playbooks that were
// previously reachable only via deep imports. Keeping them on the
// barrel avoids re-introducing the same finding on the next review.
export { AUDIT_TS_FUTURE_SKEW_MS } from './audit.ts';

export type { Capability, CapabilityKind } from './capabilities.ts';
export type { EffectiveCoverResult, IntersectionResult } from './capabilities.ts';
export {
  TOOL_CAPABILITY_FOOTPRINTS,
  agentMutate,
  capabilityCovers,
  capabilityCoversCwdAware,
  capabilityEquals,
  deleteFs,
  deriveParentCapabilities,
  effectiveCovers,
  envMutate,
  exec,
  formatCapability,
  gitWrite,
  hostPassthrough,
  intersectCapabilities,
  isCapabilityKind,
  netEgress,
  netIngress,
  parseCapability,
  readFs,
  secretAccess,
  sortCapabilities,
  writeFs,
} from './capabilities.ts';

export type { GenerateUlidOptions } from './ulid.ts';
export { generateUlid, isUlid } from './ulid.ts';

export type {
  RiskScoreConfidence,
  RiskScoreInput,
  RiskScoreOutput,
} from './risk-score.ts';
export {
  RECENT_ERRORS_THRESHOLD,
  RISK_SCORE_WEIGHTS,
  computeRiskScore,
} from './risk-score.ts';

export type {
  BuildClassifierInputArgs,
  Classifier,
  ClassifierInput,
  ClassifierOutput,
} from './classifier.ts';
export {
  CLASSIFIER_ADJUST_BOUNDS,
  buildClassifierInput,
  clampAdjust,
  createNoopClassifier,
  validateClassifierOutput,
} from './classifier.ts';

export type {
  CreateDegradedBannerEmitterOptions,
  DegradedBannerEmitter,
  DegradedBannerEvent,
} from './degraded-banner.ts';
export { createDegradedBannerEmitter } from './degraded-banner.ts';

export {
  RULE_LIST_CAP,
  formatBash,
  formatFetch,
  formatPath,
  renderSandbox,
  formatRules,
  formatSections,
  renderPolicy,
} from './render.ts';
