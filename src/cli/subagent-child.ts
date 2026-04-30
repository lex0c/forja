import { type HarnessResult, runAgent } from '../harness/index.ts';
import { createPermissionEngine } from '../permissions/index.ts';
import { type Provider, createDefaultRegistry } from '../providers/index.ts';
import {
  type DB,
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
  try {
    migrate(db);

    const session = getSession(db, opts.sessionId);
    if (session === null) {
      errSink(`forja: subagent-child: session ${opts.sessionId} not found in DB\n`);
      return 1;
    }
    if (!session.isSubagent) {
      // Refuse to run a non-subagent session through this entry
      // path — the caller wired the wrong id, or the parent_session_id
      // field is missing. Either way, the harness would happily
      // execute and pollute the row with subagent-shaped state.
      errSink(
        `forja: subagent-child: session ${opts.sessionId} is not a subagent (parent_session_id is null)\n`,
      );
      return 1;
    }
    if (session.status !== 'running') {
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
      // Checkpoints stay off in 4.2b.ii.a — the worktree path
      // already provides a separate branch for changes; per-step
      // checkpoint chain inside the worktree lands in 4.2c.
      enableCheckpoints: false,
      // bgLogDir omitted: the validator + buildChildRegistry both
      // refuse `requiresBgManager` tools, so the surface is empty.
      // 4.2b.iv wires per-worktree bg logs.
      //
      // `subagentDepth` left at default 0. The depth counter
      // doesn't yet propagate across the subprocess boundary —
      // a chain of subprocess subagents could nest beyond
      // MAX_SUBAGENT_DEPTH because each child starts at 0 from
      // its own perspective. Per-subagent budget caps (steps,
      // cost, wall-clock) bound the practical damage; rigorous
      // depth forwarding lands with planMode/temperature in
      // 4.2b.ii.b (likely via a new column on subagent_runs).
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
    errSink(`forja: subagent-child: ${msg}\n`);
    return 1;
  } finally {
    db.close();
  }
};
