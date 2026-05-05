// Memory subsystem barrel.

export type {
  IndexEntry,
  MemoryFile,
  MemoryFrontmatter,
  MemoryScope,
  MemorySource,
  MemoryTrust,
  MemoryType,
} from './types.ts';

export {
  FrontmatterError,
  parseMemoryFile,
  serializeMemoryFile,
  validateFrontmatter,
  validateName,
} from './frontmatter.ts';

export {
  IndexError,
  INDEX_LINE_SOFT_MAX,
  parseIndex,
  removeIndexEntry,
  serializeIndex,
  upsertIndexEntry,
} from './index-file.ts';
export type { ParsedIndex, SerializeIndexResult } from './index-file.ts';

export {
  ScopeError,
  indexFilePath,
  memoryFilePath,
  projectScopeRoots,
  resolveRepoRoot,
  resolveScopeRoots,
  rootForScope,
  scopeOfPath,
  userScopeRoot,
} from './paths.ts';
export type { ScopeRoots } from './paths.ts';

export { DEFAULT_AGENT_GITIGNORE, ensureAgentGitignore } from './gitignore.ts';
export type { EnsureAgentGitignoreResult } from './gitignore.ts';

export {
  listOrphanFiles,
  loadScopeIndex,
  memoryNameFromPath,
  readMemoryByName,
} from './loader.ts';
export type { MemoryFileResult, ScopeIndexResult } from './loader.ts';

export { createMemoryRegistry } from './registry.ts';
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

export { writeMemory } from './writer.ts';
export type { WriteMemoryInput, WriteMemoryResult, WriteWarning } from './writer.ts';

export {
  findExpiredMemories,
  gcExpiredMemories,
  moveMemory,
  removeMemory,
} from './lifecycle.ts';
export type {
  ExpiredMemory,
  GcExpiredAuditOverride,
  GcExpiredOptions,
  GcExpiredResult,
  MoveMemoryInput,
  MoveMemoryResult,
  RemoveMemoryInput,
  RemoveMemoryResult,
} from './lifecycle.ts';

export {
  EMPTY_BOOT_CONTEXT,
  evaluateBootTriggers,
  shouldEagerLoadByTriggers,
} from './triggers.ts';
export type { BootContext, BootTrigger } from './triggers.ts';

export { SHARED_BODY_LINE_CAP, scanForInjection, scanForPromotion } from './scanner.ts';
export type { ScanResult } from './scanner.ts';
