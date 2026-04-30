import type { HarnessConfig, HarnessEvent, HarnessResult } from '../harness/index.ts';
import { runAgent } from '../harness/index.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider } from '../providers/index.ts';
import type { DB } from '../storage/index.ts';
import { type Tool, type ToolRegistry, createToolRegistry } from '../tools/index.ts';
import type { SubagentSet } from './load.ts';
import type { SubagentDefinition } from './types.ts';

// Filter the parent's registry down to a child registry containing
// only the whitelisted tools, in the order the definition declared
// them. We refuse the call if a tool name in the whitelist isn't
// registered with the parent (likely a typo) — silent omission would
// produce a child that runs without the tool the author asked for and
// the model would have no way to know.
const buildChildRegistry = (
  parent: ToolRegistry,
  whitelist: readonly string[],
  subagentName: string,
): ToolRegistry => {
  const child = createToolRegistry();
  const seen = new Set<string>();
  for (const toolName of whitelist) {
    if (seen.has(toolName)) {
      throw new Error(`subagent '${subagentName}': tool '${toolName}' listed twice in tools[]`);
    }
    seen.add(toolName);
    const tool = parent.get(toolName);
    if (tool === null) {
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' not registered with parent harness`,
      );
    }
    child.register(tool as Tool);
  }
  return child;
};

export interface RunSubagentInput {
  // Definition loaded from `.md` (loadSubagents/loadSubagentFromFile).
  definition: SubagentDefinition;
  // The user-message prompt the parent passes in. This is what the
  // child sees as its initial user turn — the definition's body is
  // the system prompt.
  prompt: string;
  // The parent's session id. Persisted on the child via
  // sessions.parent_session_id so audit (and future cost rollup)
  // can traverse the tree.
  parentSessionId: string;
  // The active deps the parent already wired. Reusing the same
  // provider keeps API key handling out of the runtime; reusing
  // the same DB keeps the child's audit trail in the parent's
  // database; the permission engine continues to gate every tool
  // call the child makes (the toolset is narrowed, but each call
  // still passes through the same policy).
  provider: Provider;
  parentToolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  db: DB;
  cwd: string;
  // Optional caller-supplied abort signal (typically the parent
  // harness's combined signal). The child harness builds its own
  // wall-clock timer on top of this.
  signal?: AbortSignal;
  // Lifecycle observer for the child run. The parent harness's
  // own onEvent stays untouched — the spec is explicit (§11):
  // the parent does not see the child's intermediate steps.
  // Renderers that want a "subagent X ran" trace can wire this.
  onEvent?: (event: HarnessEvent) => void;
  // Sampling temperature override. Falls through to the harness;
  // unset = use the provider default. Playbook-defined sampling
  // (PLAYBOOKS.md §1.1) ships in a later slice.
  temperature?: number;
  // Forward the same subagent set into the child harness so the
  // child's `task` tool can spawn further subagents. Recursion
  // depth is bounded by per-child budgets and an explicit MAX_DEPTH
  // cap (see `depth` below). Optional; absent = child has no
  // `spawnSubagent` and any `task` invocation by the child surfaces
  // a tool error.
  subagentRegistry?: SubagentSet;
  // Plan mode propagation. When the parent harness is in plan mode,
  // children inherit it so a write tool the child has whitelisted
  // (e.g., `write_file`) is still blocked at the harness layer
  // inside the child loop. Without this forward, the `task` tool
  // would block at the parent's gate (defense in depth) but a
  // hypothetical bypass — programmatic caller, future tool that
  // opts back in — would let mutations through under `--plan`.
  // Setting it here closes the second layer.
  planMode?: boolean;
  // Recursion depth of THIS spawn relative to the top-level run.
  // 0 = direct child of the user's session, 1 = grandchild, etc.
  // The runtime refuses to spawn beyond MAX_DEPTH so a misbehaving
  // (or adversarial) definition can't fan out an arbitrarily deep
  // tree; the existing budget caps eventually fire but consume
  // provider calls in the meantime.
  depth?: number;
}

