import type { MemoryScope } from '../../memory/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// memory_search — substring search across memory names and
// descriptions, optionally including bodies (deep mode). Spec:
// "Markdown, não vector" (princípio 9). Grep is the contract;
// fuzziness, embeddings, semantic similarity are explicitly out
// (`ANTI_PATTERNS` §2.2).
//
// The default search hits only the loaded index — names and
// descriptions — so the cost is constant regardless of how many
// memories exist. `deep: true` expands the search to memory
// bodies, which means O(N) disk reads. The limit defaults to 50;
// the model can lower it for cheap "is anything matching" probes.

const VALID_SCOPES: ReadonlySet<string> = new Set(['user', 'project_shared', 'project_local']);

export interface MemorySearchInput {
  query: string;
  scope?: MemoryScope;
  deep?: boolean;
  limit?: number;
}

export interface MemorySearchHitOutput {
  scope: MemoryScope;
  name: string;
  matched_in: 'name' | 'description' | 'body';
  snippet: string;
}

export interface MemorySearchOutput {
  query: string;
  hits: MemorySearchHitOutput[];
  count: number;
  // True when the registry hit the limit; the model can re-query
  // with a higher `limit` or a more specific `query`.
  truncated: boolean;
}

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

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export const memorySearchTool: Tool<MemorySearchInput, MemorySearchOutput> = {
  name: 'memory_search',
  description:
    'Substring search across memory names, descriptions, and (with deep=true) bodies. Case-insensitive, no fuzziness — this is grep, not vector retrieval. Returns up to `limit` hits (default 50, max 200). Use after memory_list when you want to narrow by topic.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Substring to search for (case-insensitive).',
      },
      scope: {
        type: 'string',
        enum: ['user', 'project_shared', 'project_local'],
        description: 'Restrict search to one scope. Defaults to all three.',
      },
      deep: {
        type: 'boolean',
        description:
          'When true, also search memory bodies (one disk read per memory). Default false (only name + description).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: `Max hits to return. Default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}.`,
      },
    },
    required: ['query'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    planSafe: true,
    display: 'list',
    // Body searches do disk reads; latency tracks roughly with the
    // memory count. The hint is a typical case (~10 memories).
    cost: { latency_ms_typical: 10 },
  },
  async execute(args, ctx): Promise<ToolResult<MemorySearchOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before search', { retryable: true });
    }
    if (ctx.memoryRegistry === undefined) {
      return toolError(
        'memory.registry_unavailable',
        'memory_search requires a memory registry but none was provided',
        {
          hint: 'The harness was constructed without a memoryRegistry. Check HarnessConfig.',
        },
      );
    }

    if (typeof args.query !== 'string' || args.query.length === 0) {
      return toolError(ERROR_CODES.invalidArg, 'query must be a non-empty string');
    }

    const scopeCheck = validateScope(args.scope);
    if (scopeCheck !== null && typeof scopeCheck === 'object') {
      return toolError(ERROR_CODES.invalidArg, scopeCheck.error);
    }

    if (args.deep !== undefined && typeof args.deep !== 'boolean') {
      return toolError(ERROR_CODES.invalidArg, 'deep must be a boolean when provided');
    }

    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined) {
      if (
        typeof args.limit !== 'number' ||
        !Number.isFinite(args.limit) ||
        !Number.isInteger(args.limit) ||
        args.limit < 1
      ) {
        return toolError(ERROR_CODES.invalidArg, 'limit must be a positive integer (>=1)');
      }
      if (args.limit > MAX_LIMIT) {
        return toolError(
          ERROR_CODES.invalidArg,
          `limit exceeds max (${MAX_LIMIT}, got ${args.limit})`,
        );
      }
      limit = args.limit;
    }

    // Ask for one extra hit so we can detect truncation accurately:
    // if we get back `limit+1`, we know there's at least one more
    // match. The reported `hits` is sliced to `limit`.
    //
    // Forward ctx.sessionId / ctx.cwd as audit overrides. The
    // deep branch emits `read` events for body-match hits; without
    // per-call attribution these would land with session_id NULL
    // for top-level runs (bootstrap captures the registry before
    // the session exists).
    const raw = ctx.memoryRegistry.search(args.query, {
      ...(scopeCheck !== null ? { scope: scopeCheck } : {}),
      ...(args.deep === true ? { deep: true } : {}),
      limit: limit + 1,
      auditSessionId: ctx.sessionId,
      auditCwd: ctx.cwd,
    });

    const truncated = raw.length > limit;
    const hits = raw.slice(0, limit).map((h) => ({
      scope: h.scope,
      name: h.name,
      matched_in: h.matchedIn,
      snippet: h.snippet,
    }));

    return {
      query: args.query,
      hits,
      count: hits.length,
      truncated,
    };
  },
};
