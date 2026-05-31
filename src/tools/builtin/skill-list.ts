import type { SkillScope } from '../../skills/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';
import { validateSkillScope } from './_skills.ts';

// skill_list — surface the resolved skill catalog without loading any
// body (spec SKILLS.md §5.1). Returns name + description + scope per
// skill — the same catalog the system prompt surfaces eager — so the
// model can explore what is available. Use skill_show to inspect a
// body, skill_invoke to run one.

export interface SkillListInput {
  scope?: SkillScope;
}

export interface SkillListEntry {
  scope: SkillScope;
  name: string;
  description: string;
}

export interface SkillListOutput {
  skills: SkillListEntry[];
  count: number;
}

export const skillListTool: Tool<SkillListInput, SkillListOutput> = {
  name: 'skill_list',
  description:
    'List the skills available — gated, reusable procedures the agent can invoke. Returns name + description + scope per skill (the resolved catalog, same as the system-prompt surface); does NOT load bodies. Use skill_show to inspect a body, skill_invoke to run one. Pass scope to filter. Parallel-safe.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['user', 'project_shared', 'project_local'],
        description: 'Restrict to skills whose resolved scope is this one. Defaults to all three.',
      },
    },
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    parallel_safe: true,
    display: 'list',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<SkillListOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before list', { retryable: true });
    }
    if (ctx.skillCatalog === undefined) {
      return toolError(
        'skill.catalog_unavailable',
        'skill_list requires a skill catalog but none was provided',
        { hint: 'The harness was constructed without a skillCatalog. Check HarnessConfig.' },
      );
    }

    const scopeCheck = validateSkillScope(args.scope);
    if (scopeCheck !== null && typeof scopeCheck === 'object') {
      return toolError(ERROR_CODES.invalidArg, scopeCheck.error);
    }

    const entries = ctx.skillCatalog.list(scopeCheck ?? undefined);
    const skills: SkillListEntry[] = entries.map((entry) => ({
      scope: entry.scope,
      name: entry.name,
      description: entry.frontmatter.description,
    }));
    return { skills, count: skills.length };
  },
};
