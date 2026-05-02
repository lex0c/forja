// Memory subsystem barrel.
//
// Step 5.1 lands the storage primitives. Higher slices (5.2+)
// will re-export their tools/CLI surface alongside these.

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
  RegistryReadResult,
  ScopeOption,
  SearchOptions,
} from './registry.ts';
