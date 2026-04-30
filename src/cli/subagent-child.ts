import { type HarnessResult, runAgent } from '../harness/index.ts';
import { createPermissionEngine } from '../permissions/index.ts';
import { type Provider, createDefaultRegistry } from '../providers/index.ts';
import {
  type DB,
  completeSession,
  defaultDbPath,
  getMessage,
  getSession,
  getSubagentRun,
  insertSubagentOutput,
  migrate,
  openDb,
  setSubagentPayload,
} from '../storage/index.ts';
import { loadSubagents, validateSubagentSet } from '../subagents/index.ts';
import { createToolRegistry, registerBuiltinTools } from '../tools/index.ts';

// M3 / Step 4.2b.ii.a — subagent-child entry path.
//
// The parent invokes the same binary with `--subagent-session-id
// <uuid>` to spawn an isolated child process. This module is that
// child's main: it reads the session row + audit row the parent
// pre-created, builds a HarnessConfig with `preassignedSessionId`,
// runs the harness loop, and publishes the terminal envelope to
// `subagent_outputs` via `setSubagentPayload`. The parent polls
// the table and converts the payload back into a
// `RunSubagentResult` for its own `task` tool.
//
// Why a separate file instead of branching inside `cli/run.ts`:
//   - The child's bootstrap is fundamentally different from the
//     parent's (no prompt → no instruction parsing, no
//     subagent registry → can't recursively spawn under the
//     same wiring, no plan-mode prompt composition, no
//     renderer / event observer — output flows through SQLite).
//   - Failures in the parent path must NOT touch this code;
//     same shape, the reverse.
//
// Failure handling philosophy:
//   - Every code path that can fail BEFORE the harness loop
//     publishes a `setSubagentPayload({ status: 'error',
//     reason: '<diagnostic>' })` if the row exists. The parent
//     reads the payload and converts it to a tool error; without
//     this, the parent would see "no payload yet" until its own
//     timeout fires.
//   - Failures AFTER the harness loop also publish — the loop's
//     own error result becomes the payload directly.
//   - If the row doesn't exist (caller bug, no FK target), we
//     can't publish; print to stderr and exit non-zero so the
//     parent's spawn.exited promise resolves with a meaningful
//     code.

export interface SubagentChildOptions {
  sessionId: string;
  // Test seam: skip provider registry lookup. Production callers
  // pass nothing — the registry resolves from sessions.model.
  providerOverride?: Provider;
  // Test seam: override the DB path. Production uses
  // defaultDbPath() so child + parent target the same file.
  dbPath?: string;
  // Test seam: drop a non-empty stderr write through this sink
  // instead of process.stderr. Tests collect the diagnostic
  // strings; production writes to the real stderr.
  errSink?: (s: string) => void;
  // Note: NO `enterprisePolicyPath` / `userPolicyPath` test
  // seams. Migration 015 moved policy resolution to the parent;
  // the child reads the snapshot off `subagent_runs`. Tests
  // that want a specific policy seed it via the parent's
  // `insertSubagentRun(..., policySnapshot: ...)` call.
  //
  // Test seams for subagent discovery — same shape as bootstrap.
  // `null` disables the layer entirely (useful for tests that
  // shouldn't touch the host's ~/.config/agent or repo .agent
  // directories).
  userAgentsDir?: string | null;
  projectAgentsDir?: string | null;
  // Recursion depth THIS child is running at. The parent's
  // `runSubagent` computes the depth before spawning and passes
  // it via `--subagent-depth <n>`. Without this, every
  // subprocess would reset depth to 0 and a chain of subprocess
  // subagents could nest beyond MAX_SUBAGENT_DEPTH (each child
  // sees its own task() invocations starting from 0). Threading
  // it through here closes the cross-process gap. Defaults to
  // 0 when omitted (top-level shape) — consistent with the
  // harness's own `subagentDepth ?? 0` semantics.
  depth?: number;
  // Sampling temperature for this child. Carried across via
  // `--subagent-temperature <n>`. Undefined means "use the
  // provider default" — same semantics as omitting temperature
  // on a top-level harness. Eval pipelines pin this to 0 for
  // determinism; without propagation, a subprocess child would
  // silently ignore the parent's temperature override and run
  // non-deterministically.
  temperature?: number;
  // Plan-mode flag from the parent. Carried across via
  // `--subagent-plan-mode` (presence-only). When true, the
  // child's harness loop refuses any tool whose metadata
  // declares `writes:true` (or `planSafe:false`) BEFORE
  // execution — defense in depth that doubles up with the
  // top-level task tool's planSafe:false gate. Without this
  // propagation, a programmatic caller invoking runSubagent
  // with planMode:true would see writing tools execute in the
  // child unchecked.
  planMode?: boolean;
}

