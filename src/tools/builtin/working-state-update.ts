import {
  type HypothesisSource,
  type HypothesisStatus,
  type MutationDelta,
  type WorkingStatePatch,
  type WorkingStateStore,
  applyWorkingStatePatch,
} from '../../working-state/index.ts';
import {
  ERROR_CODES,
  type Tool,
  type ToolContext,
  type ToolError,
  type ToolResult,
  isToolError,
  toolError,
} from '../types.ts';

// working_state_update — the single, permissive, partial update surface for the
// session working-state panel (WORKING_STATE.md §4). Read is free (the panel is
// injected every turn — §5), so update is the only operation. The store does all
// the bookkeeping (FIFO, staleness eviction, confirmed/refuted → log) inside the
// pure applyWorkingStatePatch; this tool only validates the patch shape and
// orchestrates get → apply → set.

const STORE_UNAVAILABLE_HINT =
  'This usually means the harness was constructed without a workingStateStore. Check HarnessConfig.';

const HYPOTHESIS_NOT_FOUND = 'working_state.hypothesis_not_found';

const requireWorkingStateStore = (
  ctx: ToolContext,
  toolName: string,
): { store: WorkingStateStore; sid: string } | ToolError => {
  if (ctx.signal.aborted) {
    return toolError(ERROR_CODES.aborted, `tool aborted before ${toolName}`, { retryable: true });
  }
  if (ctx.workingStateStore === undefined) {
    return toolError(
      'working_state.store_unavailable',
      `${toolName} requires a session-bound workingStateStore but none was provided`,
      { hint: STORE_UNAVAILABLE_HINT },
    );
  }
  return { store: ctx.workingStateStore, sid: ctx.sessionId };
};

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const HYP_STATUSES: HypothesisStatus[] = ['open', 'confirmed', 'refuted'];
const HYP_SOURCES: HypothesisSource[] = ['user', 'model', 'tool'];

export interface WorkingStateUpdateInput {
  focus?: string;
  next?: string[];
  log_append?: string[];
  hypothesis_add?: { text: string; source?: HypothesisSource };
  hypothesis_update?: { id: string; status?: HypothesisStatus; evidence_append?: string[] };
}

export interface WorkingStateUpdateHypothesisView {
  id: string;
  text: string;
  source: HypothesisSource;
  evidence_count: number;
  age_steps: number;
}

export interface WorkingStateUpdateOutput {
  // Compact echo of the resulting panel so the model confirms the effect
  // without a separate read (§4.2). Not the rendered block — that is the
  // injected copy; this is structured data.
  focus: string | null;
  next: string[];
  hypotheses: WorkingStateUpdateHypothesisView[];
  log_size: number;
  created_hypothesis_id?: string;
  mutations: MutationDelta;
  notices: string[];
}

