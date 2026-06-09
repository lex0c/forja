// retrieve_context — model-facing tool for the retrieval
// subsystem (RETRIEVAL.md §15.4 + §1.2 "retrieval is tool, not
// driver").
//
// The tool is intentionally thin: it forwards the input to the
// runner the harness built (`ctx.retrieveContext`) and shapes the
// result for the model. All pipeline plumbing — views, ranking,
// compression, trace persistence — happens inside the runner.
//
// Read-only (the trace insert is the only DB write
// and it's append-only audit, not state mutation the operator
// would scope under "writes"). Parallel-safe — multiple retrieval
// calls in one turn don't interfere; each lands its own trace row.

import {
  RETRIEVAL_QUERY_TYPES,
  RETRIEVAL_VIEWS,
  RETRIEVAL_WORKFLOWS,
  type RetrievalQueryType,
  type RetrievalView,
  type RetrievalWorkflow,
  type RetrieveContextInput,
  type RetrieveContextOutput,
} from '../../retrieval/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

const VALID_WORKFLOWS: ReadonlySet<string> = new Set(RETRIEVAL_WORKFLOWS);
const VALID_QUERY_TYPES: ReadonlySet<string> = new Set(RETRIEVAL_QUERY_TYPES);
const VALID_VIEWS: ReadonlySet<string> = new Set(RETRIEVAL_VIEWS);

const MIN_BUDGET_TOKENS = 1;
const MAX_BUDGET_TOKENS = 100_000;

// Per-call cap on the input.views allow-list size. The valid set
// is fixed at 3, so anything larger is a malformed arg — refuse
// instead of silently truncating.
const MAX_VIEWS = 3;

// Per-call cap on query text length. Operator/model queries are
// short by design (a sentence or two of natural language, an
// identifier, a path). 10k chars is a generous ceiling that still
// refuses pathological inputs — a 1GB query string would otherwise
// be tokenized, passed through every view's BM25 scoring, persisted
// into `retrieval_trace.query_text`, and stored verbatim in audit
// logs. Refuse at the tool boundary with `tool.invalid_arg` so the
// model can resubmit a shorter query instead of corrupting downstream
// storage.
const MAX_QUERY_LENGTH = 10_000;

export interface ValidatedArgs {
  query: string;
  workflow?: RetrievalWorkflow;
  queryType?: RetrievalQueryType;
  budgetTokens?: number;
  views?: RetrievalView[];
  loadBodies?: boolean;
}

const validate = (raw: unknown): ValidatedArgs | { error: string } => {
  if (raw === null || typeof raw !== 'object') {
    return { error: 'arguments must be an object' };
  }
  const args = raw as Record<string, unknown>;

  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    return { error: 'query must be a non-empty string' };
  }
  if (args.query.length > MAX_QUERY_LENGTH) {
    return {
      error: `query length capped at ${MAX_QUERY_LENGTH} chars (got ${args.query.length}); resubmit a shorter query`,
    };
  }

  const out: ValidatedArgs = { query: args.query };

  if (args.workflow !== undefined) {
    if (typeof args.workflow !== 'string' || !VALID_WORKFLOWS.has(args.workflow)) {
      return {
        error: `workflow must be one of: ${[...VALID_WORKFLOWS].join(', ')} (got ${JSON.stringify(args.workflow)})`,
      };
    }
    out.workflow = args.workflow as RetrievalWorkflow;
  }

  if (args.queryType !== undefined) {
    if (typeof args.queryType !== 'string' || !VALID_QUERY_TYPES.has(args.queryType)) {
      return {
        error: `queryType must be one of: ${[...VALID_QUERY_TYPES].join(', ')} (got ${JSON.stringify(args.queryType)})`,
      };
    }
    out.queryType = args.queryType as RetrievalQueryType;
  }

  if (args.budgetTokens !== undefined) {
    if (
      typeof args.budgetTokens !== 'number' ||
      !Number.isFinite(args.budgetTokens) ||
      !Number.isInteger(args.budgetTokens) ||
      args.budgetTokens < MIN_BUDGET_TOKENS ||
      args.budgetTokens > MAX_BUDGET_TOKENS
    ) {
      return {
        error: `budgetTokens must be an integer in [${MIN_BUDGET_TOKENS}, ${MAX_BUDGET_TOKENS}] (got ${JSON.stringify(args.budgetTokens)})`,
      };
    }
    out.budgetTokens = args.budgetTokens;
  }

  if (args.views !== undefined) {
    if (!Array.isArray(args.views)) {
      return { error: 'views must be an array of view names' };
    }
    if (args.views.length === 0) {
      return { error: 'views array must not be empty (omit the field to use every wired view)' };
    }
    if (args.views.length > MAX_VIEWS) {
      return { error: `views array length capped at ${MAX_VIEWS}` };
    }
    const validated: RetrievalView[] = [];
    for (const v of args.views) {
      if (typeof v !== 'string' || !VALID_VIEWS.has(v)) {
        return {
          error: `views entries must be one of: ${[...VALID_VIEWS].join(', ')} (got ${JSON.stringify(v)})`,
        };
      }
      // De-dupe on the fly so a request with duplicate names
      // doesn't trick the harness into double-wiring a view.
      if (!validated.includes(v as RetrievalView)) {
        validated.push(v as RetrievalView);
      }
    }
    out.views = validated;
  }

  if (args.loadBodies !== undefined) {
    if (typeof args.loadBodies !== 'boolean') {
      return { error: 'loadBodies must be a boolean when provided' };
    }
    out.loadBodies = args.loadBodies;
  }

  return out;
};

