// Adapter: HarnessEvent → UIEvent. Spec: UI.md §3 (the renderer's
// canonical event shape) plus harness/types.ts (`HarnessEvent`, the
// loop's emit shape). The harness fires lifecycle events and a stream
// of `provider_event`s; this module translates them into the UI's
// event vocabulary so the renderer + reducer can stay decoupled from
// the harness internals.
//
// Stateful: a small per-session struct tracks the active assistant
// message id (so `text_delta` events — which carry no id — can be
// attributed), the live thinking flag (so we know when to emit
// `thinking:end`), per-toolUseId metadata (so `tool_finished` knows
// the tool name and prior decision), and a running step count.
// Construct one adapter per harness run; close it implicitly by
// dropping the reference at session_finished.
//
// Anything the renderer doesn't understand goes through as a `warn`
// — better a one-line scrollback note than silent loss.

import type { ExitReason, HarnessEvent } from '../harness/types.ts';
import type { Decision } from '../permissions/index.ts';
import type { TodoItem, TodoStatus } from '../todo/index.ts';
import type { SessionEndEvent, TodoItemForUI, TodoStatusForUI, UIEvent } from './events.ts';
import { lookupToolVocab } from './tool-vocab.ts';

// Compile-time fence: every TodoStore status must be representable as
// a TodoItemForUI status. The `satisfies` makes the relationship
// explicit — if `src/todo/index.ts` adds a new variant (e.g. 'blocked')
// without also adding it to `TodoStatusForUI`, this constant fails to
// type-check and the build breaks. The runtime value is unused; the
// presence of the assertion is the contract.
const _STATUS_FENCE: TodoStatus[] = ['pending', 'in_progress', 'done'] satisfies TodoStatus[];
void (_STATUS_FENCE as TodoStatusForUI[]);

// Explicit per-field map. The shapes happen to be structurally
// identical today but pass-through assignment (`items: event.items`)
// would silently accept a future store extension that adds a status
// the renderer's GLYPHS table can't handle, producing `undefined`
// glyph strings. Mapping per-field keeps the contract narrow.
const mapTodoItem = (item: TodoItem): TodoItemForUI => ({
  content: item.content,
  activeForm: item.activeForm,
  status: item.status,
});

export interface HarnessAdapterCtx {
  // Status-line metadata. Not derivable from HarnessEvent: the harness
  // doesn't carry profile/project/model in its event payloads (only the
  // sessionId), so the caller threads them in here. Read once, on
  // `session_start`, and forwarded into the `session:start` UIEvent.
  profile: 'autonomous' | 'orchestrated' | 'hybrid';
  project: string;
  model: string;
  // Hard-cap for the run. Used to populate `step:budget` events so the
  // status line can render "step N / max" before the harness finishes.
  // The harness has the same value internally but never echoes it; we
  // accept it from the caller (CLI bootstrap knows the budget).
  maxSteps: number;
  // Optional spend cap. Mirrored into `step:budget.maxCostUsd`. Absent
  // means no cap — renderer shows steps/cost without budget shading.
  maxCostUsd?: number;
  // Plan mode — read-only profile, harness refuses write tools.
  // Forwarded into `session:start.planMode` so the footer can show
  // the `plan` indicator. Defaults to false (full-write profile).
  planMode?: boolean;
  // Wall-clock source. Production = Date.now; tests inject a counter.
  // Every emitted UIEvent stamps `ts` from this so renderers can show
  // "elapsed" without holding their own clock.
  now?: () => number;
}

export interface HarnessAdapter {
  // Translate a single harness event into zero or more UI events.
  // Returning [] is normal — many harness events (step_start without
  // a prior session_start, ack-style notifications) don't need a UI
  // surface.
  translate: (event: HarnessEvent) => UIEvent[];
}

interface ToolTrack {
  name: string;
  decision: Decision | null;
}

