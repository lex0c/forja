import { type HarnessResult, runAgent } from '../harness/index.ts';
import { createPermissionEngine, resolvePolicy } from '../permissions/index.ts';
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
  // Test seams for permission hierarchy — same shape as bootstrap.
  enterprisePolicyPath?: string | null;
  userPolicyPath?: string | null;
}

const DEFAULT_MODEL_FALLBACK = 'anthropic/claude-sonnet-4-6';

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
    let provider: Provider;
    if (opts.providerOverride !== undefined) {
      provider = opts.providerOverride;
    } else {
      const registry = createDefaultRegistry();
      const entry = registry.get(session.model) ?? registry.get(DEFAULT_MODEL_FALLBACK);
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

    // Permission hierarchy resolution. Mirrors bootstrap so the
    // child runs under the same policies the parent does — a
    // child should NOT escape the user's permission rules just
    // because it spawned in its own process. Locked sections,
    // strict-mode defaults, etc. all carry over.
    const resolved = resolvePolicy({
      cwd: session.cwd,
      ...(opts.enterprisePolicyPath !== undefined
        ? { enterprisePath: opts.enterprisePolicyPath }
        : {}),
      ...(opts.userPolicyPath !== undefined ? { userPath: opts.userPolicyPath } : {}),
    });
    const permissionEngine = createPermissionEngine(resolved.policy, { cwd: session.cwd });

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
    errSink(`forja: subagent-child: ${msg}\n`);
    return 1;
  } finally {
    db.close();
  }
};