export interface RunSubagentResult {
  // The text the child emitted on its terminal assistant turn —
  // the structured "answer" the parent gets back. Empty string
  // when the child exhausted budget or aborted before producing
  // a final non-tool turn.
  output: string;
  // The child's final session row id. Surfaced so callers can
  // cross-reference --list-sessions and replay the child without
  // the parent having to walk parent_session_id queries.
  sessionId: string;
  // Mirrors HarnessResult — used for the tool-result envelope so
  // the parent model sees how the child finished (`done`,
  // `exhausted`, `error`). 'done' is the only success path; any
  // other status becomes a tool error in the calling tool.
  status: HarnessResult['status'];
  reason: HarnessResult['reason'];
  // Cost the child incurred (per-run total). NOT rolled into the
  // parent's totalCostUsd at write time — that double-counts on
  // resume and complicates the budget contract. The parent's
  // session row stays self-only; cumulative cost across a session
  // family is a query-time derivation (see CLI hierarchy listing).
  costUsd: number;
  // Steps the child took. Surfaces as part of the audit envelope
  // for renderers that show "subagent X used N/M steps".
  steps: number;
  durationMs: number;
}

// Hard cap on how deep a chain of `task → task → task` can nest.
// Per-child `maxSteps` and parent wall-clock eventually contain a
// runaway tree, but they consume provider calls in the meantime.
// Four levels covers every plausible playbook composition (the
// canonical one is parent → review-playbook, never deeper) and
// surfaces a clear error well before the budget caps would.
//
// Depth semantics: `depth` is how deep THIS spawn lives. depth=1
// is the first child of the user's session, depth=4 is the
// fourth-level descendant. A spawn whose depth would EXCEED the
// cap is rejected; equality is allowed. The loop's spawn closure
// MUST mirror this `>` boundary so it can return the recoverable
// `depth_exceeded` variant before the runtime's contract throw
// fires — without that alignment, a chain at the exact boundary
// surfaces as a generic `tool.exception`.
export const MAX_SUBAGENT_DEPTH = 4;

// Spawn a subagent in-process. Builds a fresh HarnessConfig with the
// child's restricted toolset, own budget, own system prompt, and
// no parent history (a new session id is always created — resume is
// not supported for subagents). The function never throws on a child-
// side failure; it returns a result object whose status/reason carry
// the exit. Programmer errors (typo in whitelist, missing tools,
// parent session id missing, recursion depth exceeded) throw — those
// are caller bugs, not subagent runtime states.
export const runSubagent = async (input: RunSubagentInput): Promise<RunSubagentResult> => {
  const { definition } = input;
  const depth = input.depth ?? 0;
  if (depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `subagent '${definition.name}': recursion depth ${depth} would exceed MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}`,
    );
  }
  const childRegistry = buildChildRegistry(
    input.parentToolRegistry,
    definition.tools,
    definition.name,
  );

  const childConfig: HarnessConfig = {
    provider: input.provider,
    toolRegistry: childRegistry,
    permissionEngine: input.permissionEngine,
    db: input.db,
    cwd: input.cwd,
    systemPrompt: definition.systemPrompt,
    userPrompt: input.prompt,
    parentSessionId: input.parentSessionId,
    // Child gets its own budget. The harness merges with DEFAULT_BUDGET,
    // so unspecified fields (output cap, compaction threshold, etc.)
    // inherit the harness defaults — only the caps the definition
    // explicitly sets are tightened. maxCostUsd MUST be forwarded;
    // the loader requires it on every definition, dropping it here
    // would let a writing subagent run past its declared spend cap
    // until another budget tripped.
    budget: {
      maxSteps: definition.budget.maxSteps,
      maxCostUsd: definition.budget.maxCostUsd,
      ...(definition.budget.maxWallClockMs !== undefined
        ? { maxWallClockMs: definition.budget.maxWallClockMs }
        : {}),
    },
    // Checkpoints OFF for in-process subagents. Spec §11.2 puts
    // writing subagents behind worktree isolation (Step 4.2); a
    // child that writes in the parent's tree without a separate
    // checkpoint chain risks confusing `--undo` semantics (the
    // parent's chain wouldn't include the child's writes; the
    // child's chain wouldn't be discoverable from the parent's
    // session id). Read-only subagents (the dominant case) lose
    // nothing — they don't write. Writing subagents will get
    // worktree isolation in Step 4.2 and re-enable checkpoints
    // there.
    enableCheckpoints: false,
    subagentDepth: depth,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.onEvent !== undefined ? { onEvent: input.onEvent } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.subagentRegistry !== undefined ? { subagentRegistry: input.subagentRegistry } : {}),
    ...(input.planMode === true ? { planMode: true } : {}),
  };

  // bgLogDir omitted: subagents in Step 4.1 don't get bg tools
  // unless they declare them in `tools` AND the parent registry
  // has them. We honor the whitelist regardless, but without a
  // bgLogDir the bg tools surface a clean error if invoked. That's
  // intentional — bg processes from a child running in the
  // parent's tree would mix with the parent's bg processes in the
  // same log directory and the same `bg list` output. Worktree
  // isolation (Step 4.2) is the right place to give children
  // their own bg dir.

  const result = await runAgent(childConfig);
  // The terminal assistant text is the structured output. The harness
  // already persisted it; we reconstruct here from result.lastMessageId
  // when available, falling back to detail for early-exit paths.
  const output = await extractFinalOutput(input.db, result);
  return {
    output,
    sessionId: result.sessionId,
    status: result.status,
    reason: result.reason,
    costUsd: result.costUsd,
    steps: result.steps,
    durationMs: result.durationMs,
  };
};

