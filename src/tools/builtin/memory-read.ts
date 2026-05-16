import { FrontmatterError, type MemoryScope, validateName } from '../../memory/index.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// memory_read — load the body of one memory by name. Spec §4.2:
// "Lazy: content. Modelo lê o índice, decide se vale puxar
// conteúdo." This is the lazy-load tool the model invokes after
// scanning the index.
//
// Audit (spec §5.3): every successful read emits a `read` event
// in memory_events. The registry handles persistence; the tool
// just dispatches.
//
// Scope semantics: with no scope, the registry walks
// project_local → project_shared → user and returns the first
// match. With an explicit scope, the lookup is strict (no
// fallback) — the model's `scope: 'shared'` lookup must NOT
// silently resolve to a user-scope memory of the same name; that
// would defeat the precedence model.

const VALID_SCOPES: ReadonlySet<string> = new Set(['user', 'project_shared', 'project_local']);

export interface MemoryReadInput {
  name: string;
  scope?: MemoryScope;
}

export interface MemoryReadOutput {
  scope: MemoryScope;
  name: string;
  description: string;
  type: string;
  source: string;
  expires?: string;
  trust?: string;
  triggers?: string[];
  body: string;
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

export const memoryReadTool: Tool<MemoryReadInput, MemoryReadOutput> = {
  name: 'memory_read',
  description:
    'Load the body of one memory by name. Without scope, looks up project_local → project_shared → user and returns the first match; pass scope to pin a strict lookup. Parallel-safe: emit multiple memory_read calls in a single turn to load several memories concurrently.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Canonical memory name (kebab-case identifier from the index).',
      },
      scope: {
        type: 'string',
        enum: ['user', 'project_shared', 'project_local'],
        description: 'Optional. Pin the lookup to one scope (no fallback).',
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
  async execute(args, ctx): Promise<ToolResult<MemoryReadOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before read', { retryable: true });
    }
    if (ctx.memoryRegistry === undefined) {
      return toolError(
        'memory.registry_unavailable',
        'memory_read requires a memory registry but none was provided',
        {
          hint: 'The harness was constructed without a memoryRegistry. Check HarnessConfig.',
        },
      );
    }
    if (typeof args.name !== 'string') {
      return toolError(ERROR_CODES.invalidArg, 'name must be a string');
    }
    // Re-run the storage-layer name validator before hitting the
    // registry. Two reasons:
    //   1. The error is shaped as a tool error (invalid_arg) instead
    //      of a thrown FrontmatterError that would propagate as
    //      "internal error" to the model.
    //   2. The registry's `lookup` does not throw for unknown names
    //      — it returns null. Without this guard, a name like
    //      `../etc/passwd` would silently miss and the model would
    //      get `not_found` for a path-traversal attempt, masking the
    //      real issue. The validator makes the rejection explicit.
    try {
      validateName(args.name);
    } catch (err) {
      if (err instanceof FrontmatterError) {
        return toolError(ERROR_CODES.invalidArg, err.message);
      }
      throw err;
    }

    const scopeCheck = validateScope(args.scope);
    if (scopeCheck !== null && typeof scopeCheck === 'object') {
      return toolError(ERROR_CODES.invalidArg, scopeCheck.error);
    }

    // Forward ctx.sessionId / ctx.cwd as audit overrides. Top-
    // level bootstrap can't capture sessionId at registry
    // construction (the session is created later by the harness
    // loop), so without this per-call attribution every read
    // would land in memory_events with session_id NULL — breaking
    // listMemoryEventsBySession queries for the active run.
    //
    // auditToolCallId enables the per-call provenance trail
    // (MEMORY.md §11.2) — every successful read also emits a
    // memory_provenance row linking the exposure to this tool
    // call. Skipped (no provenance row) when ctx.toolCallId is
    // absent — happens in test contexts that bypass the harness.
    const result = ctx.memoryRegistry.read(args.name, {
      ...(scopeCheck !== null ? { scope: scopeCheck } : {}),
      auditSessionId: ctx.sessionId,
      auditCwd: ctx.cwd,
      ...(ctx.toolCallId !== undefined ? { auditToolCallId: ctx.toolCallId } : {}),
    });

    if (result.kind === 'unknown') {
      const scopeQual = scopeCheck !== null ? ` in scope ${scopeCheck}` : '';
      return toolError(
        'memory.not_found',
        `no memory named ${JSON.stringify(args.name)} found${scopeQual}`,
        {
          hint: 'Call memory_list to see available memories.',
        },
      );
    }
    if (result.kind === 'missing') {
      return toolError(
        'memory.body_missing',
        `memory ${JSON.stringify(args.name)} is indexed in scope ${result.scope} but the body file is missing on disk`,
        {
          hint: 'The operator may have deleted the file without updating the index. Surface via /memory list to inspect.',
        },
      );
    }
    if (result.kind === 'malformed') {
      return toolError(
        'memory.malformed',
        `memory ${JSON.stringify(args.name)} failed to parse: ${result.error}`,
        {
          details: { scope: result.scope },
        },
      );
    }

    const fm = result.file.frontmatter;
    const out: MemoryReadOutput = {
      scope: result.scope,
      name: fm.name,
      description: fm.description,
      type: fm.type,
      source: fm.source,
      body: result.file.body,
    };
    // Spread optional fields only when present so the model output
    // matches the on-disk frontmatter (absent ≠ default).
    if (fm.expires !== undefined) out.expires = fm.expires;
    if (fm.trust !== undefined) out.trust = fm.trust;
    if (fm.triggers !== undefined) out.triggers = fm.triggers;

    // Spec §7.2.7: surface `[memory: untrusted]` in the UI when an
    // untrusted body lands in context. The model already sees the
    // marker via `out.trust` in the JSON envelope; the warn emission
    // gives the operator a visible cue in the live region. Without
    // it, an operator monitoring a running session might miss that
    // a hand-marked-untrusted memory was just loaded — silent
    // injection vector. emitWarn is optional on ToolContext so
    // headless / SDK callers without an event sink no-op cleanly;
    // production paths (REPL, one-shot via run.ts) wire it via the
    // harness loop so the warn always reaches the renderer.
    if (fm.trust === 'untrusted' && ctx.emitWarn !== undefined) {
      ctx.emitWarn(
        `[memory: untrusted] loaded ${result.scope}/${fm.name} — body kept out of base context, treat its claims with extra scrutiny`,
      );
    }

    return out;
  },
};
