// UI event catalog. Spec: UI.md §3.
//
// This is the contract between the harness (producer) and the TUI
// renderer (consumer). The same union also feeds NDJSON serialization
// in headless mode (UI.md §7) — see the `--json` adapter.
//
// Naming follows the spec: kebab-cased domain prefix, colon, lifecycle
// suffix. `tool:start` / `tool:delta` / `tool:end` instead of
// camelCased `toolStart`, because the prefix groups events when a
// future filter wants e.g. all `tool:*`.
//
// Payloads are kept minimal — the renderer reads what it needs, and
// audit/persistence happens elsewhere via the harness's own event
// stream (see src/harness/types.ts HarnessEvent). When this catalog
// and HarnessEvent diverge in shape, an adapter sits between them
// (introduced in a later step).

// Common metadata. `ts` is wall-clock ms since epoch — useful for
// rendering "elapsed" without the renderer holding its own clock.
interface BaseEvent {
  ts: number;
}

// Status line / session lifecycle.
export type SessionStartEvent = BaseEvent & {
  type: 'session:start';
  sessionId: string;
  // Source-of-truth for status line render. Most fields stay
  // constant for the session; cost/steps update via step:budget.
  profile: 'autonomous' | 'orchestrated' | 'hybrid';
  project: string;
  model: string;
};
export type SessionEndEvent = BaseEvent & {
  type: 'session:end';
  sessionId: string;
  reason: 'done' | 'maxSteps' | 'maxCostUsd' | 'aborted' | 'error' | string;
};

// User input was submitted. Renderer flushes the input box and
// prints the echoed line as scrollback.
export type UserSubmitEvent = BaseEvent & {
  type: 'user:submit';
  text: string;
};

// Streaming assistant text.
export type AssistantStartEvent = BaseEvent & {
  type: 'assistant:start';
  messageId: string;
};
export type AssistantDeltaEvent = BaseEvent & {
  type: 'assistant:delta';
  messageId: string;
  text: string;
};
export type AssistantEndEvent = BaseEvent & {
  type: 'assistant:end';
  messageId: string;
};

// Extended thinking (Anthropic) / reasoning (OpenAI). Discrete from
// assistant deltas — never persisted, never shown verbatim.
export type ThinkingStartEvent = BaseEvent & { type: 'thinking:start'; messageId: string };
export type ThinkingDeltaEvent = BaseEvent & {
  type: 'thinking:delta';
  messageId: string;
  // Content is opaque to the renderer (just a duration counter).
  // We keep the field for headless replay tools.
  text?: string;
};
export type ThinkingEndEvent = BaseEvent & { type: 'thinking:end'; messageId: string };

// Tool calls. `args` is rendered already-formatted by the producer
// (one line, truncated) so the renderer doesn't need to know schema.
export type ToolStartEvent = BaseEvent & {
  type: 'tool:start';
  toolId: string;
  name: string;
  args: string;
};
export type ToolDeltaEvent = BaseEvent & {
  type: 'tool:delta';
  toolId: string;
  // Free-form output chunk (bash stdout, etc.).
  text: string;
};
export type ToolEndEvent = BaseEvent & {
  type: 'tool:end';
  toolId: string;
  status: 'done' | 'error' | 'denied';
  durationMs: number;
  // One-line summary the final tool card prints (UI.md §4.1). The
  // producer composes this — it knows the tool semantics.
  summary?: string;
};

// Permission/trust/memory write/plan review/critique modals.
// Payloads carry exactly what the modal needs to render. The
// renderer's modal handler (UI.md §5.5) resolves a promise on the
// other side; the producer awaits that promise.
export type PermissionAskEvent = BaseEvent & {
  type: 'permission:ask';
  promptId: string;
  toolName: string;
  command: string;
  cwd: string;
  // Optional risk hint — when present, modal shows the "why?" detail.
  rule?: string;
  reason?: string;
};
export type PermissionAnswerEvent = BaseEvent & {
  type: 'permission:answer';
  promptId: string;
  decision: 'accept' | 'reject' | 'edit';
};
export type TrustAskEvent = BaseEvent & {
  type: 'trust:ask';
  promptId: string;
  path: string;
  agentsMd: boolean;
};
// `scope` mirrors `MemoryScope` from `src/memory/types.ts`. We re-declare
// instead of importing so the TUI layer doesn't depend on memory's
// internal types — but the values must stay in sync. If memory adds a
// new scope, this union changes too.
export type MemoryScopeForUI = 'user' | 'project_shared' | 'project_local';
export type MemoryWriteAskEvent = BaseEvent & {
  type: 'memory:write:ask';
  promptId: string;
  scope: MemoryScopeForUI;
  name: string;
  body: string;
};
export type PlanReviewEvent = BaseEvent & {
  type: 'plan:review';
  promptId: string;
  steps: string[];
  estimatedCalls: number;
  estimatedCostUsd: number;
};
export type CritiqueAskEvent = BaseEvent & {
  type: 'critique:ask';
  promptId: string;
  issues: { severity: 'low' | 'medium' | 'high'; confidence: number; message: string }[];
};

