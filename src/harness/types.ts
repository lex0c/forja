import type { Decision, PermissionEngine } from '../permissions/index.ts';
import type { Provider, StreamEvent, UsageInfo } from '../providers/index.ts';
import type { DB } from '../storage/index.ts';
import type { ToolRegistry } from '../tools/index.ts';

// Lifecycle events the harness emits during a run. Synchronous (fire and
// forget) so renderers stay simple and the loop never waits on UI work.
// Persistence happens via SQLite separately — these events are for live
// observers (TTY renderer, NDJSON output, future telemetry).
export type HarnessEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'step_start'; stepN: number }
  | { type: 'provider_event'; event: StreamEvent }
  | {
      type: 'tool_invoking';
      toolUseId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool_decided'; toolUseId: string; decision: Decision }
  | {
      type: 'tool_finished';
      toolUseId: string;
      toolName: string;
      failed: boolean;
      durationMs: number;
    }
  | {
      type: 'compaction_started';
      // Token count that crossed the threshold — what we observed
      // BEFORE the next request would have gone out.
      promptTokens: number;
      threshold: number;
      contextWindow: number;
    }
  | {
      type: 'compaction_finished';
      strategy: 'llm' | 'fallback' | 'skipped';
      foldedCount: number;
      durationMs: number;
      // Usage and cost the compaction call itself incurred. The
      // summary call is a billed provider request — surfacing it
      // here lets renderers show "session cost includes $X for
      // compaction" instead of silently underreporting.
      usage: UsageInfo;
      costUsd: number;
      reason?: string;
    }
  | { type: 'session_finished'; result: HarnessResult };

// Budget caps for an autonomous run. Per AGENTIC_CLI §5: every limit has
// soft (warning) and hard (terminate) thresholds. M1 enforces hard caps
// only; warnings show up when the UI lands in Step 6.
export interface RunBudget {
  maxSteps: number;
  maxWallClockMs: number;
  maxToolErrors: number;
  // Sliding window: if `maxRepeatedToolHash` of the last 5 tool calls hash
  // identically, abort with `degenerate_loop`.
  maxRepeatedToolHash: number;
  // Cap on output tokens per provider call (passed straight through as
  // `max_tokens`). Not part of session-wide budget.
  maxOutputTokensPerCall: number;
  // Fraction of `provider.capabilities.context_window` at which the
  // harness triggers compaction. AGENTIC_CLI §6 / ORCHESTRATION §4.1
  // recommend 0.7 — leaves 30% headroom for the compaction call
  // itself plus the next response. Set to 1.0 to effectively disable.
  compactionThreshold: number;
  // Lower bound on trailing turns preserved literally during
  // compaction. ORCHESTRATION §4.6 recommends 3. Effective preserved
  // count may be `+1` because the compaction module aligns the tail
  // boundary to an assistant message (keeps tool_use → tool_result
  // pairs intact); when the requested boundary lands on a user the
  // module walks back one position. preserveTail=0 still preserves
  // the trailing assistant + its tool_result for the same reason.
  compactionPreserveTail: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxSteps: 50,
  maxWallClockMs: 10 * 60 * 1000,
  maxToolErrors: 5,
  maxRepeatedToolHash: 3,
  maxOutputTokensPerCall: 4096,
  compactionThreshold: 0.7,
  compactionPreserveTail: 3,
};

// Why the loop stopped. `done` is the only success path; everything else
// is the harness intervening for safety or budget reasons.
export type ExitReason =
  | 'done' // model emitted text without tool_use
  | 'maxSteps'
  | 'maxWallClockMs'
  | 'maxOutputTokens' // provider truncated the response at max_tokens
  | 'maxToolErrors'
  | 'degenerateLoop'
  | 'aborted' // user cancelled via signal
  | 'providerError' // unrecoverable provider failure (network, 4xx)
  | 'internalError' // uncaught throw in the harness path (typically SQLite)
  | 'scriptExhausted'; // mock provider drained — only seen in tests

export interface HarnessConfig {
  provider: Provider;
  toolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  db: DB;
  // Directory where bg-aware tools' stdout/stderr log files are
  // written. When set, the harness creates a session-scoped
  // BgManager after createSession and threads it through
  // ToolContext so `bash_background`/`bash_output`/`bash_kill` can
  // dispatch through it. The manager is owned by the harness
  // (cleanup runs in the session-end finally) — callers who need
  // pre-existing managers for testing build them directly with
  // createBgManager. When absent, bg-aware tools surface a clean
  // tool-error.
  bgLogDir?: string;
  cwd: string;
  systemPrompt?: string;
  userPrompt: string;
  budget?: Partial<RunBudget>;
  signal?: AbortSignal;
  // Synchronous observer for lifecycle events. Throws are caught and
  // discarded so a buggy renderer doesn't kill the loop.
  onEvent?: (event: HarnessEvent) => void;
  // Plan mode (AGENTIC_CLI §5): read-only profile. The harness
  // refuses tools with `metadata.writes === true` before
  // execution — even if policy would have allowed it. This is
  // harness-level, not policy-level, so write_file/edit_file
  // are blocked regardless of permission hierarchy state.
  //
  // Tools that opt in via `metadata.planSafe` (boolean or
  // predicate) MAY run in plan mode. The bash tool uses a
  // predicate that gates on `args.read_only === true`. This
  // gate is best-effort, NOT a security boundary: a model that
  // declares read_only:true on a mutating command (observed
  // with Haiku 4.5 sending `echo > file` with read_only:true)
  // bypasses the gate. For adversarial protection, use sandbox
  // (spec §9.1, M3+). For accidental-write protection from
  // honest models, the predicate is sufficient.
  planMode?: boolean;
  // Sampling temperature passed straight through to every
  // provider call this run makes. When unset, each provider
  // applies its own default (Anthropic 1.0, OpenAI 1.0, etc).
  // Setting `0` makes runs deterministic — required for evals
  // and any workflow that needs repeatable output. Tunable per
  // workflow per `TOKEN_TUNING.md`.
  temperature?: number;
  // Resume mode (AGENTIC_CLI §2.1): when set, the harness skips
  // createSession and uses this id instead. Persisted messages for
  // the session are loaded into the in-memory `messages` array
  // before the new userPrompt is appended, so the model sees the
  // full prior conversation as context. The session is reopened
  // (status flipped back to 'running') so completeSession at the
  // end of the resumed run doesn't trip its 'must be running'
  // guard. Caller is responsible for verifying the id exists
  // before constructing the config.
  resumeFromSessionId?: string;
}

export interface HarnessResult {
  status: 'done' | 'interrupted' | 'exhausted' | 'error';
  reason: ExitReason;
  sessionId: string;
  steps: number;
  durationMs: number;
  // Aggregated token usage across all provider turns this run. Only
  // turns that reported usage contribute; see `usageComplete`.
  usage: UsageInfo;
  // Total cost computed from `usage` × the provider's pricing. Same
  // completeness caveat as `usage`.
  costUsd: number;
  // True iff every assistant turn this session emitted a `usage`
  // event. False when at least one turn produced output but no usage
  // (compat endpoints that drop stream_options, mid-stream failures,
  // older SDKs without telemetry). Renderers should mark partial
  // results as estimates so the user doesn't read the cost as final.
  usageComplete: boolean;
  // Final assistant message id, if any was produced.
  lastMessageId?: string;
  // Optional human-readable detail for diagnostics (e.g., the provider
  // error message, or which tool exhausted the error budget).
  detail?: string;
}
