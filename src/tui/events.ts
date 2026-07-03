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

import type { FileDiff } from '../diff/line-diff.ts';
import type { ForjaEffort } from '../harness/effort.ts';
import type { ApprovalPosture, PolicyLayer } from '../permissions/index.ts';

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
  project: string;
  model: string;
  // Distinct-name memory count surfaced in the footer's right
  // column as `mem N`. Dedupe-by-name matches what the operator
  // sees in the eager prompt section. Optional: producers that
  // didn't wire memory (one-shot SDK, replay tools) omit the
  // field; renderer skips the segment when undefined or zero.
  memoryCount?: number;
};

// One-shot welcome banner (UI.md §4.10.9). Emitted by the REPL at
// boot; producers MUST NOT emit twice. Pure permanent — the reducer
// pushes it to scrollback and never references it again. Three blocks
// (title / identity / env) separated by blank lines.
//
// Env entries discriminate on `kind` so the renderer can apply the
// right palette per spec §4.10.9:
//   - `flag` → `✓ {name}` (or `✓ {name} ({count})`) painted `success`
//     for binary capability indicators (checkpoints, memory). Items
//     in the off state are NOT emitted — the line lists what exists,
//     never what's missing.
//   - `meta` → `{key}: {value}` painted `dim` for non-binary metadata
//     (subagents count, policy descriptor).
// Empty array → renderer omits the env block entirely.
export type SessionBannerEnvEntry =
  | { kind: 'flag'; name: string; count?: number }
  | { kind: 'meta'; key: string; value: string };
// Active-sandbox indicator appended inline to the banner block when
// the broker resolved to spawn mode + sandbox tool present. Rendered
// as a secondary (greyscale) line directly under cwd — no leading
// blank — so the affirmative posture reads as part of the banner
// frame rather than a separate "alert". The non-active cases
// (no-tool / operator-override / degraded-passthrough) ride the
// standard warn/error event channels because they ARE warnings.
export type SessionBannerEvent = BaseEvent & {
  type: 'session:banner';
  app: string;
  version: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  cwd: string;
  // Operator home dir, for the banner's `$HOME → ~` cwd collapse (display
  // only — `cwd` stays raw for audit). Optional: absent skips the collapse,
  // so non-CLI emitters / tests that omit it still produce a valid banner.
  home?: string;
  env: SessionBannerEnvEntry[];
  // Tool name when sandbox enforcement is active (`bwrap` /
  // `sandbox-exec`); omitted when enforcement is disabled (the
  // warn/error event surfaces it explicitly instead).
  sandboxActive?: 'bwrap' | 'sandbox-exec';
  // Initial approval posture (Supervised / Autonomous) at boot, so the
  // footer cue is correct from the first frame (e.g. under
  // `--autonomous`). Optional — absent keeps the reducer's current
  // value (supervised default). Runtime flips ride `mode:change`.
  operationMode?: ApprovalPosture;
  // Initial effort level at boot (from `[sampling].effort` config or
  // DEFAULT_EFFORT), so the footer's effort chip is correct from the
  // first frame. Optional — absent keeps the reducer's current value.
  // Runtime changes ride `effort:change`.
  effort?: ForjaEffort;
  // Active isolation profile (`--profile` / FORJA_PROFILE), or null on the
  // default namespace. Drives the banner line + always-visible footer chip
  // so the operator can't mistake a dev/test run for their real Forja state.
  // Optional — absent keeps the reducer's current value (null default).
  profile?: string | null;
};
export type SessionEndEvent = BaseEvent & {
  type: 'session:end';
  sessionId: string;
  reason: 'done' | 'maxSteps' | 'maxCostUsd' | 'aborted' | 'error' | string;
  // Wall-clock duration of the run, in ms (mirrors
  // `HarnessResult.durationMs`). Powers the turn-end marker's
  // "Cogitated for 1m23s" rendering (UI.md §3.2). Optional only for
  // legacy / replay paths that don't have timing — production
  // emitters always set it.
  durationMs?: number;
  // Mirrors HarnessResult.abortCause. Only meaningful when
  // reason === 'aborted' — discriminates operator-initiated cooperative
  // ('soft') from preemptive ('hard'). NDJSON consumers and the
  // scrollback footer use this to distinguish "operator nudged" from
  // "operator escalated"; the in-flight footer cue (`esc to interrupt`
  // → `esc again to force`) was the live signal, this is its
  // post-session counterpart.
  abortCause?: 'soft' | 'hard';
};

// User input was submitted. Renderer flushes the input box and
// prints the echoed line as scrollback.
export type UserSubmitEvent = BaseEvent & {
  type: 'user:submit';
  text: string;
};

