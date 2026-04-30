import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';

// `task` invokes a subagent (spec §11). The model passes a subagent
// name (resolved against the harness-level registry) and a prompt;
// the harness spawns a child harness with that subagent's restricted
// toolset and budget, runs it to completion, and returns the
// envelope. Intermediate steps the child took stay invisible to the
// parent — the spec is explicit about that boundary, and the
// envelope contains audit pointers (session_id, cost, steps, status)
// for downstream tooling that wants the full trail.

export interface TaskInput {
  // Name of the subagent to spawn. Must match a kebab-case name
  // discovered in either ~/.config/agent/agents/ (user scope) or
  // <cwd>/.agent/agents/ (project scope; shadows user on collision).
  subagent: string;
  // Initial user prompt for the child run. The child sees only this
  // — no parent history is leaked.
  prompt: string;
}

export interface TaskOutput {
  // The child's terminal assistant text. Empty when the child
  // exited before producing a final non-tool turn.
  output: string;
  // Audit pointers. session_id resolves via --list-sessions
  // --include-subagents; status/reason mirror the child's
  // HarnessResult.
  session_id: string;
  status: 'done' | 'interrupted' | 'exhausted' | 'error';
  reason: string;
  cost_usd: number;
  steps: number;
  duration_ms: number;
  // Present only when the child's audit snapshot failed to
  // persist. The run's outcome above is still authoritative —
  // this is an advisory so the parent / operator know the
  // forensic record is missing.
  audit_failure?: { code: string; message: string };
}

// Cap on the prompt the parent forwards to the child. 32 KiB is
// generous for "self-contained instruction" use (PLAYBOOKS.md §1
// recommends one focused goal per spawn) while bounding the token
// cost of a misbehaving caller dumping a transcript. Surfaces both
// the limit and the observed size on the error envelope so the
// model can react without a guess-and-check retry.
const PROMPT_MAX_BYTES = 32 * 1024;

export const taskTool: Tool<TaskInput, TaskOutput> = {
  name: 'task',
  description:
    'Spawn a named subagent in an isolated context with its own toolset, budget, and system prompt. You receive only the structured output, never the intermediate steps. Use when the subtask has clear scope and benefits from fresh context. The `prompt` must be self-contained — the child has no view of this conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      subagent: {
        type: 'string',
        description:
          'Name of the subagent to spawn (e.g., "explore", "review"). Must be kebab-case and match a discoverable definition.',
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained user prompt for the child. Include all context the subagent needs — it has no view of this conversation.',
      },
    },
    required: ['subagent', 'prompt'],
  },
  metadata: {
    // Subagents are gated as their own permission category — the
    // `subagent` policy section can lock which agents are spawnable
    // and from which scopes. Step 4.1 wires the route as `misc` so
    // we don't introduce a new policy section before its rules are
    // designed; the engine still gates per the `misc` defaults.
    // Migration to a dedicated `subagent` category lands when the
    // permission shape is specified (later).
    category: 'misc',
    // The tool itself does not write to the working tree. Whether
    // the CHILD writes is the child's tool surface concern — its
    // own `writes:true` tools trip the child's checkpoint logic
    // (off in 4.1; revisited in 4.2 with worktree).
    writes: false,
    idempotent: false,
    // Plan mode: blocked. A subagent with write tools could end-
    // run plan mode by mutating files inside the child loop.
    // Plan mode is supposed to be globally read-only, so we refuse
    // task() entirely. The child harness DOES inherit plan mode
    // separately when applicable, but the simplest correct rule is
    // "no spawning during plan".
    planSafe: false,
    display: 'raw',
  },
  async execute(args, ctx): Promise<ToolResult<TaskOutput>> {
    if (ctx.signal.aborted) {
      return toolError(ERROR_CODES.aborted, 'tool aborted before spawning subagent', {
        retryable: true,
      });
    }
    if (ctx.spawnSubagent === undefined) {
      // The harness was constructed without a subagent registry
      // (programmatic caller, M1/M2 entry, or a future eval that
      // chose not to load definitions). Surface as a clean error
      // so the model can recover via plain tools instead of
      // throwing inside the harness path.
      return toolError(
        'subagent.unavailable',
        'subagents are not available in this run (no registry wired)',
        {
          hint: 'The harness was built without subagentRegistry. Define agents under ~/.config/agent/agents/ or <cwd>/.agent/agents/ and bootstrap will pick them up.',
        },
      );
    }

    if (typeof args.subagent !== 'string' || args.subagent.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "'subagent' must be a non-empty string");
    }
    if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
      return toolError(ERROR_CODES.invalidArg, "'prompt' must be a non-empty string");
    }
    const promptBytes = Buffer.byteLength(args.prompt, 'utf8');
    if (promptBytes > PROMPT_MAX_BYTES) {
      return toolError(
        ERROR_CODES.invalidArg,
        `'prompt' exceeds ${PROMPT_MAX_BYTES} bytes (got ${promptBytes})`,
        {
          hint: 'Subagent prompts should be self-contained instructions, not entire transcripts. Trim to the essentials.',
          details: { byte_limit: PROMPT_MAX_BYTES, byte_count: promptBytes },
        },
      );
    }

    const result = await ctx.spawnSubagent({
      name: args.subagent,
      prompt: args.prompt,
    });
    if (result.kind === 'unknown_subagent') {
      return toolError('subagent.unknown', `subagent '${result.requested}' not found`, {
        hint:
          result.available.length > 0
            ? `Known subagents: ${result.available.join(', ')}.`
            : 'No subagents are defined. Add a .md file under ~/.config/agent/agents/ or <cwd>/.agent/agents/.',
        details: { available: result.available },
      });
    }
    if (result.kind === 'depth_exceeded') {
      return toolError(
        'subagent.depth_exceeded',
        `subagent '${result.requested}' would nest at depth ${result.depth} (max ${result.maxDepth})`,
        {
          hint: 'Stop nesting task() calls. Either finish the work directly in this turn or restructure into a flatter chain.',
          details: { depth: result.depth, max_depth: result.maxDepth },
        },
      );
    }

    // Map non-`done` exits to tool errors. The model should know
    // when a child run exhausted its budget vs cleanly finished —
    // the envelope IS the tool result on `done`, and a tool error
    // (with the same envelope echoed in details) on anything else.
    // Audit failure is preserved on this branch too: when the run
    // failed AND the snapshot insert failed, both signals matter
    // — operators investigating the failure can't recover the
    // forensic record either, so the missing snapshot is exactly
    // what the user needs to see flagged.
    if (result.status !== 'done') {
      const detail = `subagent '${args.subagent}' exited with status='${result.status}', reason='${result.reason}'`;
      return toolError('subagent.run_failed', detail, {
        retryable: result.status === 'exhausted',
        details: {
          subagent: args.subagent,
          session_id: result.sessionId,
          status: result.status,
          reason: result.reason,
          cost_usd: result.costUsd,
          steps: result.steps,
          duration_ms: result.durationMs,
          output: result.output,
          ...(result.auditFailure !== undefined ? { audit_failure: result.auditFailure } : {}),
        },
      });
    }

    return {
      output: result.output,
      session_id: result.sessionId,
      status: result.status,
      reason: result.reason,
      cost_usd: result.costUsd,
      steps: result.steps,
      duration_ms: result.durationMs,
      ...(result.auditFailure !== undefined ? { audit_failure: result.auditFailure } : {}),
    };
  },
};