export const workingStateUpdateTool: Tool<WorkingStateUpdateInput, WorkingStateUpdateOutput> = {
  name: 'working_state_update',
  description:
    "Track your operational thread — current focus, next steps, and the hypotheses you're testing — in a small panel re-injected into your context every turn that survives compaction, so in long work you don't lose it or re-derive it from the conversation. You read it for free (it's already in context); this tool only writes. Update it whenever your focus, active hypothesis, or next step materially changes — not for every micro-action. Partial: pass only the fields that changed.",
  inputSchema: {
    type: 'object',
    properties: {
      focus: {
        type: 'string',
        description: "1 line; '' clears.",
      },
      next: {
        type: 'array',
        items: { type: 'string' },
        description: 'Immediate next steps; <=5, overflow is a plan (use todo_create).',
      },
      log_append: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short milestones; FIFO-bounded.',
      },
      hypothesis_add: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The belief under test.' },
          source: {
            type: 'string',
            enum: [...HYP_SOURCES],
            description: "Default 'model'.",
          },
        },
        required: ['text'],
        description: 'Opens a hypothesis, returns its id. <=7 open (most stale auto-evicted).',
      },
      hypothesis_update: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'From hypothesis_add.' },
          status: {
            type: 'string',
            enum: [...HYP_STATUSES],
            description: 'confirmed/refuted archives it to the log.',
          },
          evidence_append: {
            type: 'array',
            items: { type: 'string' },
            description: 'Pointers; FIFO-capped.',
          },
        },
        required: ['id'],
        description:
          'Resolve or attach evidence. Refuting a user-sourced one: confirm with the operator first.',
      },
    },
  },
  metadata: {
    category: 'misc',
    writes: false, // session-internal state, not external mutation (like the todo tools)
    idempotent: false, // log_append / hypothesis_add accumulate
    display: 'raw',
    cost: { latency_ms_typical: 0 },
  },
  async execute(args, ctx): Promise<ToolResult<WorkingStateUpdateOutput>> {
    const got = requireWorkingStateStore(ctx, 'working_state_update');
    if (isToolError(got)) return got;
    const { store, sid } = got;

    const patch: WorkingStatePatch = {};

    if (args.focus !== undefined) {
      if (!isStr(args.focus)) return toolError(ERROR_CODES.invalidArg, 'focus must be a string');
      patch.focus = args.focus;
    }
    if (args.next !== undefined) {
      if (!isStrArray(args.next)) {
        return toolError(ERROR_CODES.invalidArg, 'next must be an array of strings');
      }
      patch.next = args.next;
    }
    if (args.log_append !== undefined) {
      if (!isStrArray(args.log_append)) {
        return toolError(ERROR_CODES.invalidArg, 'log_append must be an array of strings');
      }
      patch.logAppend = args.log_append;
    }
    if (args.hypothesis_add !== undefined) {
      const h = args.hypothesis_add as unknown;
      if (!isObject(h) || !isStr(h.text)) {
        return toolError(ERROR_CODES.invalidArg, 'hypothesis_add must be { text, source? }');
      }
      if (h.source !== undefined && !HYP_SOURCES.includes(h.source as HypothesisSource)) {
        return toolError(
          ERROR_CODES.invalidArg,
          `hypothesis_add.source must be one of: ${HYP_SOURCES.join(', ')}`,
        );
      }
      patch.hypothesisAdd = {
        text: h.text,
        ...(h.source !== undefined ? { source: h.source as HypothesisSource } : {}),
      };
    }
    if (args.hypothesis_update !== undefined) {
      const u = args.hypothesis_update as unknown;
      if (!isObject(u) || !isStr(u.id)) {
        return toolError(
          ERROR_CODES.invalidArg,
          'hypothesis_update must be { id, status?, evidence_append? }',
        );
      }
      if (u.status !== undefined && !HYP_STATUSES.includes(u.status as HypothesisStatus)) {
        return toolError(
          ERROR_CODES.invalidArg,
          `hypothesis_update.status must be one of: ${HYP_STATUSES.join(', ')}`,
        );
      }
      if (u.evidence_append !== undefined && !isStrArray(u.evidence_append)) {
        return toolError(
          ERROR_CODES.invalidArg,
          'hypothesis_update.evidence_append must be an array of strings',
        );
      }
      patch.hypothesisUpdate = {
        id: u.id,
        ...(u.status !== undefined ? { status: u.status as HypothesisStatus } : {}),
        ...(u.evidence_append !== undefined
          ? { evidenceAppend: u.evidence_append as string[] }
          : {}),
      };
    }

    if (Object.keys(patch).length === 0) {
      return toolError(
        ERROR_CODES.invalidArg,
        'provide at least one of: focus, next, log_append, hypothesis_add, hypothesis_update',
      );
    }

    const step = ctx.getStepNumber !== undefined ? ctx.getStepNumber() : 0;
    const current = store.get(sid);

    // not_found is surfaced as a clean error (a stale id, or one already
    // confirmed/refuted and thus no longer in the active list).
    if (
      patch.hypothesisUpdate !== undefined &&
      !current.hypotheses.some((h) => h.id === patch.hypothesisUpdate?.id)
    ) {
      return toolError(
        HYPOTHESIS_NOT_FOUND,
        `no open hypothesis with id ${patch.hypothesisUpdate.id}`,
        {
          hint: 'use the id returned by hypothesis_add; a confirmed/refuted hypothesis is archived and no longer updatable',
        },
      );
    }

    const result = applyWorkingStatePatch(current, patch, step, () => store.nextId(sid));
    store.set(sid, result.next);

    const out: WorkingStateUpdateOutput = {
      focus: result.next.focus?.text ?? null,
      next: result.next.next,
      hypotheses: result.next.hypotheses.map((h) => ({
        id: h.id,
        text: h.text,
        source: h.source,
        evidence_count: h.evidence.length,
        age_steps: Math.max(0, step - h.updatedAtStep),
      })),
      log_size: result.next.log.length,
      mutations: result.mutations,
      notices: result.notices,
    };
    if (result.createdHypothesisId !== undefined) {
      out.created_hypothesis_id = result.createdHypothesisId;
    }
    return out;
  },
};