interface AdapterState {
  // Assistant message currently being streamed. Set on provider `start`,
  // cleared on `stop`. `text_delta` and `thinking_delta` carry no id
  // and inherit this one.
  currentMessageId: string | null;
  // True between the first `thinking_delta` of an assistant turn and
  // the corresponding `stop` (or any `text_delta` that interrupts).
  // Kept separate from `currentMessageId` because thinking can finish
  // before text starts.
  thinkingActive: boolean;
  // Tool calls in flight. Keyed by toolUseId. Populated on
  // `tool_invoking`, mutated on `tool_decided`, drained on
  // `tool_finished`.
  tools: Map<string, ToolTrack>;
  // Cumulative step counter for `step:budget`. Bumped on `step_start`.
  steps: number;
  // Cumulative cost. The harness reports cost only at session_finished
  // (and per-compaction). We expose the running total when we have it
  // — for now it stays 0 mid-run and the final session:end carries no
  // cost field anyway. Kept here so a future patch that surfaces
  // running cost on step_start has a place to live.
  costUsd: number;
}

// Map the harness's exit reason to the renderer's `session:end.reason`.
// The UI catalogue (events.ts) accepts a fixed set plus arbitrary
// string fallback; we collapse adverse exits into 'error' and let the
// detail appear in a separate `warn` line emitted alongside.
const mapExitReason = (reason: ExitReason): SessionEndEvent['reason'] => {
  switch (reason) {
    case 'done':
    case 'aborted':
    case 'maxSteps':
    case 'maxCostUsd':
      return reason;
    default:
      return 'error';
  }
};