// Pull the child's final assistant message. The harness only returns
// lastMessageId, not its content — we read directly from storage to
// avoid threading another field through HarnessResult just for this.
// Empty string when there's nothing to return (no assistant turn
// completed before exit).
const extractFinalOutput = async (db: DB, result: HarnessResult): Promise<string> => {
  // HarnessResult.lastMessageId is typed `string | undefined` but
  // the loop seeds it to '' and only ever assigns a real id; checking
  // length here is cheaper and more honest than the undefined guard.
  if (result.lastMessageId === undefined || result.lastMessageId.length === 0) return '';
  const row = db
    .query<{ role: string; content: string }, [string]>(
      'SELECT role, content FROM messages WHERE id = ? LIMIT 1',
    )
    .get(result.lastMessageId);
  if (row === null) return '';
  if (row.role !== 'assistant') {
    // Last message wasn't an assistant turn — the run ended on a
    // tool result or user prompt (extreme: aborted before any
    // assistant turn). Caller's tool will surface the status/reason
    // via the envelope; the output field stays empty.
    return '';
  }
  // Content is JSON-serialized when there were tool_use blocks; for
  // pure-text turns it's the raw string. We extract text content
  // either way and ignore tool_use blocks (subagents that ended on
  // a tool_use means the loop hit budget mid-step — the model
  // hadn't finished reasoning, so there's no clean output).
  // Catch parse errors so a malformed row doesn't crash the parent.
  try {
    const parsed = JSON.parse(row.content) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const block of parsed) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          parts.push((block as { text: string }).text);
        }
      }
      return parts.join('').trim();
    }
    return '';
  } catch {
    // Stored as a non-JSON literal — that's the case for empty/text-
    // only turns the harness writes as a bare string. Use as-is.
    return typeof row.content === 'string' ? row.content : '';
  }
};

// Surface the spec'd "structured" envelope back to the parent's tool
// invocation. The parent sees a JSON-serializable object whose
// `output` is the child's terminal text and whose audit fields
// (sessionId, cost, steps, status) let the model and downstream
// tooling reason about how the child finished. Used by the `task`
// tool — kept here so the runtime owns the envelope shape.
export interface SubagentEnvelope {
  output: string;
  session_id: string;
  status: HarnessResult['status'];
  reason: HarnessResult['reason'];
  cost_usd: number;
  steps: number;
  duration_ms: number;
}

export const toEnvelope = (result: RunSubagentResult): SubagentEnvelope => ({
  output: result.output,
  session_id: result.sessionId,
  status: result.status,
  reason: result.reason,
  cost_usd: result.costUsd,
  steps: result.steps,
  duration_ms: result.durationMs,
});