export const retrieveContextTool: Tool<RetrieveContextInput, RetrieveContextOutput> = {
  name: 'retrieve_context',
  description:
    "Retrieve ranked, budget-constrained context that is NOT in your live window. Primary use: read back THIS conversation's earlier messages + tool_results that compaction folded into a `[compacted_history]` summary or elided to a pointer — the originals persist in the audit log, so don't assume they're gone (`session` view). Also spans repo files (`workspace`) and cross-session memories (`memory`). Returns per-candidate levels (full / outline / summary / ref) + a trail of what was skipped. Read-only and parallel-safe. `workflow` shapes ranking weights; `loadBodies: true` deepens coverage at I/O cost.",
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        maxLength: MAX_QUERY_LENGTH,
        description: `Free-text query (max ${MAX_QUERY_LENGTH} chars). Path leaks are scrubbed from the trace at persist time.`,
      },
      workflow: {
        type: 'string',
        enum: [...RETRIEVAL_WORKFLOWS],
        description:
          'Drives ranking weights (§5.2): review/refactor lean structural, debug leans temporal, precedent_lookup leans lexical + semantic. Default: default (balanced).',
      },
      queryType: {
        type: 'string',
        enum: [...RETRIEVAL_QUERY_TYPES],
        description: 'Query shape — symbol / semantic / causal / precedent / navigational.',
      },
      budgetTokens: {
        type: 'integer',
        minimum: MIN_BUDGET_TOKENS,
        maximum: MAX_BUDGET_TOKENS,
        description:
          'Token budget the compression layer respects. Default per-call: 1000. Cap: 100000.',
      },
      views: {
        type: 'array',
        items: { type: 'string', enum: [...RETRIEVAL_VIEWS] },
        description:
          "Which views to search (omit = all wired). `session`: this conversation's messages + tool_results, including compacted-out ones; `workspace`: repository files; `memory`: cross-session memories.",
      },
      loadBodies: {
        type: 'boolean',
        description:
          'When true, memory view loads body content (deep BM25 coverage). Default false (titles + descriptions only — faster, less I/O).',
      },
    },
    required: ['query'],
  },
  metadata: {
    category: 'misc',
    writes: false,
    idempotent: true,
    parallel_safe: true,
    display: 'raw',
    cost: { latency_ms_typical: 30 },
  },
  async execute(args, ctx): Promise<ToolResult<RetrieveContextOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before retrieval', {
        retryable: true,
      });
    }
    if (ctx.retrieveContext === undefined) {
      return toolError(
        'retrieval.unavailable',
        'retrieve_context requires harness wiring (memoryRegistry + db) but neither is configured for this run',
        {
          hint: 'The harness needs HarnessConfig.memoryRegistry to construct the retrieval runner. Headless / SDK runs without memory wired surface this error.',
        },
      );
    }

    const validated = validate(args);
    if ('error' in validated) {
      return toolError(ERROR_CODES.invalidArg, validated.error);
    }

    try {
      // Forward ctx.signal so a model-aborted call (or parent run
      // shutdown) can cancel mid-flight. v1 view searches are
      // synchronous SQLite/registry work so the signal mostly
      // guards the await fence; 4.4 (workspace via ripgrep) is the
      // case it actually saves.
      //
      // Forward ctx.toolCallId so the runner can emit a
      // memory_provenance row per `contextSlot.included` entry
      // (MEMORY.md §11.2, S1/T1.5). Absent (test contexts that
      // bypass the harness) ⇒ runner skips the emit cleanly.
      // Stronger than `!== undefined`: empty string would
      // coerce-pass to the runner and FK-fail every
      // recordProvenance call silently. See memory-read.ts.
      const result = await ctx.retrieveContext(
        validated,
        ctx.signal,
        typeof ctx.toolCallId === 'string' && ctx.toolCallId.length > 0
          ? { toolCallId: ctx.toolCallId }
          : undefined,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Distinguish cancellation from a genuine pipeline failure.
      // Pre-call aborts return early at the entry-point check above
      // (`tool.aborted`, retryable). But if the signal flips AFTER
      // execute() starts — during validation, during the await on
      // the runner, or while a subprocess view is in-flight — the
      // runner throws `retrieval aborted before <stage>` /
      // `retrieval aborted mid-flight` and we land here. Mapping
      // that to `retrieval.internal_error` (non-retryable) would
      // misclassify normal cancellation as a hard failure and the
      // caller would lose the standard `tool.aborted` semantic
      // (retryable=true, same shape as every other tool's abort
      // path). The signal state at catch time is the canonical
      // witness — `ctx.signal.aborted` is true iff the cancellation
      // request landed before we got here.
      if (ctx.signal.aborted) {
        return toolError(ERROR_CODES.aborted, `tool aborted during retrieval: ${msg}`, {
          retryable: true,
        });
      }
      return toolError('retrieval.internal_error', `retrieval pipeline threw: ${msg}`, {
        retryable: false,
      });
    }
  },
};
