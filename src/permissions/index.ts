export type {
  AuditEmitInput,
  AuditSink,
  ChainBreakAcceptedRow,
  EmittedRow,
  ReasonChainEntry,
  VerifyResult,
} from './audit.ts';
// Canonical export surface for symbols referenced by tests,
// bootstrap, and playbooks. Keeping them on the barrel avoids deep
// imports.
export {
  AUDIT_TS_FUTURE_SKEW_MS,
  computeGenesisHash,
  createNoopSink,
  createSqliteSink,
  listChainBreakAcceptedRows,
} from './audit.ts';
export type {
  BootstrapPermissionEngineInput,
  BootstrapPermissionEngineResult,
  PreflightInput,
  PreflightResult,
} from './bootstrap-engine.ts';
export { bootstrapPermissionEngine, preflightPermissionEngine } from './bootstrap-engine.ts';
export { canonicalHash, canonicalize, sha256Hex } from './canonical.ts';
export type {
  Capability,
  CapabilityKind,
  EffectiveCoverResult,
  IntersectionResult,
} from './capabilities.ts';
export {
  capabilityCovers,
  capabilityCoversCwdAware,
  capabilityEquals,
  deleteFs,
  deriveParentCapabilities,
  effectiveCovers,
  envMutate,
  exec,
  forjaMutate,
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
  TOOL_CAPABILITY_FOOTPRINTS,
  writeFs,
} from './capabilities.ts';
export type {
  BuildClassifierInputArgs,
  Classifier,
  ClassifierInput,
  ClassifierOutput,
} from './classifier.ts';
export {
  buildClassifierInput,
  CLASSIFIER_ADJUST_BOUNDS,
  clampAdjust,
  createNoopClassifier,
  validateClassifierOutput,
} from './classifier.ts';
export type { ParsePolicyContext } from './config.ts';
export {
  defaultPolicy,
  loadPolicyFromFile,
  loadPolicyFromString,
  parsePolicy,
} from './config.ts';
export type {
  BuildContextSummaryOptions,
  ContextSummaryBuffer,
  ContextSummaryEntry,
} from './context-summary.ts';
export {
  buildContextSummary,
  createContextSummaryBuffer,
  DEFAULT_CONTEXT_SUMMARY_DEPTH,
  DEFAULT_CONTEXT_SUMMARY_MAX_BYTES,
} from './context-summary.ts';
export type {
  CreateDegradedBannerEmitterOptions,
  DegradedBannerEmitter,
  DegradedBannerEvent,
} from './degraded-banner.ts';
export { createDegradedBannerEmitter } from './degraded-banner.ts';
export type { EngineOptions, PermissionEngine, ReloadPolicyResult, ToolArgs } from './engine.ts';
export { createPermissionEngine, DEFAULT_SCORE_CONFIRM_THRESHOLD } from './engine.ts';
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
export type { EnsureInstallIdOptions, InstallIdentity, IsFirstBootOptions } from './install_id.ts';
export { ensureInstallId, isFirstBoot } from './install_id.ts';
export {
  escapeGlobMetacharacters,
  firstMatchingCommand,
  firstMatchingHost,
  firstMatchingPath,
  matchCommand,
  matchHost,
  matchPath,
} from './matcher.ts';
export {
  enterprisePolicyPath,
  installIdPath,
  projectPolicyPath,
  userPolicyPath,
} from './paths.ts';
export type { PolicyWatcher, WatchAndReloadOptions } from './policy-watcher.ts';
export { watchAndReload } from './policy-watcher.ts';
export type {
  ProtectedClassifyInput,
  ProtectedOp,
  ProtectedTargets,
  ProtectedTier,
} from './protected_paths.ts';
export {
  allProtectedRoots,
  classifyProtectedPath,
  protectedTargets,
} from './protected_paths.ts';
export {
  formatBash,
  formatFetch,
  formatPath,
  formatRules,
  formatSections,
  RULE_LIST_CAP,
  renderPolicy,
  renderSandbox,
} from './render.ts';
export type {
  RiskScoreConfidence,
  RiskScoreInput,
  RiskScoreOutput,
} from './risk-score.ts';
export {
  computeRiskScore,
  RECENT_ERRORS_THRESHOLD,
  RISK_SCORE_WEIGHTS,
} from './risk-score.ts';
export type {
  AcquireSandboxTmpdirOptions,
  DetectSandboxAvailabilityOptions,
  SandboxAvailability,
  SandboxTmpdir,
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
export { isSandboxProfile, SANDBOX_PROFILE_ORDER, selectSandboxProfile } from './sandbox-plan.ts';
export type { BuildBwrapArgvOptions, MaybeWrapSandboxArgvOptions } from './sandbox-runner.ts';
export { buildBwrapArgv, maybeWrapSandboxArgv } from './sandbox-runner.ts';
export type { BuildSandboxExecArgvOptions } from './sandbox-runner-macos.ts';
export { buildSandboxExecArgv, buildSbplProfile } from './sandbox-runner-macos.ts';
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
  createSealingScheduler,
  DEFAULT_SEAL_INTERVAL_DECISIONS,
  DEFAULT_SEAL_INTERVAL_SECONDS,
} from './sealing-scheduler.ts';
// Sensitive-path deny-list as an engine-floor refuse.
export { matchSensitivePath, SENSITIVE_PATH_DENY_LIST } from './sensitive-paths.ts';
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
export type {
  ApprovalPosture,
  BashPolicy,
  ConfirmCause,
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
  PostureChange,
  SealMode,
  SealOnFailure,
  SealPolicy,
} from './types.ts';
export type { GenerateUlidOptions } from './ulid.ts';
export { generateUlid, isUlid } from './ulid.ts';