export const createHarnessAdapter = (ctx: HarnessAdapterCtx): HarnessAdapter => {
  const now = ctx.now ?? (() => Date.now());

  const state: AdapterState = {
    currentMessageId: null,
    thinkingActive: false,
    tools: new Map(),
    steps: 0,
    costUsd: 0,
  };

  // Closing a thinking window is a frequent micro-step (any text or
  // turn end). Centralized here so the bookkeeping stays in one place.
  const endThinking = (ts: number, out: UIEvent[]): void => {
    if (!state.thinkingActive) return;
    const messageId = state.currentMessageId ?? 'unknown';
    state.thinkingActive = false;
    out.push({ type: 'thinking:end', ts, messageId });
  };

  // End any open assistant message at the boundary the provider stop
  // event signals. Idempotent: a stop with no prior start is a no-op.
  const endAssistant = (ts: number, out: UIEvent[]): void => {
    if (state.currentMessageId === null) return;
    const messageId = state.currentMessageId;
    state.currentMessageId = null;
    out.push({ type: 'assistant:end', ts, messageId });
  };

  const translate = (event: HarnessEvent): UIEvent[] => {
    const ts = now();
    const out: UIEvent[] = [];

    switch (event.type) {
      case 'session_start': {
        out.push({
          type: 'session:start',
          ts,
          sessionId: event.sessionId,
          profile: ctx.profile,
          project: ctx.project,
          model: ctx.model,
          ...(ctx.planMode === true ? { planMode: true } : {}),
        });
        // Initial step:budget so the status line shows "0/N · $0" from
        // the very first frame instead of waiting on step_start.
        out.push({
          type: 'step:budget',
          ts,
          steps: 0,
          maxSteps: ctx.maxSteps,
          costUsd: 0,
          ...(ctx.maxCostUsd !== undefined ? { maxCostUsd: ctx.maxCostUsd } : {}),
        });
        return out;
      }

      case 'resume_truncated':
        out.push({
          type: 'warn',
          ts,
          message: `resumed with ${event.kept} of ${event.kept + event.dropped} messages (${event.dropped} dropped)`,
        });
        return out;

      case 'step_start': {
        state.steps = event.stepN;
        out.push({
          type: 'step:budget',
          ts,
          steps: state.steps,
          maxSteps: ctx.maxSteps,
          costUsd: state.costUsd,
          ...(ctx.maxCostUsd !== undefined ? { maxCostUsd: ctx.maxCostUsd } : {}),
        });
        return out;
      }

      case 'provider_event': {
        const ev = event.event;
        switch (ev.kind) {
          case 'start':
            // Close any leftover assistant from the prior turn before
            // opening a new one. Defensive — providers should send a
            // `stop` between turns, but a malformed stream shouldn't
            // strand the renderer with a stuck pendingAssistant.
            endThinking(ts, out);
            endAssistant(ts, out);
            state.currentMessageId = ev.message_id;
            out.push({ type: 'assistant:start', ts, messageId: ev.message_id });
            return out;

          case 'text_delta': {
            // Late text without a prior `start` shouldn't happen, but
            // if it does we emit assistant:start lazily so the
            // reducer's late-delta handler sees a coherent stream.
            // Also closes thinking — text and thinking are mutually
            // exclusive within a turn for renderer purposes.
            endThinking(ts, out);
            if (state.currentMessageId === null) {
              const synthId = `unknown-${ts}`;
              state.currentMessageId = synthId;
              out.push({ type: 'assistant:start', ts, messageId: synthId });
            }
            out.push({
              type: 'assistant:delta',
              ts,
              messageId: state.currentMessageId,
              text: ev.text,
            });
            return out;
          }

          case 'thinking_delta': {
            const messageId = state.currentMessageId ?? `unknown-${ts}`;
            if (!state.thinkingActive) {
              state.thinkingActive = true;
              out.push({ type: 'thinking:start', ts, messageId });
            }
            out.push({ type: 'thinking:delta', ts, messageId, text: ev.text });
            return out;
          }

          case 'tool_use_start':
          case 'tool_use_delta':
          case 'tool_use_stop':
            // Tool lifecycle is surfaced via `tool_invoking` /
            // `tool_decided` / `tool_finished` (which fire AFTER the
            // provider stream ends and decision/execution happen).
            // Emitting tool:start from the provider stream too would
            // double-render the tool card.
            return out;

          case 'usage': {
            // Spec UI.md §4.10.5: live "Generating…" chip shows
            // `(Xs · ↑ N tokens)` once usage lands; final scrollback
            // line shows `Generated N tokens in Xs`. Cost folding is
            // still a harness concern (step:budget carries cost),
            // but token counts deserve their own UIEvent so the
            // renderer can drive both the live counter and the
            // scrollback chip from the same signal.
            //
            // Anthropic emits this on message_start AND message_stop
            // (cumulative); OpenAI emits once at stop. Both shapes
            // collapse to "latest count is canonical" — the reducer
            // monotonic-merges if multiple events arrive within a
            // turn. Inherits the current message id; if usage somehow
            // arrives before assistant:start (out-of-order), we drop
            // it rather than synthesizing a turn — better to lose
            // one counter update than to spawn a stub assistant.
            if (state.currentMessageId === null) return out;
            out.push({
              type: 'assistant:usage',
              ts,
              messageId: state.currentMessageId,
              inputTokens: ev.usage.input,
              outputTokens: ev.usage.output,
              cacheRead: ev.usage.cache_read,
              cacheCreation: ev.usage.cache_creation,
            });
            return out;
          }

          case 'stop':
            endThinking(ts, out);
            endAssistant(ts, out);
            return out;

          case 'error':
            out.push({
              type: 'error',
              ts,
              message: `[${ev.code}] ${ev.message}`,
              ...(ev.retryable ? {} : { fatal: true }),
            });
            return out;
        }
        return out;
      }

      case 'tool_invoking': {
        const vocab = lookupToolVocab(event.toolName);
        // Best-effort subject extraction. Subject extractors return
        // null when args don't carry the expected field (malformed
        // model output) — UI drops the connector line.
        let subject: string | null = null;
        try {
          subject = vocab.subject?.(event.args) ?? null;
        } catch {
          // Defensive: a vocab extractor that throws on weird shapes
          // shouldn't break the whole tool:start emission. Fall
          // through with null subject.
          subject = null;
        }
        state.tools.set(event.toolUseId, {
          name: event.toolName,
          decision: null,
        });
        out.push({
          type: 'tool:start',
          ts,
          toolId: event.toolUseId,
          name: event.toolName,
          activeVerb: vocab.activeVerb,
          finalVerb: vocab.finalVerb,
          subject,
        });
        return out;
      }

      case 'tool_decided': {
        const tool = state.tools.get(event.toolUseId);
        if (tool !== undefined) tool.decision = event.decision;
        // The decision itself doesn't get its own UIEvent — the
        // outcome surfaces on `tool_finished` (status: 'denied' for
        // deny, 'done'/'error' otherwise). This avoids adding an
        // event the reducer would have to no-op.
        return out;
      }

      case 'tool_finished': {
        const tool = state.tools.get(event.toolUseId);
        const decisionKind = tool?.decision?.kind;
        const status: 'done' | 'error' | 'denied' =
          decisionKind === 'deny' ? 'denied' : event.failed ? 'error' : 'done';
        state.tools.delete(event.toolUseId);
        out.push({
          type: 'tool:end',
          ts,
          toolId: event.toolUseId,
          status,
          durationMs: event.durationMs,
        });
        return out;
      }

      case 'compaction_started':
        out.push({
          type: 'warn',
          ts,
          message: `compacting context (~${event.promptTokens} tokens > ${Math.round(event.threshold)} threshold)`,
        });
        return out;

      case 'compaction_finished': {
        if (event.strategy === 'skipped') return out;
        const detail = event.reason !== undefined ? ` — ${event.reason}` : '';
        out.push({
          type: 'warn',
          ts,
          message: `compaction ${event.strategy}: folded ${event.foldedCount} message(s) in ${event.durationMs}ms${detail}`,
        });
        return out;
      }

      case 'checkpoint_created': {
        out.push({
          type: 'checkpoint:create',
          ts,
          checkpointId: event.checkpointId,
          stepN: state.steps,
        });
        if (event.hadBash) {
          out.push({
            type: 'warn',
            ts,
            message: `checkpoint ${event.checkpointId.slice(0, 8)} includes bash side effects (--undo won't reverse them)`,
          });
        }
        return out;
      }

      case 'bg_started':
        // Pass-through: UIEvent.bg:start mirrors the HarnessEvent
        // shape one-for-one (processId + command). Label is dropped
        // — the renderer's footer counter doesn't surface it today;
        // a future "expanded bg tray" panel would extend the
        // UIEvent and re-thread it.
        out.push({
          type: 'bg:start',
          ts,
          processId: event.processId,
          command: event.command,
        });
        return out;

      case 'bg_ended':
        // Pass-through: HarnessEvent.bg_ended.status (intent) maps
        // 1:1 to UIEvent.bg:end.cause. The `signal` field on the
        // UIEvent is reserved for actual POSIX signal names (e.g.
        // 'SIGTERM') — today the manager doesn't carry that, so
        // we leave it undefined.
        out.push({
          type: 'bg:end',
          ts,
          processId: event.processId,
          cause: event.status,
          exitCode: event.exitCode,
        });
        return out;

      case 'todo_updated':
        // Per-field map via mapTodoItem so a future TodoStore status
        // variant fails to type-check rather than silently rendering
        // `undefined` glyphs. Renderer's reducer handles full-replace
        // semantics (spec §7.4).
        out.push({
          type: 'todo:update',
          ts,
          items: event.items.map(mapTodoItem),
        });
        return out;

      case 'checkpoints_unavailable':
        out.push({
          type: 'warn',
          ts,
          message: `checkpoints disabled: ${event.reason}`,
        });
        return out;

      case 'session_finished': {
        // Make sure no streaming state leaks past the end. A run
        // killed mid-turn (interrupt, provider error) won't have
        // emitted `stop`; close out anything still open.
        endThinking(ts, out);
        endAssistant(ts, out);
        const r = event.result;
        // Final step:budget so the status line lands on the actual
        // final cost, not the last mid-run estimate.
        out.push({
          type: 'step:budget',
          ts,
          steps: r.steps,
          maxSteps: ctx.maxSteps,
          costUsd: r.costUsd,
          ...(ctx.maxCostUsd !== undefined ? { maxCostUsd: ctx.maxCostUsd } : {}),
        });
        // Adverse exits: emit a `warn` carrying the reason detail
        // before the terminating `session:end`. The renderer already
        // surfaces session:end on the footer; the warn line gives
        // the user the "why" without overloading session:end's
        // shape.
        const mapped = mapExitReason(r.reason);
        if (mapped === 'error') {
          const detail = r.detail !== undefined ? ` — ${r.detail}` : '';
          out.push({
            type: 'warn',
            ts,
            message: `exit ${r.reason}${detail}`,
          });
        }
        out.push({
          type: 'session:end',
          ts,
          sessionId: r.sessionId,
          reason: mapped,
        });
        return out;
      }
    }
  };

  return { translate };
};
