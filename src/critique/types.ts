// Self-critique pass types per AGENTIC_CLI.md §5.4 and ORCHESTRATION.md §6.
//
// Slice A scope: types + engine. Loop integration (defer-persist + redo
// hint + abort path) lands in Slice B; pre-tool-invoke critique lands
// in Slice B as well — this file already carries the full surface so
// callers can be wired without revisiting it.

import type { UsageInfo } from '../providers/index.ts';

// AGENTIC_CLI.md §5.4: `off` (default) | `on_writes` | `always`.
export type CritiqueMode = 'off' | 'on_writes' | 'always';

// Spec §5.4 emits `info | warn | error`. The TUI's `critique:ask`
// modal (events.ts) consumes a different set (`low | medium | high`)
// because it predates this engine. The harness adapter (Slice B)
// translates between the two — kept distinct so the spec mapping
// stays load-bearing here and the modal contract stays load-bearing
// at the TUI boundary.
export type CritiqueSeverity = 'info' | 'warn' | 'error';

// One entry from the critic's structured output.
export interface CritiqueIssue {
  severity: CritiqueSeverity;
  description: string;
  // 0..1 confidence the issue is real. Filtered against
  // `CritiqueRunOptions.threshold` before reaching the user.
  confidence: number;
  suggestion: string;
}

// Raw structured output the critic must emit (§5.4 schema).
// Captured before threshold filtering so audit gets the full picture.
export interface CritiqueOutput {
  issues: CritiqueIssue[];
  // 0..1 — critic's confidence in the executor's output as a whole.
  overallConfidence: number;
}

export type CritiqueStrategy =
  // LLM call ran end-to-end and returned parsed structured output.
  | 'llm'
  // Skipped on purpose: mode=off, no applicable target, or
  // maxOverheadMs forced an early exit. Run continues.
  | 'skipped'
  // LLM ran but couldn't be parsed into the §5.4 schema, or the
  // stream errored. Run continues; audit captures the reason.
  // Distinct from `skipped` so observability can separate "we
  // chose not to run" from "we ran and it broke".
  | 'failed';

// Slice A engine return shape. Carries enough for the harness loop
// (Slice B) to decide ignore/redo/abort without re-running the call.
export interface CritiqueResult {
  strategy: CritiqueStrategy;
  // Issues that crossed `threshold`. The harness emits `critique:ask`
  // only when this list is non-empty AND strategy === 'llm'.
  filteredIssues: CritiqueIssue[];
  // Every issue the critic produced, pre-filter. Persisted to audit
  // so threshold tuning can replay without re-billing.
  rawIssues: CritiqueIssue[];
  overallConfidence: number;
  // Wall-clock from engine entry to return. Includes the LLM stream
  // time and the parse pass — what the operator pays in latency.
  durationMs: number;
  // Cost of the critic call alone (NOT folded into step.cost_usd
  // per ORCHESTRATION.md §6.3). The harness adds this to the
  // session-wide totalCostUsd as a separate line in `/cost`.
  costUsd: number;
  usage: UsageInfo;
  usageSeen: boolean;
  // Optional human-readable detail. Populated on `skipped`
  // (`overhead_exceeded`, `mode_off`, `not_applicable`) and on
  // `failed` (parse error message, stream error code, etc).
  reason?: string;
}

