import type { MemoryScope } from '../../memory/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// memory_list — surface the per-scope memory index without loading
// any body. Spec §4.2: "Index eager, content lazy". The tool
// answers "what memories does the agent have access to?" using the
// already-loaded index, so the only cost is a Map iteration.
//
// The `scope` argument is an optional filter; without it, the tool
// returns entries from all three scopes in precedence order
// (project_local first, then project_shared, then user). When the
// same `name` exists in multiple scopes, all appearances are
// returned by default — the model can see the shadowing — and
// `dedupe_by_name: true` collapses duplicates to the most-specific
// scope.

export type MemoryScopeArg = MemoryScope;

export interface MemoryListInput {
  scope?: MemoryScopeArg;
  dedupe_by_name?: boolean;
}

export interface MemoryListEntry {
  scope: MemoryScope;
  name: string;
  description: string;
  href: string;
}

export interface MemoryListOutput {
  entries: MemoryListEntry[];
  count: number;
}

const VALID_SCOPES: ReadonlySet<string> = new Set(['user', 'project_shared', 'project_local']);

const validateScope = (raw: unknown): MemoryScope | null | { error: string } => {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    return { error: 'scope must be a string when provided' };
  }
  if (!VALID_SCOPES.has(raw)) {
    return {
      error: `scope must be one of: user, project_shared, project_local (got ${JSON.stringify(raw)})`,
    };
  }
  return raw as MemoryScope;
};

export const memoryListTool: Tool<MemoryListInput, MemoryListOutput> = {
  name: 'memory_list',
  description:
    'List memory entries the agent has cross-session access to. Returns name, description, scope (project_local | project_shared | user), and href. Does NOT load the body content — call memory_read to fetch a specific entry. Pass scope to filter to one scope, or dedupe_by_name=true to collapse same-name shadowing across scopes (most-specific scope wins). Parallel-safe: emit multiple memory_list calls in a single turn (e.g. one per scope) to enumerate concurrently.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['user', 'project_shared', 'project_local'],
        description: 'Restrict to one scope. Defaults to all three.',
      },
      dedupe_by_name: {
        type: 'boolean',
        description:
          'When the same name exists in multiple scopes, return only the most-specific scope per name (project_local > project_shared > user).',
      },
    },
  },
  metadata: {
    // misc — same rationale as todo_write: the tool's only side
    // effect is reading the in-process registry snapshot. The
    // model's policy engine has no per-memory permission concept;
    // any future "deny memory access by scope" rule belongs in a
    // dedicated category (memory.read), not bash/fs.
    category: 'misc',
    writes: false,
    idempotent: true,
    planSafe: true,
    parallel_safe: true,
    display: 'list',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<MemoryListOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before list', { retryable: true });
    }
    if (ctx.memoryRegistry === undefined) {
      // Same shape as todoStore / bgManager unavailable. Operator-
      // facing configuration error, not user error.
      return toolError(
        'memory.registry_unavailable',
        'memory_list requires a memory registry but none was provided',
        {
          hint: 'The harness was constructed without a memoryRegistry. Check HarnessConfig.',
        },
      );
    }

    const scopeCheck = validateScope(args.scope);
    if (scopeCheck !== null && typeof scopeCheck === 'object') {
      return toolError(ERROR_CODES.invalidArg, scopeCheck.error);
    }
    if (args.dedupe_by_name !== undefined && typeof args.dedupe_by_name !== 'boolean') {
      return toolError(ERROR_CODES.invalidArg, 'dedupe_by_name must be a boolean when provided');
    }

    const listings = ctx.memoryRegistry.list({
      ...(scopeCheck !== null ? { scope: scopeCheck } : {}),
      ...(args.dedupe_by_name === true ? { deduplicateByName: true } : {}),
    });

    const entries: MemoryListEntry[] = listings.map((l) => ({
      scope: l.scope,
      name: l.name,
      description: l.entry.hook,
      href: l.entry.href,
    }));

    return { entries, count: entries.length };
  },
};