// Input box edit. Emitted by the REPL loop on every keystroke that
// mutated `InputState`, so the reducer keeps `state.input` current
// and the renderer redraws. Cheap event — value/cursor straight from
// `applyKey(...).next`. Producer (REPL editor handler) also drives
// `user:submit` separately when Enter is hit; the reducer clears
// `state.input` in that branch, so the post-submit `input:update`
// (if any) lands on a fresh empty buffer.
export type InputUpdateEvent = BaseEvent & {
  type: 'input:update';
  value: string;
  cursor: number;
};

// INBOX (docs/spec/INBOX.md §6 — in-memory by design). A message the
// operator committed while a turn/playbook was in flight, queued
// instead of dropped. The reducer appends it to `state.queued` (and
// clears the input, like user:submit) so it renders as a pending bar.
export type InboxQueuedEvent = BaseEvent & {
  type: 'inbox:queued';
  id: string;
  text: string;
};

// INBOX edit (§4.2 / §6.1 "↑ edit"). The message is NEVER removed from
// the queue while edited — it stays in `state.queued` (so it can't be
// lost); `state.editingId` marks it so the renderer hides its bar while
// it sits in the input. `edit-start` begins the edit, `edit-commit`
// writes the new text in place (FIFO position kept), `edit-cancel` ends
// the edit with the message unchanged.
export type InboxEditStartEvent = BaseEvent & {
  type: 'inbox:edit-start';
  id: string;
};
export type InboxEditCommitEvent = BaseEvent & {
  type: 'inbox:edit-commit';
  id: string;
  text: string;
};
export type InboxEditCancelEvent = BaseEvent & {
  type: 'inbox:edit-cancel';
};

// INBOX remove (§4.3 "cancel"). The operator lifted a queued message via
// ↑ and erased the buffer to empty — the gesture for "drop this queued
// message" (no confirm keystroke). The reducer removes it from
// `state.queued` and clears editingId. TERMINAL: unlike edit-cancel
// (which restores the message unchanged), the message leaves the queue
// for good and never drains.
export type InboxRemoveEvent = BaseEvent & {
  type: 'inbox:remove';
  id: string;
};

