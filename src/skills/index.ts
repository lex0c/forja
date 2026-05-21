// Skills subsystem barrel (spec SKILLS.md).

export type { SkillFile, SkillFrontmatter, SkillScope, SkillSource } from './types.ts';

export {
  SkillFrontmatterError,
  parseSkillFile,
  serializeSkillFile,
  validateFrontmatter,
  validateName,
} from './frontmatter.ts';

export {
  ScopeError,
  projectScopeRoots,
  resolveScopeRoots,
  rootForScope,
  skillFilePath,
  userScopeRoot,
} from './paths.ts';
export type { SkillScopeRoots } from './paths.ts';

export { listSkillNames, readSkillByName, scanScope } from './loader.ts';
export type { ScannedSkill, SkillFileResult } from './loader.ts';

export { createSkillCatalog } from './catalog.ts';
export type {
  CreateSkillCatalogInput,
  FilteredSkill,
  RecordSkillEventInput,
  SkillCatalog,
  SkillCatalogEntry,
  SkillFilterReason,
  SkillReadResult,
} from './catalog.ts';
