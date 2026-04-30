import type { HarnessConfig, HarnessEvent, HarnessResult } from '../harness/index.ts';
import { runAgent } from '../harness/index.ts';
import type { PermissionEngine } from '../permissions/index.ts';
import type { Provider } from '../providers/index.ts';
import { type DB, insertSubagentRun, insertSubagentWorktree } from '../storage/index.ts';
import { type Tool, type ToolRegistry, createToolRegistry } from '../tools/index.ts';
import type { SubagentSet } from './load.ts';
import type { SubagentDefinition } from './types.ts';
import {
  type CleanupResult,
  type WorktreeHandle,
  cleanupWorktree,
  createWorktree,
} from './worktree.ts';

// Filter the parent's registry down to a child registry containing
// only the whitelisted tools, in the order the definition declared
// them. We refuse the call when a tool name in the whitelist isn't
// registered with the parent (likely a typo — silent omission would
// produce a child that runs without the tool the author asked for
// and the model would have no way to know) AND when a tool declares
// `metadata.writes=true` UNLESS the definition opts into
// `isolation: worktree`. The capability gate is registry-driven
// rather than a hard-coded name list — any newly-registered tool
// that opts into `writes: true` inherits the refusal automatically;
// worktree isolation lifts the refusal because the child's writes
// land in a dedicated branch+tree the parent can inspect, merge,
// or discard without touching its own working tree.
//
// Bootstrap pre-validates the same rule against the loaded
// registry via `validateSubagentSet`; this runtime check is
// defense in depth for programmatic callers (evals, future
// tooling) that build configs without going through bootstrap.
const buildChildRegistry = (
  parent: ToolRegistry,
  whitelist: readonly string[],
  subagentName: string,
  allowWrites: boolean,
): ToolRegistry => {
  const child = createToolRegistry();
  const seen = new Set<string>();
  for (const toolName of whitelist) {
    if (seen.has(toolName)) {
      // Loader pulls this forward to bootstrap-time with an
      // index-aware message (`tools[]` lists 'echo' twice at
      // index 0 and index 2). This runtime check stays as
      // defense in depth for programmatic callers that build
      // `SubagentDefinition` objects directly. Without it, the
      // raw `register()` call below would still throw, but with
      // a less-specific "tool X already registered" message.
      throw new Error(`subagent '${subagentName}': tool '${toolName}' listed twice in tools[]`);
    }
    seen.add(toolName);
    const tool = parent.get(toolName);
    if (tool === null) {
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' not registered with parent harness`,
      );
    }
    if (tool.metadata.writes === true && !allowWrites) {
      throw new Error(
        `subagent '${subagentName}': tool '${toolName}' declares metadata.writes=true and cannot appear in subagent.tools[] without 'isolation: worktree'. Bootstrap should have caught this; if you see it at runtime you're constructing the child registry without going through validateSubagentSet first.`,
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
  // Override for the worktree storage root. Tests pass a tmpdir
  // so the runtime doesn't pollute the user's real
  // `$XDG_CACHE_HOME/agent/worktrees`. Production callers omit
  // it and inherit `defaultWorktreeRoot()`.
  worktreeRootDir?: string;
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
  // Either an `ExitReason` from the harness (when the child run
  // actually started) or a subagent-runtime reason for pre-run
  // failures the harness never sees, e.g. `worktree_create_failed`
  // when `git worktree add` itself errors before any session is
  // created. The calling tool surfaces the string verbatim — the
  // model reads it for diagnostics, not for a switch.
  reason: HarnessResult['reason'] | 'worktree_create_failed';
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
  // Set when the post-run audit snapshot insert failed. Audit is
  // best-effort — a failure here does NOT change the run's outcome
  // — but losing the snapshot silently violates the "measure twice"
  // principle, so we surface the error to the caller. The `task`
  // tool echoes this in its tool-result envelope so the parent
  // model and the CLI can flag it; tests assert the field is
  // present when storage is broken. Absent on the success path.
  auditFailure?: { code: string; message: string };
  // Worktree lifecycle outcome when the definition declared
  // `isolation: worktree`. `dirty=true` means the child made
  // changes (tracked or untracked diff after the run); the
  // worktree is preserved on disk for the parent to inspect via
  // `path` / `branch`. `dirty=false` and `removed=true` means the
  // child made no changes — both the worktree and the throwaway
  // branch were dropped. Absent for definitions with
  // `isolation: none`. Mutually exclusive with `worktreeError`.
  worktree?: {
    path: string;
    branch: string;
    dirty: boolean;
    preserved: boolean;
    removed: boolean;
  };
  // Set when `git worktree add` itself failed before the child
  // run could start. The result also carries `status='error'` and
  // `reason='worktree_create_failed'` so non-`done` mapping in the
  // calling tool catches it via the existing run-failed branch.
  // Mutually exclusive with `worktree` because the run never
  // happened.
  worktreeError?: { code: string; message: string };
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
//
// When the definition declares `isolation: worktree`, the runtime
// creates a dedicated git worktree before invoking the harness and
// runs cleanup after. A failure during worktree creation is NOT a
// programmer error — it's a runtime state the child could legitimately
// hit (disk full, permission denied, orphan path collision) — so it
// resolves to a result with `status='error'`, `reason='worktree_
// create_failed'` rather than throwing.
export const runSubagent = async (input: RunSubagentInput): Promise<RunSubagentResult> => {
  const { definition } = input;
  const depth = input.depth ?? 0;
  if (depth > MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `subagent '${definition.name}': recursion depth ${depth} would exceed MAX_SUBAGENT_DEPTH=${MAX_SUBAGENT_DEPTH}`,
    );
  }
  const isolation = definition.isolation;
  const childRegistry = buildChildRegistry(
    input.parentToolRegistry,
    definition.tools,
    definition.name,
    isolation === 'worktree',
  );

  // Worktree creation precedes session creation (which happens
  // inside runAgent). We use a fresh UUID for the worktree
  // directory and branch suffix — independent of the eventual
  // child session id. The audit row written after the run
  // captures the session_id ↔ (path, branch) link, so operators
  // never need to reverse-engineer one from the other.
  let worktreeHandle: WorktreeHandle | undefined;
  let worktreeError: { code: string; message: string } | undefined;
  if (isolation === 'worktree') {
    const worktreeId = crypto.randomUUID();
    try {
      worktreeHandle = await createWorktree({
        sessionId: worktreeId,
        prompt: input.prompt,
        parentCwd: input.cwd,
        ...(input.worktreeRootDir !== undefined ? { rootDir: input.worktreeRootDir } : {}),
      });
    } catch (e) {
      worktreeError = {
        code: 'worktree_create_failed',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // Worktree-create failure short-circuits the run: no session is
  // created, no runAgent call happens, the result reflects the
  // pre-run failure. The calling tool maps non-'done' status to a
  // tool error via its existing `subagent.run_failed` branch, so
  // the model sees a clean recoverable error.
  if (worktreeError !== undefined) {
    return {
      output: '',
      sessionId: '',
      status: 'error',
      reason: 'worktree_create_failed',
      costUsd: 0,
      steps: 0,
      durationMs: 0,
      worktreeError,
    };
  }

  // The child's cwd is the worktree root when isolated; otherwise
  // it inherits the parent's cwd. Every tool call inside the child
  // resolves relative paths against this — write_file lands in the
  // worktree, bash runs in the worktree.
  const childCwd = worktreeHandle?.path ?? input.cwd;

  const childConfig: HarnessConfig = {
    provider: input.provider,
    toolRegistry: childRegistry,
    // Persist the ROOT registry through the chain so the child's
    // own spawn closure can validate grandchildren against the
    // full toolset, not against the child's own narrowed view.
    // `input.parentToolRegistry` IS the root (the caller resolved
    // it from `config.rootToolRegistry ?? config.toolRegistry`
    // before passing it in).
    rootToolRegistry: input.parentToolRegistry,
    permissionEngine: input.permissionEngine,
    db: input.db,
    cwd: childCwd,
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
  // Audit snapshot of the definition under which this child ran
  // (migration 012). Captured AFTER runAgent because the snapshot
  // FK targets sessions.id and the row is created inside the
  // harness loop — runAgent always returns HarnessResult (top-
  // level catch in the loop is exhaustive), so the only path
  // where we have no sessionId is one where createSession itself
  // failed and there is nothing to audit anyway.
  //
  // The snapshot fingerprints what the child was EXECUTING under,
  // not what the .md file currently looks like. An author editing
  // `~/.config/agent/agents/explore.md` after this run leaves the
  // snapshot intact — every future "explain past behavior" query
  // resolves against this row, not against on-disk state that may
  // have drifted.
  //
  // Best-effort insert: a corrupted audit table (schema drift on
  // a stale DB, FK violation, disk-full) must NOT mask the run's
  // outcome. The session is already finalized; throwing here
  // would surface as `internalError` and hide the actual exit
  // reason from the parent. Instead, capture the error onto the
  // result so the calling tool can echo it in its envelope —
  // makes audit-failure visible without rewriting the success
  // path.
  let auditFailure: { code: string; message: string } | undefined;
  if (result.sessionId.length > 0) {
    try {
      insertSubagentRun(input.db, {
        sessionId: result.sessionId,
        name: definition.name,
        scope: definition.scope,
        sourcePath: definition.sourcePath,
        sourceSha256: definition.sourceSha256,
        systemPrompt: definition.systemPrompt,
        toolsWhitelist: definition.tools,
        budgetMaxSteps: definition.budget.maxSteps,
        budgetMaxCostUsd: definition.budget.maxCostUsd,
        ...(definition.budget.maxWallClockMs !== undefined
          ? { budgetMaxWallMs: definition.budget.maxWallClockMs }
          : {}),
      });
    } catch (e) {
      auditFailure = {
        code: 'snapshot_insert_failed',
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
  // Worktree cleanup runs after runAgent so a clean child run
  // doesn't leave a stub branch + tree behind, and a child that
  // wrote can be inspected by the parent. Cleanup never throws —
  // any internal failure (git missing, FS-level lock) leaves the
  // worktree on disk and surfaces via `dirty=true, preserved=true`,
  // which the caller can interpret as "investigate".
  let cleanup: CleanupResult | undefined;
  if (worktreeHandle !== undefined) {
    cleanup = await cleanupWorktree({
      handle: worktreeHandle,
      parentCwd: input.cwd,
    });
    // Audit row for the worktree (migration 013). Best-effort: a
    // corrupted audit table must not mask the run's outcome — same
    // contract as the subagent_runs insert above. Failures here
    // are absorbed into auditFailure if it isn't already set
    // (subagent_runs insert wins the slot when both fail).
    if (result.sessionId.length > 0) {
      try {
        insertSubagentWorktree(input.db, {
          sessionId: result.sessionId,
          path: worktreeHandle.path,
          branch: worktreeHandle.branch,
          status: cleanup.removed ? 'cleaned' : 'preserved',
        });
      } catch (e) {
        if (auditFailure === undefined) {
          auditFailure = {
            code: 'worktree_audit_insert_failed',
            message: e instanceof Error ? e.message : String(e),
          };
        }
      }
    }
  }

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
    ...(auditFailure !== undefined ? { auditFailure } : {}),
    ...(worktreeHandle !== undefined && cleanup !== undefined
      ? {
          worktree: {
            path: worktreeHandle.path,
            branch: worktreeHandle.branch,
            dirty: cleanup.dirty,
            preserved: cleanup.preserved,
            removed: cleanup.removed,
          },
        }
      : {}),
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
  reason: HarnessResult['reason'] | 'worktree_create_failed';
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
