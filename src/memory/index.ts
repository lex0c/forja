// Memory subsystem barrel.

export type { MemoryDependent } from './dependents.ts';
export { detectMemoryDependents } from './dependents.ts';
export { isExpired, parseExpiresEndOfDayMs } from './expires.ts';
export {
  FrontmatterError,
  parseMemoryFile,
  serializeMemoryFile,
  validateFrontmatter,
  validateName,
} from './frontmatter.ts';
export type { EnsureAgentGitignoreResult } from './gitignore.ts';
export { DEFAULT_AGENT_GITIGNORE, ensureAgentGitignore } from './gitignore.ts';
export type {
  ApplyProposalInput,
  ApplyProposalResult,
  ApplyRejectionReason,
  DriftedSnapshot,
  TransitionRecord,
} from './governance.ts';
export { applyProposal } from './governance.ts';
export type { ParsedIndex, SerializeIndexResult } from './index-file.ts';
export {
  INDEX_LINE_SOFT_MAX,
  IndexError,
  parseIndex,
  removeIndexEntry,
  serializeIndex,
  upsertIndexEntry,
} from './index-file.ts';
export type {
  ExpiredMemory,
  GcExpiredAuditOverride,
  GcExpiredOptions,
  GcExpiredResult,
  GcPurgeOptions,
  GcPurgeResult,
  MoveMemoryInput,
  MoveMemoryResult,
  PurgedTombstone,
  RemoveMemoryInput,
  RemoveMemoryResult,
} from './lifecycle.ts';
export {
  findExpiredMemories,
  gcExpiredMemories,
  gcPurgeExpiredTombstones,
  gcStaleInvalidatedMemories,
  moveMemory,
  removeMemory,
} from './lifecycle.ts';
export type { MemoryFileResult, ScopeIndexResult } from './loader.ts';
export {
  listOrphanFiles,
  loadScopeIndex,
  memoryNameFromPath,
  readMemoryByName,
} from './loader.ts';
export type { ScopeRoots } from './paths.ts';
export {
  indexFilePath,
  memoryFilePath,
  parseTombstoneFilename,
  projectScopeRoots,
  resolveRepoRoot,
  resolveScopeRoots,
  rootForScope,
  ScopeError,
  scopeOfPath,
  seedMemoryFilePath,
  tombstonePath,
  tombstonesDir,
  userScopeRoot,
} from './paths.ts';
export type {
  AuditOverride,
  CreateMemoryRegistryInput,
  ListOptions,
  MemoryListing,
  MemoryRegistry,
  MemorySearchHit,
  ReadOptions,
  RegistryEventInput,
  RegistryReadResult,
  RegistryWriteResult,
  ScopeOption,
  SearchOptions,
  WriteOptions,
} from './registry.ts';
export {
  createMemoryRegistry,
  listingScopeOption,
  MAX_OVERRIDE_ATTRIBUTION_DEPTH,
} from './registry.ts';
export type { ScanResult } from './scanner.ts';
export {
  redactSecrets,
  SHARED_BODY_LINE_CAP,
  scanForInjection,
  scanForPromotion,
  scanForSecrets,
} from './scanner.ts';
export type {
  DisabledSeedEntry,
  DisabledSeeds,
} from './seeds-disabled.ts';
export {
  isSeedDisabled,
  loadDisabledSeeds,
  writeDisabledSeeds,
} from './seeds-disabled.ts';
export type {
  InstallVendorSeedsOptions,
  SeedAction,
  SeedsInstallResult,
} from './seeds-installer.ts';
export { installVendorSeeds } from './seeds-installer.ts';
export type { SeedManifest, SeedManifestEntry } from './seeds-manifest.ts';
export { loadSeedManifest, writeSeedManifest } from './seeds-manifest.ts';
export type {
  MoveToTombstoneOptions,
  MoveToTombstoneResult,
  TombstoneEntry,
} from './tombstones.ts';
export {
  findLatestTombstone,
  listExpiredTombstones,
  listTombstones,
  moveToTombstone,
  removeFromTombstones,
} from './tombstones.ts';
export type {
  TransitionMemoryStateInput,
  TransitionMemoryStateResult,
} from './transitions.ts';
export { transitionMemoryState } from './transitions.ts';
export type { BootContext, BootTrigger } from './triggers.ts';

export {
  EMPTY_BOOT_CONTEXT,
  evaluateBootTriggers,
  shouldEagerLoadByTriggers,
} from './triggers.ts';
export type { CorpusFile, CorpusListing, SharedTrustRow } from './trust-corpus.ts';
export {
  clearSharedTrust,
  computeSharedFingerprint,
  EMPTY_CORPUS_HASH,
  getSharedTrust,
  listSharedCorpusFiles,
  setSharedTrust,
} from './trust-corpus.ts';
export type {
  ProbeCorpusFile,
  ProbeSharedTrustInput,
  ProbeSharedTrustResult,
  SharedTrustModalMode,
  SharedTrustProbeAnswer,
} from './trust-corpus-probe.ts';
export { probeSharedTrust } from './trust-corpus-probe.ts';
export type {
  EagerExposure,
  IndexEntry,
  MemoryFile,
  MemoryFrontmatter,
  MemoryScope,
  MemorySource,
  MemoryState,
  MemorySubdir,
  MemoryTrust,
  MemoryType,
} from './types.ts';
export { MEMORY_STATES } from './types.ts';
export type { WriteMemoryInput, WriteMemoryResult, WriteWarning } from './writer.ts';
export { writeMemory } from './writer.ts';