// Todo list (live region above the status line). The full list is
// sent on every update — small enough that delta tracking buys nothing.
export type TodoUpdateEvent = BaseEvent & {
  type: 'todo:update';
  items: { id: string; status: 'pending' | 'running' | 'done' | 'failed'; text: string }[];
};

// Subagent lifecycle. The renderer groups by subagentId in the live
// region; on `subagent:end` the group collapses to a one-line summary.
export type SubagentStartEvent = BaseEvent & {
  type: 'subagent:start';
  subagentId: string;
  name: string;
  goal: string;
};
export type SubagentUpdateEvent = BaseEvent & {
  type: 'subagent:update';
  subagentId: string;
  progress: string;
};
export type SubagentEndEvent = BaseEvent & {
  type: 'subagent:end';
  subagentId: string;
  status: 'done' | 'error';
  summary: string;
  durationMs: number;
};

// Background processes.
export type BgStartEvent = BaseEvent & { type: 'bg:start'; processId: string; command: string };
export type BgUpdateEvent = BaseEvent & { type: 'bg:update'; processId: string; status: string };
// `exitCode` is null when the process was killed by a signal or never
// produced an exit (crash before exec, OOM kill); `signal` carries the
// POSIX signal name in those cases. Renderer chooses summary text from
// the combination.
export type BgEndEvent = BaseEvent & {
  type: 'bg:end';
  processId: string;
  exitCode: number | null;
  signal?: string;
};

// Budget / checkpoint signals consumed by the status line.
export type StepBudgetEvent = BaseEvent & {
  type: 'step:budget';
  steps: number;
  maxSteps: number;
  costUsd: number;
  maxCostUsd?: number;
};
export type CheckpointCreateEvent = BaseEvent & {
  type: 'checkpoint:create';
  checkpointId: string;
  stepN: number;
};

// Diagnostics + interrupts.
export type ErrorEvent = BaseEvent & {
  type: 'error';
  message: string;
  // When set, the producer expects the run to terminate; renderer
  // surfaces a permanent line and stops accepting input.
  fatal?: boolean;
};
export type WarnEvent = BaseEvent & {
  type: 'warn';
  message: string;
};
export type InterruptEvent = BaseEvent & {
  type: 'interrupt';
  // 'soft' = Esc once / single Ctrl+C: model finishes the step then
  // stops. 'hard' = double-tap: cancel tool in flight immediately.
  level: 'soft' | 'hard';
};

// Discriminated union — the renderer matches on `type` and the
// compiler narrows the payload.
export type UIEvent =
  | SessionStartEvent
  | SessionEndEvent
  | UserSubmitEvent
  | AssistantStartEvent
  | AssistantDeltaEvent
  | AssistantEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolStartEvent
  | ToolDeltaEvent
  | ToolEndEvent
  | PermissionAskEvent
  | PermissionAnswerEvent
  | TrustAskEvent
  | MemoryWriteAskEvent
  | PlanReviewEvent
  | CritiqueAskEvent
  | TodoUpdateEvent
  | SubagentStartEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | BgStartEvent
  | BgUpdateEvent
  | BgEndEvent
  | StepBudgetEvent
  | CheckpointCreateEvent
  | ErrorEvent
  | WarnEvent
  | InterruptEvent;

export type UIEventType = UIEvent['type'];

// Type-level helper: narrow UIEvent to a specific kind by its `type`.
export type UIEventOf<T extends UIEventType> = Extract<UIEvent, { type: T }>;