// Build the envelope shape the parent's `runSubagent` expects to
// reconstruct. Mirrors the field set of `RunSubagentResult` but
// flattened into a JSON-friendly object — the runtime parses it
// back into the discriminated result on the parent side.
const buildEnvelope = (result: HarnessResult, output: string): Record<string, unknown> => ({
  status: result.status,
  reason: result.reason,
  output,
  cost_usd: result.costUsd,
  steps: result.steps,
  duration_ms: result.durationMs,
  // last_message_id surfaced for parity with the in-process
  // path's `extractFinalOutput` reconstruction. The parent
  // doesn't strictly need it (the output is already extracted
  // here on the child side), but keeping it in the envelope
  // makes payload-only diagnostics more useful.
  ...(result.lastMessageId !== undefined ? { last_message_id: result.lastMessageId } : {}),
});

// Pull the child's terminal assistant text from messages by
// lastMessageId. Mirrors the in-process `extractFinalOutput`
// logic from subagents/runtime.ts — same parse rules so the
// envelope's `output` field matches across in-process and
// subprocess paths byte-for-byte. The repo already JSON-parses
// `content`, so we receive the structured form directly (string,
// array of blocks, or unparseable falls through to '').
const extractFinalOutput = (db: DB, lastMessageId: string | undefined): string => {
  if (lastMessageId === undefined || lastMessageId.length === 0) return '';
  const msg = getMessage(db, lastMessageId);
  if (msg === null || msg.role !== 'assistant') return '';
  const parsed = msg.content;
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
};