// Bounded knobs for a single critique run. The harness builds this
// per step from `CritiqueConfig` plus the per-call abort signal.
export interface CritiqueRunOptions {
  // Confidence floor. Issues below this don't reach the user. §5.4
  // default 0.7. Range [0, 1]; values outside are clamped at the
  // engine entry to keep the contract loud.
  threshold: number;
  // Max wall-clock the critic is allowed before the engine bails
  // and returns strategy='skipped' with reason='overhead_exceeded'.
  // §5.4 default 3000ms. The watchdog aborts the stream — the run
  // is NOT terminated. Set to 0 to disable the watchdog (engine
  // waits for the LLM to finish; useful in tests with mock providers
  // that resolve synchronously).
  maxOverheadMs: number;
  // Cap on the critic's `max_tokens`. Default 1024 — long enough
  // to enumerate a handful of structured issues, short enough that
  // the call doesn't dominate the step cost. Mirrors the
  // `compaction` knob.
  maxTokens?: number;
  // Pinned prompt version. The engine forwards this verbatim to
  // audit so a future prompt revision can be replayed against
  // older rows. Defaults to the engine's current `v1` if absent.
  promptVersion?: string;
  // Forwarded to the provider stream so caller-driven aborts
  // (Ctrl+C, wall-clock, parent cancellation) interrupt the
  // critic call cleanly.
  signal?: AbortSignal;
}

// What the critic reviews. Built by the harness loop from the
// step's input + the executor's proposed output.
export interface CritiqueInput {
  // Original user prompt for the run. Gives the critic the
  // top-level intent regardless of how many steps preceded.
  userPrompt: string;
  // System prompt the executor used. Optional because some
  // headless callers don't set one and the critic can still
  // reason from prompt + output. When present, the critic sees
  // it as background context (NOT as its own system prompt).
  executorSystemPrompt?: string;
  // Proposed assistant text. Empty string is legal — a step that
  // produced only tool_use blocks has no text to critique;
  // `toolPlan` carries the substance.
  assistantText: string;
  // Proposed tool calls. Set when critiquing a `writes:true` tool
  // plan in `on_writes` mode; otherwise undefined. The critic is
  // told explicitly that these calls have NOT been executed yet,
  // so its issues should target the plan, not hypothetical
  // results.
  toolPlan?: CritiqueToolPlanEntry[];
}

export interface CritiqueToolPlanEntry {
  name: string;
  input: Record<string, unknown>;
  // Whether the tool's metadata declared writes:true. Drives the
  // critic's framing — a `writes:true` plan is the high-stakes
  // case `on_writes` mode targets.
  writes: boolean;
}

// Operator-facing config (TOML loaded by the CLI; per AGENTIC_CLI.md
// §5.4). Slice A surfaces the type; Slice B threads it through
// HarnessConfig.
export interface CritiqueConfig {
  mode: CritiqueMode;
  threshold: number;
  maxOverheadMs: number;
  promptVersion?: string;
}

export const DEFAULT_CRITIQUE_CONFIG: CritiqueConfig = {
  // §5.4: default off. Self-critique is opt-in — the cost is real
  // (2x latency on covered steps) and the false-positive rate
  // requires per-project threshold tuning before it stops being
  // noise.
  mode: 'off',
  threshold: 0.7,
  // §5.4: 3000ms. Beyond this the critic is silently skipped.
  maxOverheadMs: 3000,
};

// Three-way operator decision when the critic flags issues
// (AGENTIC_CLI.md §5.4 line 551). Plus `cancel` (Esc / timeout)
// which the harness treats the same as `abort` — neither one
// proceeds with the proposed output. Kept distinct in the union
// so audit can tell explicit-rejection from passive-cancel.
export type CritiqueAnswer = 'ignore' | 'redo' | 'abort' | 'cancel';

// Producer-facing args for `confirmCritique` (the harness hook the
// REPL bridge wires to its modal manager). Mirrors the modal layer
// without forcing the harness to import TUI types — the REPL
// translates engine-side severity to the modal's `low | medium |
// high` shape.
export interface ConfirmCritiqueRequest {
  // Issues that crossed the threshold. The modal renders these in
  // its preview block; the operator sees them before deciding.
  issues: CritiqueIssue[];
  overallConfidence: number;
  // True iff the proposed step was about to invoke at least one
  // `writes:true` tool. Drives the modal's framing — a `writes`
  // step is the high-stakes case `on_writes` mode targets, and
  // the modal can render a stronger warning ("about to mutate
  // files; review before continuing") vs a plain end-of-step
  // critique.
  toolPlanWrites: boolean;
}
