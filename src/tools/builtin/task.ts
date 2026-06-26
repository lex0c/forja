import { CAPABILITY_KINDS, parseCapability } from '../../permissions/capabilities.ts';
import type { WorktreeOutcome } from '../../subagents/types.ts';
import { DEFER_BELOW_TOKENS_SMALL } from '../context-budget.ts';
import { ERROR_CODES, type Tool, type ToolResult, toolError } from '../types.ts';
import { childOutputHeadTail, playbookDirsHint, summarizeChildEnvelope } from './task-shared.ts';

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
  // discovered in either ~/.config/forja/playbooks/ (user scope) or
  // <cwd>/.forja/playbooks/ (project scope; shadows user on collision).
  subagent: string;
  // Initial user prompt for the child run. The child sees only this
  // — no parent history is leaked.
  prompt: string;
  // PERMISSION_ENGINE.md §10.1 declared capability set. Each entry
  // is a capability string (kind:scope, e.g. `read-fs:src/**`).
  // The spawn factory intersects this list against the parent's
  // effective capability set; any entry NOT covered by the parent
  // refuses the spawn with `subagent.escalation`.
  //
  // Three cases:
  //   - Omitted (undefined): legacy path, no intersection guard
  //     fires. Subagent runs under the existing toolset gating.
  //   - Empty array: spec §10.1 "subagent receives NO capability"
  //     — pure-LLM run (no fs/network/exec side effects).
  //   - Non-empty array: each entry must parse cleanly AND be
  //     covered by the parent capability snapshot; otherwise the
  //     spawn is refused.
  capabilities?: string[];
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
  // Worktree outcome (spec §11.2). Shape pinned in
  // `WorktreeOutcome`. Present when the subagent declared
  // `isolation: worktree`. The model uses `branch` to decide
  // whether to merge, discard, or open a PR for the child's
  // changes; `dirty=false, removed=true` means there's nothing
  // to merge (clean run, dropped automatically).
  worktree?: WorktreeOutcome;
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
      capabilities: {
        type: 'array',
        items: { type: 'string' },
        description: `Capabilities the child needs (PERMISSION_ENGINE.md §10.1), REQUIRED. Each entry is "kind" or "kind:scope"; kind ∈ [${CAPABILITY_KINDS.join(', ')}]. Only env-mutate, forja-mutate and host-passthrough are scope-less — every other kind REQUIRES a scope (read-fs:<path>, write-fs:<path>, delete-fs:<path>, exec:<shell|python|node|arbitrary>, net-egress:<host>, net-ingress:<port>, secret-access:<store>, git-write:<repo>). For a directory and everything under it the path MUST end in /** (e.g. read-fs:src/** or read-fs:/abs/repo/**); a bare read-fs:/abs/repo matches ONLY that path and covers NO files inside it — the #1 cause of a child denied on every read. The engine intersects declared ∩ parent and refuses the spawn if any capability is outside the parent's set. Pass [] for a pure-LLM child (no side-effect capabilities).`,
      },
    },
    required: ['subagent', 'prompt', 'capabilities'],
  },
  metadata: {
    // Subagents are gated as their own permission category — the
    // `subagent` policy section can lock which agents are spawnable
    // and from which scopes. The route is wired as `misc` so
    // we don't introduce a new policy section before its rules are
    // designed; the engine still gates per the `misc` defaults.
    // Migration to a dedicated `subagent` category lands when the
    // permission shape is specified (later).
    category: 'misc',
    // Window-relative deferral (CONTEXT_TUNING §2.2): subagent orchestration is
    // base on large windows but leaves the surface on a tight one — a small-window
    // model rarely spawns children and can re-acquire via tool_search. (taskSyncTool
    // inherits this via the spread below; it is already `deferred: true`, so no-op.)
    deferBelowTokens: DEFER_BELOW_TOKENS_SMALL,
    // The tool itself does not write to the working tree. Whether
    // the CHILD writes is the child's tool surface concern — its
    // own `writes:true` tools trip the child's checkpoint logic
    // (off in 4.1; revisited in 4.2 with worktree).
    writes: false,
    idempotent: false,
    display: 'raw',
    // Head-tail the child's `output` before it re-enters the parent
    // context (OUTPUT_POLICY §3.1 / §6 exception). Raw stays in the
    // parent's audit row; full text recoverable via session_id.
    // `taskSyncTool` inherits this via the spread below; `task_await`
    // shares the same `summarizeChildEnvelope` helper.
    summarize: summarizeChildEnvelope,
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
          hint: `The harness was built without subagentRegistry. Define agents under ${playbookDirsHint()} and bootstrap will pick them up.`,
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

    // PERMISSION_ENGINE.md §10.1: capabilities is REQUIRED (slice 94).
    // Pre-slice the field was optional, with `undefined → no §10 guard`
    // as a legacy escape — the review identified this as a privilege-
    // escalation-by-omission: model spawning `task('foo', prompt)`
    // without the field would skip intersection entirely and inherit
    // the parent's full policy snapshot. Now: missing field is rejected;
    // operator MUST declare. Two valid shapes:
    //   - []         → "pure-LLM" subagent (no side-effect capabilities)
    //   - [valid…]   → intersection guard at the spawn factory
    if (args.capabilities === undefined) {
      return toolError(
        ERROR_CODES.invalidArg,
        "'capabilities' is required (PERMISSION_ENGINE.md §10.1)",
        {
          hint: "Declare the capabilities the child needs (e.g. ['read-fs:src/**', 'exec:shell']) or pass [] for a pure-LLM subagent with no side-effect capabilities.",
        },
      );
    }
    if (!Array.isArray(args.capabilities)) {
      return toolError(
        ERROR_CODES.invalidArg,
        "'capabilities' must be an array of capability strings",
      );
    }
    for (const entry of args.capabilities) {
      if (typeof entry !== 'string') {
        return toolError(
          ERROR_CODES.invalidArg,
          "'capabilities' entries must be capability strings (e.g. 'read-fs:src/**')",
        );
      }
      try {
        parseCapability(entry);
      } catch (e) {
        return toolError(
          ERROR_CODES.invalidArg,
          `'capabilities' entry '${entry}' is not a valid capability: ${(e as Error).message}`,
        );
      }
    }
    const declaredCapabilities: string[] = args.capabilities;

    const result = await ctx.spawnSubagent({
      name: args.subagent,
      prompt: args.prompt,
      declaredCapabilities,
      // Migration 058: forward the approval id that authorized this
      // tool call so the spawned child's audit row links back to it
      // (PERMISSION_ENGINE.md §10.2). Spread keeps the field absent
      // when ctx.approvalId isn't populated (test contexts that
      // construct ToolContext without invoke-tool).
      ...(ctx.approvalId !== undefined ? { parentApprovalId: ctx.approvalId } : {}),
    });
    // Audit: the synchronous task family hits the dispatcher
    // first (no pre-flight check), so the three refusal kinds
    // arrive HERE rather than inline like in `task_async`.
    // Both `task` and `task_sync` share this execute body, so
    // we attribute every audit row to `'task_sync'` (canonical
    // per spec §3.1). Distinguishing the legacy `task` alias
    // from `task_sync` is recoverable from `messages.tool_uses`
    // if a future audit needs that fidelity.
    if (result.kind === 'unknown_subagent') {
      ctx.recordGateDecision?.({
        decisionType: 'unknown_subagent',
        toolName: 'task_sync',
        requestedName: result.requested,
        details: { available: result.available },
      });
      return toolError('subagent.unknown', `subagent '${result.requested}' not found`, {
        hint:
          result.available.length > 0
            ? `Known subagents: ${result.available.join(', ')}.`
            : `No subagents are defined. Add a .md file under ${playbookDirsHint()}.`,
        details: { available: result.available },
      });
    }
    if (result.kind === 'depth_exceeded') {
      ctx.recordGateDecision?.({
        decisionType: 'depth_exceeded',
        toolName: 'task_sync',
        requestedName: result.requested,
        details: { depth: result.depth, max_depth: result.maxDepth },
      });
      return toolError(
        'subagent.depth_exceeded',
        `subagent '${result.requested}' would nest at depth ${result.depth} (max ${result.maxDepth})`,
        {
          hint: 'Stop nesting task() calls. Either finish the work directly in this turn or restructure into a flatter chain.',
          details: { depth: result.depth, max_depth: result.maxDepth },
        },
      );
    }
    if (result.kind === 'playbook_model_unavailable') {
      return toolError(
        'subagent.playbook_model_unavailable',
        `subagent '${result.requested}' declares model '${result.model}', which is unavailable: ${result.reason}`,
        {
          retryable: false,
          hint: "Fix the playbook's `model` frontmatter (use a catalog id like 'anthropic/claude-opus-4-8'), wire the provider's credential, or omit `model` to inherit the session model.",
          details: { subagent: result.requested, model: result.model, reason: result.reason },
        },
      );
    }
    if (result.kind === 'subagent_escalation') {
      ctx.recordGateDecision?.({
        decisionType: 'subagent_escalation',
        toolName: 'task_sync',
        requestedName: result.requested,
        details: { excess: result.excess },
      });
      return toolError(
        'subagent.escalation',
        `subagent '${result.requested}' requested capabilities beyond the parent's set: ${result.excess.join(', ')}`,
        {
          retryable: false,
          hint: 'Spec §10.1: declared_caps must be a subset of parent_caps. Drop the excess entries from the `capabilities` array, or restructure the work so the subagent runs under the capabilities the parent itself can exercise.',
          details: { subagent: result.requested, excess: result.excess },
        },
      );
    }
    if (result.kind === 'budget_exhausted') {
      ctx.recordGateDecision?.({
        decisionType: 'budget_exhausted',
        toolName: 'task_sync',
        requestedName: result.requested,
        details: {
          spent: result.spent,
          estimate: result.estimate,
          projected: result.projected,
          cap: result.cap,
        },
      });
      return toolError(
        'subagent.budget_exhausted',
        `spawning '${result.requested}' would push projected cost to $${result.projected.toFixed(6)} (cap $${result.cap.toFixed(6)})`,
        {
          retryable: false,
          hint: 'Cumulative parent + child cost would cross the run cap. Finish the work without a new subagent, or wait for in-flight task_async spawns to settle and free their reservations.',
          details: {
            subagent: result.requested,
            spent: result.spent,
            estimate: result.estimate,
            projected: result.projected,
            cap: result.cap,
          },
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
      // Append the child's diagnostic `detail` when the runtime
      // forwarded one (e.g. provider error message, tool budget
      // breakdown). Without it the model — and the operator's
      // TUI chip via invoke-tool's `errorMessage` plumbing —
      // only see the categorical `reason` code.
      const causeSuffix =
        result.detail !== undefined && result.detail.length > 0 ? `: ${result.detail}` : '';
      const detail = `subagent '${args.subagent}' exited with status='${result.status}', reason='${result.reason}'${causeSuffix}`;
      // Head-tail the child's partial output here: the error path
      // returns a ToolError, which the harness routes around
      // `metadata.summarize` (OUTPUT_POLICY §0.4). Without this trim a
      // failed-but-verbose child (exhausted / maxSteps with a long
      // transcript) would dump its full output into `details.output`
      // uncapped — the same context weight the success path now caps.
      // The marker headTailSummary inserts signals the elision; the
      // full text stays recoverable via `session_id`.
      const errorOutput = childOutputHeadTail(result.output).text;
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
          output: errorOutput,
          ...(result.auditFailure !== undefined ? { audit_failure: result.auditFailure } : {}),
          ...(result.worktree !== undefined ? { worktree: result.worktree } : {}),
          ...(result.worktreeError !== undefined ? { worktree_error: result.worktreeError } : {}),
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
      ...(result.worktree !== undefined ? { worktree: result.worktree } : {}),
    };
  },
};

// `task_sync` is the canonical name in spec §3.1; `task` is kept
// as the legacy alias because models discovering tools by name
// already expect it. The two are byte-identical at the wire — same
// inputSchema, same metadata, same execute. Spawn-side audit rows
// carry whichever name the model invoked. Spec ORCHESTRATION.md
// §3.1: "task (alias legado) = task_sync".
export const taskSyncTool: Tool<TaskInput, TaskOutput> = {
  ...taskTool,
  // Deferred (AGENTIC_CLI §7.6): a legacy alias of the visible `task` — no need
  // to spend base-surface room on both. Override metadata so `task` stays
  // visible while `task_sync` is reached via tool_search.
  metadata: { ...taskTool.metadata, deferred: true },
  name: 'task_sync',
  description:
    'Synchronous spawn of a subagent. Pairs with `task_async` / `task_await` / `task_cancel`. Identical to the legacy `task` tool — both names are wired to the same dispatcher. The `prompt` must be self-contained: the child has no view of this conversation.',
};
