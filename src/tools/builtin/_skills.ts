import {
  type SkillCatalog,
  type SkillFile,
  SkillFrontmatterError,
  type SkillScope,
  validateName,
} from '../../skills/index.ts';
import { ERROR_CODES, type ToolContext, type ToolError, toolError } from '../types.ts';

// Shared internals for the skill_invoke / skill_list / skill_show
// tools (spec SKILLS.md §5). Underscore-prefixed: a helper module,
// not a tool file — `index.ts` does not register it.

const VALID_SCOPES: ReadonlySet<string> = new Set(['user', 'project_shared', 'project_local']);

// Validate a model-supplied `scope` argument. Returns the narrowed
// `SkillScope`, `null` when absent (no scope filter / precedence
// resolution), or an `{ error }` the tool maps to `tool.invalid_arg`.
// The `imported` scope (§3.4) is v2 — not accepted here.
export const validateSkillScope = (raw: unknown): SkillScope | null | { error: string } => {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    return { error: 'scope must be a string when provided' };
  }
  if (!VALID_SCOPES.has(raw)) {
    return {
      error: `scope must be one of: user, project_shared, project_local (got ${JSON.stringify(raw)})`,
    };
  }
  return raw as SkillScope;
};

// The literal closing marker. A skill body that itself contains this
// string can't be safely delimited — it would let the body break out
// of the `<skill>` trust boundary — so `skill_invoke` rejects such a
// body as malformed before wrapping.
export const SKILL_MARKER_CLOSE = '</skill>';

// Wrap a skill body in the `<skill>` trust marker (spec §4.2 / §7.2).
// The model is trained to treat the delimited text as content — a
// procedure to follow — not as system instruction, so a skill body
// cannot smuggle in directives ("approve everything", "ignore prior
// instructions"). The caller MUST first reject a body containing
// `SKILL_MARKER_CLOSE`.
export const wrapSkillBody = (name: string, scope: SkillScope, body: string): string =>
  `<skill name="${name}" scope="${scope}">\n${body}\n</skill>`;

// A skill resolved by `resolveSkillForTool`: the catalog that holds
// it, its winning scope, and the freshly-read file.
export interface ResolvedSkill {
  catalog: SkillCatalog;
  scope: SkillScope;
  file: SkillFile;
}

// The shared skill_invoke / skill_show prelude: confirm the catalog
// is wired, validate the `name` and `scope` arguments, resolve the
// skill, and map a not_found / missing / malformed read result onto a
// ToolError. Returns the resolved skill on success, or a ToolError
// the caller returns verbatim. `toolName` flavors only the catalog-
// unavailable message.
//
// The two tools were byte-identical from the catalog check through
// the read-result mapping; this helper is the single source so a
// fix — or a new `SkillReadResult` arm — lands in one place.
export const resolveSkillForTool = (
  toolName: string,
  input: { name: unknown; scope?: unknown },
  ctx: ToolContext,
): ResolvedSkill | ToolError => {
  if (ctx.skillCatalog === undefined) {
    return toolError(
      'skill.catalog_unavailable',
      `${toolName} requires a skill catalog but none was provided`,
      { hint: 'The harness was constructed without a skillCatalog. Check HarnessConfig.' },
    );
  }
  if (typeof input.name !== 'string') {
    return toolError(ERROR_CODES.invalidArg, 'name must be a string');
  }
  // Re-run the storage name validator so a traversal-shaped name
  // surfaces as a clean `invalid_arg`, not a confusing not_found.
  try {
    validateName(input.name);
  } catch (err) {
    if (err instanceof SkillFrontmatterError) {
      return toolError(ERROR_CODES.invalidArg, err.message);
    }
    throw err;
  }
  const scopeCheck = validateSkillScope(input.scope);
  if (scopeCheck !== null && typeof scopeCheck === 'object') {
    return toolError(ERROR_CODES.invalidArg, scopeCheck.error);
  }

  const result = ctx.skillCatalog.read(input.name, scopeCheck ?? undefined);
  if (result.kind === 'not_found') {
    const scopeQual = scopeCheck !== null ? ` in scope ${scopeCheck}` : '';
    return toolError(
      'skill.not_found',
      `no skill named ${JSON.stringify(input.name)} found${scopeQual}`,
      { hint: 'Call skill_list to see available skills.' },
    );
  }
  if (result.kind === 'missing') {
    return toolError(
      'skill.body_missing',
      `skill ${JSON.stringify(input.name)} is in the catalog (scope ${result.scope}) but its file is missing on disk`,
      { hint: 'The operator may have deleted the file. Call skill_list to refresh.' },
    );
  }
  if (result.kind === 'malformed') {
    return toolError(
      'skill.malformed',
      `skill ${JSON.stringify(input.name)} failed to load: ${result.error}`,
      { details: { scope: result.scope } },
    );
  }
  return { catalog: ctx.skillCatalog, scope: result.scope, file: result.file };
};
