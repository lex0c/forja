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
    // Deferred (AGENTIC_CLI §7.6): skill_invoke stays visible as the entry
    // point; browse/detail (list/show) are reached via tool_search.
    deferred: true,
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

    // Re-scan disk before listing. skill_list is the "what is
    // available right now" surface, so it must reflect a skill the
    // operator added, edited, or removed mid-session by hand — not
    // just the boot-time snapshot. The `/skill` command reloads on its
    // own mutations; this closes the out-of-band hand-edit gap for the
    // model's discovery path (and, since reload() rebuilds byName, a
    // subsequent skill_invoke resolves the freshly-seen skill too).
    // reload() rebuilds only the in-memory snapshot — it does NOT touch
    // the cached system-prompt eager surface (that stays fixed for the
    // session by design, to keep the prompt prefix cache-stable) and
    // emits no audit, so it is cheap and side-effect-free here.
    // refresh() reassigns its outputs atomically at the end, so a
    // mid-scan fs error leaves the prior snapshot intact; we still
    // swallow the throw — a stale list beats a thrown turn.
    try {
      ctx.skillCatalog.reload();
    } catch {
      // Keep the existing snapshot; a disk error must not fail the list.
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