// The inbox drained at a turn boundary: the queue empties and each
// queued item freezes into a `user-submit` scrollback bar. `texts`
// carries the drained bodies in FIFO order. The reducer does NOT clear
// the input — a draft typed after the last enqueue survives the drain.
export type InboxDrainedEvent = BaseEvent & {
  type: 'inbox:drained';
  texts: string[];
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
// Per-turn token usage. Spec UI.md §4.10.5 — the live "Generating…"
// chip shows `(Xs · ↑ N tokens)` when this lands; the final
// scrollback line shows `Generated N tokens in Xs`. Producers that
// don't expose token counts (or providers that emit usage only at
// stop) just don't emit this — the chip falls back to `(Xs)`.
//
// Anthropic emits cumulative running totals; OpenAI emits the final
// total only at stop. We treat the latest non-null field as canonical
// (max over the stream) so a hypothetical incremental shape stays
// monotonic.
//
// `cacheRead` and `cacheCreation` are surfaced but not rendered today
// — they fold into the cost computation downstream and may surface
// in a future "expand chip" panel. The renderer only pulls
// `outputTokens` for the chip counter.
export type AssistantUsageEvent = BaseEvent & {
  type: 'assistant:usage';
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
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

// Tool calls. The producer (adapter) resolves the tool's name into a
// vocab pair (`activeVerb` shown while running, `finalVerb` after
// completion) plus a `subject` line — typically the path / command /
// query the tool acted on. Renderer never sees the raw JSON args by
// default; the `(ctrl+o to expand)` flow surfaces them on demand.
// See `src/tui/tool-vocab.ts` for the vocabulary table.
export type ToolStartEvent = BaseEvent & {
  type: 'tool:start';
  toolId: string;
  // Internal tool name (`read_file`, `bash`, …) — kept for audit /
  // filtering. Renderer uses `activeVerb` / `finalVerb` for display.
  name: string;
  activeVerb: string;
  finalVerb: string;
  // One-line subject under `└─ `; null when args don't carry the
  // expected field (renderer drops the connector line).
  subject: string | null;
  // Optional grouping id (`subagentId` for tool calls fired
  // inside a subagent run). When set, the renderer indents the
  // chip and swaps its glyph to a nesting marker (`|_`) so the
  // operator visually attributes nested tool calls to their
  // owner. Top-level tool calls (parent harness) leave this
  // absent. Carried verbatim from `tool:start` through the
  // active-tool record into the `PermanentItem` so the chip
  // renderer can read it back at end time without re-deriving.
  parentId?: string;
};
// Fired when a tool's body actually starts running — after the
// permission engine, modal, and PreToolUse hooks. The reducer
// rebases the active tool's `startedAt` to this event's `ts`, so the
// card clock measures execution, not the human wait at the modal.
export type ToolExecutionStartedEvent = BaseEvent & {
  type: 'tool:execution-started';
  toolId: string;
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
  // True when the tool capped its own output (bash `max_bytes`,
  // grep / glob `max_results`, the read_file window). Drives the
  // `… output truncated` hint on the finished card. Absent on
  // failure / denial and for tools with no truncation notion.
  outputTruncated?: boolean;
  // Structured before→after diff for a write/edit tool (display only,
  // off the model result). Renderer shows +N/−M on the head and a
  // bounded colored snippet under the card.
  diff?: FileDiff;
  // Non-zero exit code of a command tool (bash). Present only when
  // the command exited non-zero; drives the `exit N` marker on the
  // card. Absent for exit 0 and tools with no exit code.
  exitCode?: number;
};

// Permission/trust/memory write modals.
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
  // Policy layer that holds the matching rule (PolicyLayer in
  // permissions/types.ts). When set alongside `rule`, the reducer
  // renders "matched rule: <rule> (<layer> policy)" so the operator
  // knows which YAML to edit. Optional for backwards compat with
  // synthesized events / subagent-proxied confirms.
  layer?: PolicyLayer;
  reason?: string;
  // Subagent attribution. Set when the ask was proxied from a
  // child subagent over IPC (spec docs/spec/IPC.md §7). The
  // reducer renders a prefix in the modal preview so the
  // operator distinguishes parent vs child requests. Undefined
  // for the parent's own confirms.
  subagent?: { sessionId: string; name: string };
};
// Modal resolution event. Renamed from `permission:answer` because
// the same event flows for every modal flavor (trust answers `yes`/
// `no`, memory-write answers `yes`/`no`, etc.) — naming it
// after just the permission flavor was misleading. Decision is a
// flavor-specific string; consumers that care about the union
// narrow per-flavor by reading the original `*:ask` event.
//
// `cancel` is the universal "user closed without deciding" value
// across flavors (returned on Esc); audit can tell it from explicit
// rejection.
export type ModalAnswerEvent = BaseEvent & {
  type: 'modal:answer';
  promptId: string;
  decision: string;
};
// In-modal navigation event. The manager fires on ↑/↓/Tab/Shift+Tab;
// reducer updates only `state.modal.selectedIndex` when the promptId
// matches the open modal. Avoids re-emitting `*:ask` (which would
// rebuild the modal contents from scratch).
export type ModalSelectEvent = BaseEvent & {
  type: 'modal:select';
  promptId: string;
  selectedIndex: number;
};
// Live update of how many other ask*s are queued behind the active
// modal. Producer (modal-manager) emits one when the modal opens
// (snapshot of `queue.length` at drain time) and again every time
// a new ask enqueues while the modal is up. Reducer updates the
// active modal's `queueDepth` when promptId matches; mismatches
// drop silently (a stale event arriving after the matching modal
// already resolved). Renderer surfaces the depth as a title
// suffix so the operator sees the queue grow / shrink in real
// time instead of being blindsided when answering one modal
// auto-pops the next.
export type ModalQueueDepthEvent = BaseEvent & {
  type: 'modal:queue-depth';
  promptId: string;
  // Number of asks waiting BEHIND this active one — does NOT
  // include the active modal itself. Zero when the active is
  // the only ask in flight.
  depth: number;
};
// Clarify raise (STATE_MACHINE §12). The reducer builds a `modal`
// (ConfirmState, flavor 'clarify') from it — clarify is a confirm
// flavor: one question + options. Navigation and resolution use the
// generic modal:select / modal:answer machinery; multiple pending
// clarifies stack in the FIFO queue like any other modal.
export type ClarifyAskEvent = BaseEvent & {
  type: 'clarify:ask';
  promptId: string;
  question: string;
  why: string | null;
  // `key` is a generated safe hotkey (a, b, c, …), NOT the model id — a
  // named-key id ('down'/'escape') would hijack nav (the hotkey check
  // precedes the nav handlers). `id` stays the resolved value; the
  // manager generates both so render + resolution agree.
  options: ReadonlyArray<{ id: string; label: string; key: string }>;
};
export type TrustAskEvent = BaseEvent & {
  type: 'trust:ask';
  promptId: string;
  path: string;
  agentsMd: boolean;
};

// Relay-start flavor — `/relay` confirm before opening the mesh listen socket
// (the first inbound channel Forja opens, so it gets an explicit confirm —
// MESH.md §6.1). Answer maps: yes → startServing, no/cancel → stay off.
export type RelayStartAskEvent = BaseEvent & {
  type: 'relay-start:ask';
  promptId: string;
  alias: string;
};

// Shared-corpus trust re-confirmation (MEMORY.md §6.5.2 `trust_revoked`
// detector, §7.2 rule 8). Fires after bootstrap when either:
//
//   - the shared/ corpus is non-empty AND no prior trust row exists
//     (mode 'first-visit' — P0/F2 hardening; the cwd-trust modal
//     attested the directory, NOT the shared-memory content); OR
//   - a stored trust row's hash diverged from the current corpus
//     fingerprint (mode 'drift' — typically after `git pull` that
//     modified `.forja/memory/shared/`).
//
// Distinct from `trust:ask` (first-visit cwd trust) in both trigger
// and consequence:
//
//   - trust:ask resolves `yes` → cwd added to `trusted_dirs.json`.
//     A `no/cancel` → operator hasn't entered the REPL at all yet, so
//     we exit cleanly with no side-effects.
//   - shared-trust:ask resolves `yes` → the corpus hash is stamped
//     into `shared_corpus_trust` (after a TOCTOU re-check). `no` →
//     bulk-invalidate every state=active shared memory + clear trust
//     row. `cancel` → defer (leave trust row pinned to old hash; next
//     boot re-prompts). `trust_revoked` is the eviction-event
//     trigger; `invalidated` is the target state.
//
// `path` is the absolute shared-corpus root (`<repo>/.forja/memory/
// shared`) rather than the cwd — operator distinguishes "I trusted
// this cwd" from "the shared/ within it just changed". `corpusFiles`
// is the current inventory (name + byte length); no prior snapshot
// is rendered because the substrate only stores ONE aggregate hash.
//
// SECURITY: filename strings flow from disk-attacker-controlled
// readdirSync. The reducer MUST sanitize before rendering to avoid
// ANSI/control-byte injection that would let an attacker repaint the
// trust modal (P0/F1 hardening). The renderer trusts whatever
// `corpusFiles[i].name` contains, so sanitization happens at the
// reducer boundary, not here.
export type SharedTrustAskEvent = BaseEvent & {
  type: 'shared-trust:ask';
  promptId: string;
  path: string;
  // 'first-visit': no prior trust row, non-empty corpus. The
  //                operator has never attested this content.
  // 'drift':       trust row existed; current hash differs.
  // The renderer adapts prose per mode; the answer space is the
  // same ('yes' / 'no' / 'cancel') and the substrate handles
  // both modes uniformly downstream.
  mode: import('../memory/trust-corpus-probe.ts').SharedTrustModalMode;
  // Snapshot of the current corpus the operator is being asked to
  // (re-)confirm. Each entry is one `.md` file at the corpus root —
  // filename plus byte length so the operator can spot suspicious
  // size growth ("foo.md is suddenly 50KB?") without the modal
  // rendering raw bodies inline (would explode preview height for
  // large corpora and re-expose the very content under review).
  corpusFiles: readonly { name: string; bytes: number }[];
};

// MCP server manifest-trust modal (MCP.md §1.5). Trusting authorizes SPAWNING
// the server's `command` (arbitrary local code — the real risk) plus exposing
// its declared tools to the model. The strings (server / command / tool
// names+descriptions) flow from an untrusted server manifest (or a config a
// hostile commit could edit), so the reducer sanitizes them at its boundary.
export type McpTrustAskEvent = BaseEvent & {
  type: 'mcp-trust:ask';
  promptId: string;
  server: string;
  command: string;
  // 'first-visit': never-seen manifest hash. 'drift': previously-trusted
  // server whose hash (tools or command) changed.
  mode: import('../mcp/types.ts').McpTrustMode;
  // A stdio server's UNRESOLVED env bindings + explicit cwd, rendered on their own
  // lines (a length-capped `command` could otherwise hide an injected env var).
  env?: readonly { name: string; value: string }[];
  cwd?: string;
  // Effective sandbox posture (MCP.md §2.3) — shown so the operator sees the
  // containment of the server they're authorizing.
  sandbox: import('../mcp/types.ts').McpSandboxStatus;
  tools: readonly { name: string; description: string; writes: boolean }[];
  manifestHash: string;
  // Pre-connect identity gate (MCP.md §1.5): authorize reaching the server before
  // the handshake. When true the modal shows only the identity (no tools/hash).
  preConnect?: boolean;
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

// User-scope second-confirm modal (spec MEMORY.md §7.2.5: "Memória
// user-global precisa dois prompts (write + escopo) — vai afetar
// todas as sessões, exige fricção extra"). Producer: `memory_write`
// tool fires this AFTER the first `memory:write:ask` resolves yes
// AND the proposed scope is `user`. Distinct event type rather than
// reusing `memory:write:ask` so the modal can render a
// scope-specific warning ("this memory will load in EVERY session
// on this machine") and the audit trail can distinguish first-
// vs-second-prompt rejection.
export type MemoryUserScopeAskEvent = BaseEvent & {
  type: 'memory:user-scope:ask';
  promptId: string;
  name: string;
  body: string;
};

// Generic confirmation modal for memory destructive / move
// operations (spec MEMORY.md §6.3 + §5.4 + §5.5). One flavor with
// caller-supplied copy lets `/memory delete`, `/memory promote
// shared`, and `/memory demote local` share the modal pipeline
// without each carrying a dedicated event type. The producer
// (slash command) constructs `title` / `subject` / `preview` to
// match the action; reducer just renders them. `action` lets
// audit trace which operator path opened the modal — distinct
// from `memory:write:ask` so the audit row's stage tag stays
// unambiguous.
export type MemoryActionAskEvent = BaseEvent & {
  type: 'memory:action:ask';
  promptId: string;
  // Discriminator for audit + telemetry. Reducer doesn't branch
  // on it; the slash command does to pick the right `action`
  // value when emitting the resulting `memory_events` row.
  action: 'delete' | 'promote' | 'demote' | 'restore' | 'quarantine';
  title: string;
  subject: string;
  preview: string[];
  // Question line under the preview ("Confirm delete?", "Promote
  // to shared?", etc.). Producer-supplied so the wording matches
  // the operation's verb tense.
  question: string;
};
// History wipe confirmation (HISTORY.md §2.3 `/history clear`). Three
// options: Yes (clear) / Yes-and-disable (clear + write
// `.forja/no-history`) / No. Default selection is the last (No),
// matching the conservative-default convention used by every other
// confirm flavor (D5/D65). `entryCount` lets the modal render the
// blast radius up front ("wipe N entries permanently") so the
// operator can't misclick into losing more than they meant to.
export type HistoryClearAskEvent = BaseEvent & {
  type: 'history-clear:ask';
  promptId: string;
  entryCount: number;
  // Absolute path of the project whose history would be wiped —
  // surfaced in the modal subject so an operator with multiple
  // REPLs open can tell which one they're confirming against.
  projectRoot: string;
};

// Resume-mode selection (resume "from summary" feature). Raised at boot when
// the operator runs `--resume <id>` interactively WITHOUT a `--resume-mode`
// flag: a confirm-flavor modal (flavor 'resume-mode') asking whether to load
// the full session or compact it first. Two options (Full session / From
// summary); Esc/cancel falls back to the capped default in the caller.
export type ResumeModeAskEvent = BaseEvent & {
  type: 'resumemode:ask';
  promptId: string;
  // Full persisted message count for the session — surfaced in the modal so
  // the operator can weigh "load all N" vs "compact".
  totalCount: number;
};

// Todo list (live region above the operation chips, spec §4.3 / §4.10.6).
// The full list is sent on every update — small enough that delta
// tracking buys nothing, and the producer (TodoStore.set wrapper in
// the harness loop) already deals in full lists per spec §7.4 ("o
// model passa a lista intencionada inteira; sem semantics de merge").
//
// Shape mirrors `TodoItem` in `src/todo/index.ts` exactly. Re-declared
// here instead of imported so the TUI layer doesn't depend on the
// todo subsystem's types — but the values must stay in sync. If the
// TodoStore enum changes, this union changes too.
//
// `failed` is reserved for forward-compat: spec §4.3 lists `✗ failed`
// as a glyph, the renderer wires it, but the TodoStore enum doesn't
// expose it today (the tool rejects invalid lists at write time, not
// at render time). A future extension that lets a step mark a todo as
// failed will surface here without a renderer change.
export type TodoStatusForUI = 'pending' | 'in_progress' | 'done' | 'failed';
export interface TodoItemForUI {
  content: string;
  activeForm: string;
  status: TodoStatusForUI;
}
export type TodoUpdateEvent = BaseEvent & {
  type: 'todo:update';
  items: TodoItemForUI[];
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
  // Cumulative cost reported by the child via the `cost_update`
  // HarnessEvent stream (spec ORCHESTRATION.md §3.5). Optional
  // because most progress events (step_start, tool_invoking,
  // etc.) don't carry cost; only the adapter's `cost_update`
  // case populates it. Reducer treats `undefined` as "no
  // change" — preserves the prior `liveCostUsd` rather than
  // zeroing.
  cumulativeCostUsd?: number;
  // The child's IN-FLIGHT tool, as a compact `read engine.ts` label
  // (short tool name + subject). Rendered on the live row's line 2.
  // Set on the child's `tool_invoking`; PERSISTS until the next tool
  // starts (deliberately NOT cleared on `toolDone`, so line 2 keeps
  // showing the last action during the gap between tools).
  // `undefined` on other progress events = "no change".
  currentTool?: string;
  // The tool NAME the child just finished. The reducer increments the
  // per-type aggregate (for the grouped scrollback trail on end) and
  // bumps the total. It does NOT touch `currentTool` (that persists
  // until the next tool starts). `undefined` = not a tool-finished
  // update.
  toolDone?: string;
};
export type SubagentEndEvent = BaseEvent & {
  type: 'subagent:end';
  subagentId: string;
  // Full harness status — `done` | `interrupted` | `exhausted` |
  // `error`. The renderer was previously collapsing this to
  // `done | error` and the operator lost the cause distinction
  // ("Did it run out of budget? Did I cancel it? Did the
  // provider blow up?"). Surface full status so the scrollback
  // chip can render an honest cause label.
  status: 'done' | 'interrupted' | 'exhausted' | 'error';
  // Stable reason code from the harness — `maxCostUsd`,
  // `maxSteps`, `maxWallClockMs`, `aborted`, `degenerate_loop`,
  // `providerError`, `done`, etc. Optional: older producers /
  // fallback paths may not set it. The renderer uses it to
  // refine the verb ("Exhausted (cost cap)" vs the bare
  // "Exhausted").
  reason?: string;
  // Child's authoritative spend at settle. Renderer surfaces
  // this in the chip when the run was budget-related so the
  // operator sees "spent $0.59 of a $0.30 cap" rather than just
  // "Failed".
  costUsd: number;
  summary: string;
  durationMs: number;
};

// Parallelism observability snapshot (spec ORCHESTRATION.md
// §1.3 / §3.3). Emitted every time the running / queued
// counts change (handle spawn / dispatch / settle for
// subagents; safeInvokeOne enter/exit for parallel tools).
// The footer's `subagents R+Q/cap` and `tools R/cap` chips
// read from `state.parallelStatus`, populated by the
// reducer on this event.
export type ParallelStatusEvent = BaseEvent & {
  type: 'parallel:status';
  subagentsRunning: number;
  subagentsQueued: number;
  subagentsCap: number;
  toolsRunning: number;
  toolsCap: number;
};

// Background processes.
export type BgStartEvent = BaseEvent & { type: 'bg:start'; processId: string; command: string };
export type BgUpdateEvent = BaseEvent & { type: 'bg:update'; processId: string; status: string };
// `cause` discriminates HOW the process ended:
//   - 'exited': natural exit (process returned without external signal).
//   - 'killed': operator-initiated termination (kill() or cleanup()).
// `exitCode` is the OS-reported value; null when the OS reaped before
// we could read it. `signal` (when present) carries the actual POSIX
// signal name (e.g. 'SIGTERM') — distinct from `cause`, which describes
// intent. Today no producer fills `signal`; the field is reserved for
// when the manager surfaces signal-derived exits explicitly.
export type BgEndEvent = BaseEvent & {
  type: 'bg:end';
  processId: string;
  cause: 'exited' | 'killed';
  exitCode: number | null;
  signal?: string;
};
// Pending-reminder count changed (ORCHESTRATION.md §3B.9). Emitted by
// the REPL whenever the ReminderScheduler's set changes (set / cancel /
// fire / cleanup). Carries the absolute new count — the reducer stores
// it directly, no per-id tracking needed for the footer chip.
export type RemindersUpdateEvent = BaseEvent & { type: 'reminders:update'; count: number };

// Budget / checkpoint signals consumed by the status line.
export type StepBudgetEvent = BaseEvent & {
  type: 'step:budget';
  steps: number;
  maxSteps: number;
  costUsd: number;
  maxCostUsd?: number;
};

// DB-derived usage totals for the footer's cost/token/cache chips.
// REPL-originated (not from the harness adapter): the REPL recomputes
// `computeUsageStats` over its session tree on every `usage_persisted`
// (one per model response — the harness's post-persist display cue),
// at each turn boundary, and on boot/resume, then emits
// this so the reducer SETS the footer fields
// (absolute values, not deltas). Single source of truth = the persisted
// DB, so the chips are tree-wide (incl. subagents) and resume-correct.
// `totalTokens` is the grand total (compute + cache); the footer renders
// `totalTokens - cacheTokens` as the non-cache chip beside `cacheTokens`.
export type StatsRefreshEvent = BaseEvent & {
  type: 'stats:refresh';
  costUsd: number;
  totalTokens: number;
  cacheTokens: number;
};

// Provider call lifecycle bracket — covers the gap between
// `step_start` (harness asked the provider for the next turn) and
// the first provider event landing on the renderer (text_delta /
// thinking_delta / tool_use_start). The harness adapter emits
// `provider:waiting:start` on step_start and
// `provider:waiting:end` on the first provider_event of that
// step.
//
// Without this bracket, a step where the model thinks for 30-60s
// (extended thinking with high max_tokens, slow cold start, model
// genuinely deliberating on a tool denial) shows nothing in the
// live region — operator perceives a hang. The waiting chip
// closes the visibility gap with an "Awaiting model… (Xs)"
// indicator that ticks while the provider call is in flight.
//
// Mutually exclusive with the thinking and assistant chips: once
// thinking_delta or text_delta arrives, the adapter emits the
// :end event AND the relevant start event in the same translate
// call, and the renderer's chip-slot picks the more specific
// indicator.
export type ProviderWaitingStartEvent = BaseEvent & {
  type: 'provider:waiting:start';
  stepN: number;
};
export type ProviderWaitingEndEvent = BaseEvent & {
  type: 'provider:waiting:end';
};
// Live "Compacting context…" chip bracket. `compacting:start` is emitted when a
// compaction begins — by /compact (operator-triggered) directly, and by
// the harness adapter on the loop's `compaction_started` (auto). Cleared
// by `compacting:end`. One bracket, both compaction surfaces, so the chip
// renders identically whether the operator forced it or the threshold did.
export type CompactingStartEvent = BaseEvent & {
  type: 'compacting:start';
};
export type CompactingEndEvent = BaseEvent & {
  type: 'compacting:end';
  // Whether the compaction actually changed the live context. The reducer marks
  // the context stale (suppressing the footer %) only when true — a no-op
  // 'skipped' / "nothing to compact" leaves the displayed % accurate.
  contextChanged?: boolean;
};
export type CheckpointCreateEvent = BaseEvent & {
  type: 'checkpoint:create';
  checkpointId: string;
  stepN: number;
};

// Wipe the visible scrollback (terminal Ctrl+L behavior). Renderer
// writes ANSI clear-screen + redraws the live region. Scrollback
// above the visible area stays accessible (xterm `\x1b[2J\x1b[H`
// doesn't touch it). Distinct from a session reset — LiveState is
// untouched.
export type ScreenClearEvent = BaseEvent & {
  type: 'screen:clear';
};

// Slash autocomplete state update. Spec UI.md §5.3. Producer (REPL
// editor handler) emits when input enters / exits slash mode or
// when navigation changes the highlighted suggestion. `suggestions`
// empty + selectedIdx -1 means "exit slash mode" (reducer clears
// state.slash to null). Otherwise the reducer mirrors the payload
// onto state.slash for the renderer.
export type SlashUpdateEvent = BaseEvent & {
  type: 'slash:update';
  suggestions: { name: string; description: string }[];
  selectedIdx: number;
  // Inline arg-hint ghost for an exactly-typed command with no args yet
  // (e.g. ` [low|medium|high]` after `/effort`). Undefined when there's
  // no exact match or the command takes no args. The renderer draws it
  // dim after the typed text, only when the cursor is at the line end.
  ghost?: string;
};

// Reverse-search overlay open/update. Spec HISTORY.md §2.2. Producer
// (REPL editor handler) emits on Ctrl+R (open / cycle), keystroke (re-
// search with the new query), or backspace (re-search with shorter
// query). Renderer mirrors the payload onto state.reverseSearch.
//
// `selectedIdx === -1` is the no-match shape — the line still renders
// with the typed query but appends `<empty>`. Closing the overlay is
// a separate event so producers don't need a sentinel shape.
export type ReverseSearchUpdateEvent = BaseEvent & {
  type: 'reverse-search:update';
  query: string;
  results: string[];
  selectedIdx: number;
};

// Reverse-search overlay close. Producer emits on Esc (cancel),
// Enter (accept + submit), or Tab (accept-to-edit). The reducer just
// drops state.reverseSearch — buffer mutation / submit are separate
// `input:update` / `user:submit` events the producer emits before
// closing.
export type ReverseSearchCloseEvent = BaseEvent & {
  type: 'reverse-search:close';
};

// Informational scrollback line. Spec UI.md §6.1 — not an error,
// not a warning; just plain output the renderer should not paint
// in any alarm color. Slash command output (/help, /sessions,
// /cost, etc.) uses this so the operator doesn't see help text in
// the same yellow as a lock-conflict warning.
//
// `tone` controls the paint: omitted/'plain' renders the message
// uncolored (the default — see permanent.ts for why info isn't
// colored like alerts); 'secondary' renders it in the greyscale
// meta channel (SGR 90), for lines that are visual scaffolding
// rather than content — e.g. the `--resume` history/new-turns
// anchor, which should recede, not compete with the conversation.
export type InfoEvent = BaseEvent & {
  type: 'info';
  message: string;
  tone?: 'plain' | 'secondary';
  // Optional title line rendered ABOVE the message in the DEFAULT tone,
  // regardless of `tone` — so a block can label itself (default) while its body
  // recedes (secondary). Used by the working-state panel.
  header?: string;
};

// Operator-initiated shell command (`!cmd` typed in the input). Runs as
// the operator's OWN shell — directly, not through the forja permission
// engine or sandbox — and reports the result here for scrollback. The
// engine gates the agent, not the human at the keyboard; this is the
// shell-style `!` escape. `output` is the combined stdout+stderr; the
// renderer caps very long output with a "+N more lines" tail.
export type OperatorBashDoneEvent = BaseEvent & {
  type: 'operator-bash:done';
  command: string;
  output: string;
  exitCode: number;
  durationMs: number;
};

// REPL busy-state transition. The REPL's `isBusy()` (a foreground turn
// OR an operator `!cmd` / /compact in flight) is the gate the submit
// path uses to refuse a new submission — but `operatorBashRunning` has
// no other reflection in LiveState. This event mirrors the combined
// predicate into the renderer so the bash-mode visuals can gate on the
// SAME condition the submit does (otherwise typing `!` during another
// `!` shows the shell UI for a command that Enter will refuse). Emitted
// only on actual
// transitions (deduped at the producer).
export type BusyChangeEvent = BaseEvent & {
  type: 'busy:change';
  busy: boolean;
};

// Recap terse line surfaced by RECAP §3.3 auto-display surfaces
// (session-end + Alt+R). Distinct from `info` so the renderer can
// style it specifically: bold "recap:" prefix, secondary
// (bright-grey) color across the line. The terse renderer's
// markdown body lands in `message`; the renderer wraps it.
export type RecapTerseEvent = BaseEvent & {
  type: 'recap:terse';
  message: string;
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

// Idle Ctrl+C double-tap exit gate (UI.md §5.4 + §4.10.6 footer cue).
// First press at idle/empty-buffer arms the gate; the footer flips to
// `Press Ctrl-C again to exit` (warn) for a 2s window. A second press inside
// the window exits 130; any other input or the timeout cancels.
//
// Producer responsibility: REPL emits `interrupt:exit-arm` on the first
// press, schedules a timer that emits `interrupt:exit-cancel` on
// expiry, and emits `interrupt:exit-cancel` on any other key/event
// that should disarm. Reducer is dumb — it just flips state.exitArmed.
export type InterruptExitArmEvent = BaseEvent & {
  type: 'interrupt:exit-arm';
};
export type InterruptExitCancelEvent = BaseEvent & {
  type: 'interrupt:exit-cancel';
};

// Discriminated union — the renderer matches on `type` and the
// compiler narrows the payload.
// Operator flipped the approval posture (Supervised ↔ Autonomous),
// shown in the footer in place of the help cue (UI.md §4.10.6). Emitted
// by the REPL when the operator toggles (Shift+Tab). The permission
// engine is the source of truth; this event mirrors the new posture
// into live state so the footer repaints.
export type OperationModeChangeEvent = BaseEvent & {
  type: 'mode:change';
  posture: ApprovalPosture;
};

// Operator toggled relay mode via `/relay`, shown as a footer badge. Emitted by
// the slash command so the badge repaints at once. meshManager.isServing() is
// the source of truth; this mirrors it into live state.
export type RelayChangeEvent = BaseEvent & {
  type: 'relay:change';
  active: boolean;
  alias: string | null;
};

// Operator changed the effort level via `/effort`, shown in the footer
// right cluster. Emitted by the slash command so the chip repaints
// immediately (the level takes effect next turn, but the operator's
// SELECTION is reflected at once). `baseConfig.effort` is the source of
// truth; this mirrors it into live state.
export type EffortChangeEvent = BaseEvent & {
  type: 'effort:change';
  effort: ForjaEffort;
};

export type UIEvent =
  | SessionStartEvent
  | OperationModeChangeEvent
  | RelayChangeEvent
  | EffortChangeEvent
  | SessionBannerEvent
  | SessionEndEvent
  | UserSubmitEvent
  | InputUpdateEvent
  | InboxQueuedEvent
  | InboxDrainedEvent
  | InboxEditStartEvent
  | InboxEditCommitEvent
  | InboxEditCancelEvent
  | InboxRemoveEvent
  | AssistantStartEvent
  | AssistantDeltaEvent
  | AssistantUsageEvent
  | AssistantEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolStartEvent
  | ToolExecutionStartedEvent
  | ToolDeltaEvent
  | ToolEndEvent
  | PermissionAskEvent
  | ModalAnswerEvent
  | ModalSelectEvent
  | ModalQueueDepthEvent
  | ClarifyAskEvent
  | TrustAskEvent
  | RelayStartAskEvent
  | SharedTrustAskEvent
  | McpTrustAskEvent
  | MemoryWriteAskEvent
  | ResumeModeAskEvent
  | MemoryUserScopeAskEvent
  | MemoryActionAskEvent
  | HistoryClearAskEvent
  | TodoUpdateEvent
  | SubagentStartEvent
  | SubagentUpdateEvent
  | SubagentEndEvent
  | ParallelStatusEvent
  | BgStartEvent
  | BgUpdateEvent
  | BgEndEvent
  | RemindersUpdateEvent
  | StepBudgetEvent
  | StatsRefreshEvent
  | ProviderWaitingStartEvent
  | ProviderWaitingEndEvent
  | CompactingStartEvent
  | CompactingEndEvent
  | CheckpointCreateEvent
  | ScreenClearEvent
  | SlashUpdateEvent
  | ReverseSearchUpdateEvent
  | ReverseSearchCloseEvent
  | InfoEvent
  | OperatorBashDoneEvent
  | BusyChangeEvent
  | RecapTerseEvent
  | ErrorEvent
  | WarnEvent
  | InterruptEvent
  | InterruptExitArmEvent
  | InterruptExitCancelEvent;

export type UIEventType = UIEvent['type'];

// Type-level helper: narrow UIEvent to a specific kind by its `type`.
export type UIEventOf<T extends UIEventType> = Extract<UIEvent, { type: T }>;