// The actual entry. Returns the exit code the runtime should hand
// to process.exit. Never throws — pre-loop failures route through
// the error envelope (when the outputs row exists) or stderr
// (when even that isn't possible).
export const runSubagentChild = async (opts: SubagentChildOptions): Promise<number> => {
  const errSink = opts.errSink ?? ((s: string) => process.stderr.write(s));
  const dbPath = opts.dbPath ?? defaultDbPath();

  const db = openDb(dbPath);
  let envelopePublished = false;
  // Track whether the outputs row was inserted so the catch path
  // can publish a final error envelope without a missing-row throw.
  let outputsRowInserted = false;

  // Finalize the child session as error before any pre-harness
  // exit path returns 1. Without this, the row stays in
  // 'running' and pollutes `--list-sessions` until something
  // else (parent polling, future stale-session sweeper) claims
  // it. If the parent ALSO crashed, the row would sit there
  // indefinitely. Best-effort: completeSession's
  // `WHERE status='running'` guard makes it idempotent (no-op
  // if already finalized) and the swallow handles missing rows
  // / closed DBs / schema drift — the diagnostic on stderr is
  // the authoritative signal.
  const finalizeAsError = (): void => {
    try {
      completeSession(db, opts.sessionId, 'error', 0, true);
    } catch {
      // ignore — row may be missing, already finalized, or
      // the DB handle may be unhealthy (the outer finally
      // closes it regardless).
    }
  };

  try {
    migrate(db);

    const session = getSession(db, opts.sessionId);
    if (session === null) {
      // Row doesn't exist — nothing to finalize. The parent
      // wired a stale or fictional id; that's the parent's
      // bug to surface.
      errSink(`forja: subagent-child: session ${opts.sessionId} not found in DB\n`);
      return 1;
    }
    if (!session.isSubagent) {
      // Session row exists but belongs to a top-level run, NOT
      // a subagent flow. Finalizing it as 'error' here would
      // corrupt a session the user cares about. Refuse without
      // touching the row.
      errSink(
        `forja: subagent-child: session ${opts.sessionId} is not a subagent (parent_session_id is null)\n`,
      );
      return 1;
    }
    if (session.status !== 'running') {
      // Already finalized — nothing to do. finalizeAsError's
      // status='running' guard would no-op anyway, but skipping
      // keeps the intent explicit.
      errSink(
        `forja: subagent-child: session ${opts.sessionId} is in status '${session.status}', expected 'running'\n`,
      );
      return 1;
    }

    const audit = getSubagentRun(db, opts.sessionId);
    if (audit === null) {
      errSink(
        `forja: subagent-child: no subagent_runs row for session ${opts.sessionId}; parent must insert audit before spawn\n`,
      );
      finalizeAsError();
      return 1;
    }

    // Insert the outputs row FIRST. From this point on, every
    // failure path can publish a payload — the parent gets
    // structured diagnostics instead of "no payload, timed out".
    insertSubagentOutput(db, { sessionId: opts.sessionId });
    outputsRowInserted = true;

    // Resolve the provider. Use the model recorded on the
    // session row (the parent picked it at spawn time); this is
    // the only way we know which model the parent intended.
    //
    // No silent fallback to a default model. If the child's
    // registry doesn't recognize `session.model`, refuse loud:
    // running on a different provider than what's persisted
    // on the row corrupts cost attribution (pricing is per-
    // model) and breaks audit forensics ("which model was
    // this run actually using?" must match `sessions.model`).
    // Drift causes:
    //   - Parent uses a model id only registered in its own
    //     process (custom providerOverride during dev/eval)
    //     and forgets to register it in the child path.
    //   - Future model id rename where parent and child
    //     binaries are out of sync (e.g., during a phased
    //     rollout).
    // Either case, the right behavior is to fail the run with
    // a clear envelope and let the operator fix the
    // misconfiguration.
    let provider: Provider;
    if (opts.providerOverride !== undefined) {
      provider = opts.providerOverride;
    } else {
      const registry = createDefaultRegistry();
      const entry = registry.get(session.model);
      if (entry === null) {
        const envelope = {
          status: 'error',
          reason: 'unknown_model',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: `unknown model: ${session.model}`,
        };
        setSubagentPayload(db, opts.sessionId, envelope);
        envelopePublished = true;
        errSink(`forja: subagent-child: unknown model ${session.model}\n`);
        finalizeAsError();
        return 1;
      }
      provider = entry.factory();
    }

    // Build the permission engine from the SNAPSHOT the parent
    // persisted on subagent_runs (migration 015). We deliberately
    // do NOT call `resolvePolicy(...)` here — re-resolving the
    // .agent/permissions.yaml + enterprise + user layers would
    // open a drift window: a human edit between parent spawn
    // and child startup could run the child under different
    // rules than the parent had validated. The snapshot
    // collapses that window to zero — the rules are sealed at
    // spawn time. Locked sections, strict-mode defaults,
    // matched paths — all carry over byte-for-byte.
    const permissionEngine = createPermissionEngine(audit.policySnapshot, { cwd: session.cwd });

    // The audit row carries the canonical toolset (`tools_whitelist`)
    // the parent pre-validated and committed. The child rebuilds
    // the registry from that list — NOT by re-loading the
    // definition .md from disk, which could have drifted between
    // spawn and child read.
    const fullRegistry = createToolRegistry();
    registerBuiltinTools(fullRegistry);
    const childRegistry = createToolRegistry();
    for (const toolName of audit.toolsWhitelist) {
      const tool = fullRegistry.get(toolName);
      if (tool === null) {
        const envelope = {
          status: 'error',
          reason: 'unknown_tool',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: `tool '${toolName}' from snapshot not registered in active builtin set`,
        };
        setSubagentPayload(db, opts.sessionId, envelope);
        envelopePublished = true;
        errSink(`forja: subagent-child: unknown tool '${toolName}' in snapshot\n`);
        finalizeAsError();
        return 1;
      }
      childRegistry.register(tool);
    }

    // Subagent discovery for nested task() calls. A coordinator-
    // style subagent that whitelists `task` in its toolset must be
    // able to spawn grandchildren the same way the top-level
    // process does — without loading the registry here, the
    // harness's spawn closure stays undefined and `task` surfaces
    // `subagent.unavailable` for every invocation. Loading uses
    // the same path as bootstrap (user + project scope, project
    // wins on shadow). Validation runs against the full registry
    // built above so a malformed definition fails fast with a
    // structured envelope rather than a deferred runtime error.
    let subagents: ReturnType<typeof loadSubagents>;
    try {
      subagents = loadSubagents({
        cwd: session.cwd,
        ...(opts.userAgentsDir !== undefined ? { userDir: opts.userAgentsDir } : {}),
        ...(opts.projectAgentsDir !== undefined ? { projectDir: opts.projectAgentsDir } : {}),
      });
      validateSubagentSet(subagents.byName.values(), fullRegistry);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubagentPayload(db, opts.sessionId, {
        status: 'error',
        reason: 'subagent_load_failed',
        output: '',
        cost_usd: 0,
        steps: 0,
        duration_ms: 0,
        message: msg,
      });
      envelopePublished = true;
      errSink(`forja: subagent-child: subagent load failed: ${msg}\n`);
      finalizeAsError();
      return 1;
    }

    // Reconstruct the user prompt. The parent persists the prompt
    // as the first user-role message on the child session row;
    // the harness loop normally appends `userPrompt` after init,
    // but with `preassignedSessionId` we must surface the prompt
    // through the same path. Cleanest: the parent leaves the row
    // empty, the child's harness loop builds the user message
    // from `config.userPrompt`. We pull it from the audit-adjacent
    // metadata: the parent stores the prompt in a sessions-extras
    // location… but we don't have one yet. For 4.2b.ii.a, the
    // parent passes the prompt by inserting it as the first
    // message BEFORE spawn; the child's harness then does NOT
    // append a fresh user message (preassignedSessionId path).
    //
    // To keep the existing harness loop unchanged, we set
    // `userPrompt: ''` and rely on the pre-existing message row
    // to seed the conversation. The harness skips appending an
    // empty user message — same as the resume path.
    const userPrompt = '';

    const config = {
      provider,
      toolRegistry: childRegistry,
      // The grandchild's whitelist (when this child task()s a
      // worker) validates against `rootToolRegistry`, NOT
      // `toolRegistry` — a coordinator subagent narrowed to
      // `[task]` would otherwise refuse a worker's `[read_file]`
      // because read_file isn't in the coordinator's narrowed
      // view. Mirrors the same plumbing the parent's
      // `runSubagent` does at the top level.
      rootToolRegistry: fullRegistry,
      permissionEngine,
      db,
      cwd: session.cwd,
      systemPrompt: audit.systemPrompt,
      userPrompt,
      preassignedSessionId: opts.sessionId,
      // Carry through budget caps from the audit row.
      budget: {
        maxSteps: audit.budgetMaxSteps,
        maxCostUsd: audit.budgetMaxCostUsd,
        ...(audit.budgetMaxWallMs !== null ? { maxWallClockMs: audit.budgetMaxWallMs } : {}),
      },
      // Subagent registry forwarded so the child's `task` tool
      // can resolve grandchild names. Without this, the harness
      // loop's spawn closure stays undefined and every nested
      // task() invocation surfaces `subagent.unavailable` —
      // breaking coordinator-style chains that 4.2a supported
      // in-process.
      subagentRegistry: subagents,
      // Recursion depth carried across the subprocess boundary
      // by the parent's `runSubagent` (via `--subagent-depth`
      // CLI flag, threaded into `opts.depth` here). Without
      // this, every subprocess child would reset to 0 and any
      // nested task() chain would compute depth from a fresh
      // baseline — bypassing the chain-wide MAX_SUBAGENT_DEPTH
      // guard and allowing runaway fan-out. The harness's
      // spawn closure increments this on the next hop, so a
      // grandchild correctly sees `parentDepth + 1`.
      subagentDepth: opts.depth ?? 0,
      // Sampling temperature carried across the subprocess
      // boundary. Conditional spread: when undefined, the
      // harness lets the provider use its own default (same as
      // a top-level run with no temperature pinned). Without
      // forwarding, eval / automation pipelines that pin
      // temperature=0 would see subprocess subagents silently
      // run at the provider default and break determinism.
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      // Plan mode propagation. When the parent invoked
      // runSubagent with planMode:true, the child's harness
      // loop must reject every writing tool BEFORE execution —
      // defense in depth that doubles up with the top-level
      // `task` tool gate (planSafe:false). The conditional
      // spread keeps the absent-by-default semantics: omitting
      // the flag on the parent side leaves the child running
      // with normal (non-plan) execution.
      ...(opts.planMode === true ? { planMode: true } : {}),
      // Checkpoints stay off in 4.2b.ii.a — the worktree path
      // already provides a separate branch for changes; per-step
      // checkpoint chain inside the worktree lands in 4.2c.
      enableCheckpoints: false,
      // bgLogDir omitted: the validator + buildChildRegistry both
      // refuse `requiresBgManager` tools, so the surface is empty.
      // 4.2b.iv wires per-worktree bg logs.
    };

    const result = await runAgent(config);
    const output = extractFinalOutput(db, result.lastMessageId);
    const envelope = buildEnvelope(result, output);
    setSubagentPayload(db, opts.sessionId, envelope);
    envelopePublished = true;
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message || e.name || String(e) : String(e);
    if (outputsRowInserted && !envelopePublished) {
      // Last-ditch envelope so the parent's poller sees an error
      // payload instead of timing out on missing-payload. We
      // catch any throw from setSubagentPayload itself silently —
      // if even the audit-publish path is broken, the stderr
      // write is the only signal we can offer.
      try {
        setSubagentPayload(db, opts.sessionId, {
          status: 'error',
          reason: 'internalError',
          output: '',
          cost_usd: 0,
          steps: 0,
          duration_ms: 0,
          message: msg,
        });
      } catch {
        // ignore
      }
    }
    // Finalize the session row. runAgent's contract is to call
    // completeSession from inside its lifecycle; if the throw
    // escaped past that path (rare — the harness top-level
    // catch is documented as exhaustive, but a regression
    // there would otherwise leak the row), the explicit
    // finalize here closes the gap. Idempotent: when runAgent
    // already finalized to 'done' / 'exhausted' / 'error', the
    // status='running' guard makes this a no-op.
    finalizeAsError();
    errSink(`forja: subagent-child: ${msg}\n`);
    return 1;
  } finally {
    db.close();
  }
};
