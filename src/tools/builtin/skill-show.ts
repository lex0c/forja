import type { SkillScope } from '../../skills/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, isToolError, toolError } from '../types.ts';
import { resolveSkillForTool } from './_skills.ts';

// skill_show — print a skill's full body for inspection WITHOUT
// invoking it (spec SKILLS.md §5.1: list / show are read-only).
// Unlike skill_invoke this records no `invoked` audit event and
// applies no `<skill>` trust marker — the body is returned raw for
// the operator or the model to read.

export interface SkillShowInput {
  name: string;
  scope?: SkillScope;
}

export interface SkillShowOutput {
  scope: SkillScope;
  name: string;
  description: string;
  version?: number;
  trigger_keywords?: string[];
  tools?: string[];
  requires?: string[];
  expires?: string;
  body: string;
}

export const skillShowTool: Tool<SkillShowInput, SkillShowOutput> = {
  name: 'skill_show',
  description:
    "Print a skill's full body for inspection WITHOUT invoking it — read-only, records no invocation, applies no trust marker. Use skill_invoke to actually run a skill. Without scope, resolves project_local → project_shared → user; pass scope to pin a strict lookup. Parallel-safe.",
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Canonical skill name — the kebab-case identifier from skill_list.',
      },
      scope: {
        type: 'string',
        enum: ['user', 'project_shared', 'project_local'],
        description: 'Optional. Pin the lookup to one scope (no precedence fallback).',
      },
    },
    required: ['name'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    planSafe: true,
    parallel_safe: true,
    display: 'raw',
    cost: { latency_ms_typical: 5 },
  },
  async execute(input, ctx): Promise<ToolResult<SkillShowOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before show', { retryable: true });
    }
    const resolved = resolveSkillForTool('skill_show', input, ctx);
    if (isToolError(resolved)) return resolved;
    const { scope, file } = resolved;

    const fm = file.frontmatter;
    const out: SkillShowOutput = {
      scope,
      name: input.name,
      description: fm.description,
      body: file.body,
    };
    if (fm.version !== undefined) out.version = fm.version;
    if (fm.trigger_keywords !== undefined) out.trigger_keywords = fm.trigger_keywords;
    if (fm.tools !== undefined) out.tools = fm.tools;
    if (fm.requires !== undefined) out.requires = fm.requires;
    if (fm.expires !== undefined) out.expires = fm.expires;
    return out;
  },
};
