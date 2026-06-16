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

import { forjaCommand } from '../cli/forja-command.ts';
import type { FileDiff } from '../diff/line-diff.ts';
import type { ExitReason, HarnessEvent } from '../harness/types.ts';
import type { Decision } from '../permissions/index.ts';
import { sanitizeOneLineForDisplay, stripAnsi } from '../sanitize/index.ts';
import type { SessionEndEvent, TodoItemForUI, UIEvent } from './events.ts';
import { formatWorkingStatePanel } from './render/working-state.ts';
import { lookupToolVocab, shortToolName } from './tool-vocab.ts';

export interface HarnessAdapterCtx {
  // Status-line metadata. Not derivable from HarnessEvent: the harness
  // doesn't carry project/model in its event payloads (only the
  // sessionId), so the caller threads them in here. Read once, on
  // `session_start`, and forwarded into the `session:start` UIEvent.
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
  // Distinct-name memory count at session boot. Forwarded into
  // `session:start.memoryCount` so the
  // footer can render the `mem N` segment. Caller (REPL) reads
  // it from `MemoryRegistry.count({ deduplicateByName: true })`.
  // Optional: when memory wasn't wired (one-shot SDK without
  // memoryRegistry), the segment is suppressed.
  memoryCount?: number;
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
  // Display diff stashed from a `tool_diff` event; attached to the
  // `tool:end` UIEvent when the tool finishes.
  diff?: FileDiff;
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
  // True between `step_start` (we emitted `provider:waiting:start`)
  // and the first `provider_event` of that step (we emit
  // `provider:waiting:end` once and clear). Without this gate, every
  // provider event would re-emit the end UIEvent — minor noise but
  // unnecessary since the reducer is already idempotent on
  // null. The flag also short-circuits the per-event check
  // cheaper than always pushing.
  providerWaiting: boolean;
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
//
// Operator-driven terminations pass the harness reason through
// verbatim — `aborted` (Ctrl+C / wall-clock) was the original case;
// `userPromptBlocked` (a UserPromptSubmit hook refused the turn)
// belongs in the same family. Both map to
// TerminalSessionStatus='interrupted' at the harness layer (see
// loop.ts exitToStatus); collapsing them to 'error' here misled
// the renderer's "exit X — Y" warn line into reading like a
// failure when the operator deliberately stopped the turn.
const mapExitReason = (reason: ExitReason): SessionEndEvent['reason'] => {
  switch (reason) {
    case 'done':
    case 'aborted':
    case 'maxSteps':
    case 'maxCostUsd':
    case 'userPromptBlocked':
      return reason;
    default:
      return 'error';
  }
};

// Flatten a tool subject to a single display line. A multi-line shell
// command (`a && \n for d in …; do …`, heredocs) carries literal
// newlines straight from the model's args; rendered as the live card's
// `└─ <subject>` line, a raw `\n` makes ONE live-region array element
// span TWO terminal rows, breaking the renderer's one-element-per-row
// erase math and leaking a stale card into scrollback. Collapse each
// line break (and the whitespace hugging it) to a single space.
// Intra-line spacing and single-line subjects (file paths, patterns)
// are left untouched. Applied to the top-level tool:start path. (The
// subagent row's line-2 `currentTool` uses sanitizeOneLineForDisplay
// instead — it additionally strips ANSI/C0 control bytes, since that
// label re-renders into the live region every heartbeat tick.)
const flattenSubject = (subject: string | null): string | null =>
  subject?.includes('\n') ? subject.replace(/\s*\n\s*/g, ' ').trim() : subject;

export const createHarnessAdapter = (ctx: HarnessAdapterCtx): HarnessAdapter => {
  const now = ctx.now ?? (() => Date.now());

  const state: AdapterState = {
    currentMessageId: null,
    thinkingActive: false,
    tools: new Map(),
    steps: 0,
    costUsd: 0,
    providerWaiting: false,
  };

  // Close the "Awaiting model" indicator. Called from the
  // `provider_event` case the first time per step, and from the
  // `step_start` case BEFORE opening a new one (defense in depth:
  // a step that fires `step_start` twice without a provider event
  // in between — bug or replay edge — wouldn't leak a stale gate).
  const endProviderWaiting = (ts: number, out: UIEvent[]): void => {
    if (!state.providerWaiting) return;
    state.providerWaiting = false;
    out.push({ type: 'provider:waiting:end', ts });
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
          project: ctx.project,
          model: ctx.model,
          ...(ctx.memoryCount !== undefined ? { memoryCount: ctx.memoryCount } : {}),
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

      case 'resume_rehydrated': {
        // Visibility line per STATE_MACHINE.md §7.6:
        // `🔄 Resumed from <status> — N decisions, M pins, K todos rehydrated`.
        // `degraded` produces a different shape so the operator
        // sees that the rehydrate had no payload (typical: Stop
        // hook never ran, recap_cache empty, projection caught
        // an empty session).
        const message = event.degraded
          ? `resumed from ${event.previousStatus} — rehydrate degraded (no recap signal in audit log)`
          : `resumed from ${event.previousStatus} — ${event.decisionCount} decisions, ${event.pinCount} pins, ${event.todoCount} todos rehydrated${
              event.truncated ? ' (truncated to fit budget)' : ''
            }`;
        out.push({ type: 'info', ts, message });
        return out;
      }

      case 'resume_rehydrate_failed':
        // Auto-rehydrate skipped due to a projection / DB error.
        // Resume itself proceeded; the operator just doesn't get
        // the `[resume_context]` block this time. Surface as
        // `warn` (not `error`) — the session is functional, the
        // diagnostic is informational.
        out.push({
          type: 'warn',
          ts,
          message: `auto-rehydrate skipped: ${event.reason} (resume continues without the [resume_context] block)`,
        });
        return out;

      case 'recap_terse_ready': {
        // Session-end terse line (RECAP.md §3.3). Surface as a
        // dedicated `recap:terse` UIEvent so the renderer styles
        // it (bold "recap:" prefix + secondary color across the
        // line) instead of the plain `info` shape used for slash
        // output. The terse template emits a single sentence
        // ≤ 200 chars (with trailing newline) — split on newline
        // and drop empties so we don't render a blank styled line.
        const lines = event.markdown.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          out.push({ type: 'recap:terse', ts, message: line });
        }
        return out;
      }

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
        // Defensive close before re-opening: a malformed event
        // stream (two step_starts back to back without a
        // provider event between) would otherwise stack two
        // open gates and miss one of the closes.
        endProviderWaiting(ts, out);
        // Open the "Awaiting model" indicator. The harness has
        // just handed the request to the provider; the next visible
        // signal is the first provider event (text_delta /
        // thinking_delta / tool_use_start), which can take
        // 30-60s on extended-thinking turns. Without this chip the
        // operator sees nothing during the wait and reaches for
        // Ctrl-C before the step-stall watchdog (90s default)
        // would have caught a real hang.
        state.providerWaiting = true;
        out.push({ type: 'provider:waiting:start', ts, stepN: event.stepN });
        return out;
      }

      case 'provider_event': {
        // First provider event of the step closes the "Awaiting
        // model" indicator. The reducer also clears on
        // assistant:start / thinking:start (defense in depth), but
        // closing here covers cases where the very first event is
        // a tool_use_start (no assistant content at all — the
        // model went straight to tools).
        endProviderWaiting(ts, out);
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
            // Strip ANSI before the text reaches the reducer / renderer.
            // Provider output can carry escape sequences (model quoting
            // file contents, code about terminal codes, prompt-injection
            // attempts) which would otherwise be written raw to the
            // terminal. The most damaging classes are DEC private modes
            // (`\x1b[?2004h` enables bracketed paste, `\x1b[?25l` hides
            // the cursor, `\x1b[?1049h` switches to the alt screen, etc.)
            // — operator perceives input as frozen because keystrokes
            // get reinterpreted or feedback goes invisible. Strip on
            // entry so every downstream surface (live chip preview,
            // permanent assistant block, recap snapshots) sees clean
            // text without each having to remember to sanitize.
            out.push({
              type: 'assistant:delta',
              ts,
              messageId: state.currentMessageId,
              text: stripAnsi(ev.text),
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
        subject = flattenSubject(subject);
        state.tools.set(event.toolUseId, {
          name: event.toolName,
          decision: null,
        });
        // `silent` vocab entries (the todo tools) are tracked in
        // state.tools above but emit NO chip — the live `Tasks` block is
        // the operator's view of todos, so the per-call chips are noise.
        if (!vocab.silent) {
          out.push({
            type: 'tool:start',
            ts,
            toolId: event.toolUseId,
            name: event.toolName,
            activeVerb: vocab.activeVerb,
            finalVerb: vocab.finalVerb,
            subject,
          });
        }
        return out;
      }

      case 'tool_execution_started': {
        // No card was emitted for a silent tool, so there's nothing to
        // rebase — skip its execution-started too.
        const tracked = state.tools.get(event.toolUseId);
        if (tracked === undefined || !lookupToolVocab(tracked.name).silent) {
          out.push({ type: 'tool:execution-started', ts, toolId: event.toolUseId });
        }
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

      case 'tool_warning': {
        // Tool surfaced a non-error notice mid-execution (today:
        // memory_read flagging an untrusted body per spec §7.2.7).
        // Translate to a generic `warn` UIEvent so the live region
        // renders it in the warn palette. The toolUseId stays in
        // the harness-side event for NDJSON consumers; the UI
        // event is intentionally generic so the renderer doesn't
        // need per-tool branches. Operators see "[memory:
        // untrusted] loaded foo" inline in scrollback, the same
        // shape as any other warn line.
        out.push({
          type: 'warn',
          ts,
          message: event.message,
        });
        return out;
      }

      case 'tool_diff': {
        // Display-only: stash the diff on the active tool record. It
        // rides out on the tool's `tool:end` UIEvent; no UIEvent now.
        const tool = state.tools.get(event.toolUseId);
        if (tool !== undefined) tool.diff = event.diff;
        return out;
      }

      case 'tool_finished': {
        const tool = state.tools.get(event.toolUseId);
        const decisionKind = tool?.decision?.kind;
        // `denied` is authoritative — set true for ANY denial path
        // (policy deny, user-rejected confirm). Without it, a
        // user-rejected confirm has decision.kind === 'confirm' and
        // failed === true, and the legacy decision-kind check would
        // map to 'error' — wrong: it's a denial, not a tool failure.
        // Falls back to decision.kind === 'deny' so older producers
        // (events synthesized in tests, future replay paths) still
        // resolve correctly.
        const status: 'done' | 'error' | 'denied' = event.denied
          ? 'denied'
          : decisionKind === 'deny'
            ? 'denied'
            : event.failed
              ? 'error'
              : 'done';
        // Surface the failure reason in the scrollback chip's
        // sub-line. For denied: the engine's deny reason (or
        // "rejected at confirmation prompt" when the user said no
        // at the modal). For error: the harness's `errorMessage`
        // (set by invokeTool for unknown tools, ToolError returns,
        // or wrapped exceptions). Without this, the operator sees
        // "Failed" / "Denied" with no explanation — a strict
        // default-deny policy looks like a bug, and a tool error
        // is just a path with no diagnosis. The renderer routes
        // `summary` to the `└─` connector for non-done chips
        // (render/permanent.ts §4.1).
        let summary: string | undefined;
        if (status === 'denied' && tool?.decision !== undefined && tool.decision !== null) {
          const decision = tool.decision;
          if (decision.kind === 'deny') {
            summary = decision.reason;
          } else if (decision.kind === 'confirm') {
            // User said no at the modal. The decision's `reason` (if
            // any) describes the engine's match, not the user's
            // choice — surface the choice instead.
            summary = 'rejected at confirmation prompt';
          }
        } else if (status === 'error' && event.errorMessage !== undefined) {
          summary = event.errorMessage;
        } else if (status === 'done' && event.resultDetail !== undefined) {
          // A successful tool surfaced a one-line display detail
          // (clarify's question→answer). Route it through the same
          // `summary` slot the failure reasons use: render/permanent
          // shows `summary` on the `└─` connector of a done chip when
          // the tool has no vocab subject, which clarify doesn't.
          summary = event.resultDetail;
        }
        state.tools.delete(event.toolUseId);
        // Silent tools emit no SUCCESS chip — see the tool:start case. Todos
        // hide their failures too (the model surfaces them in prose and the
        // live `Tasks` block reflects state). A `revealFailure` silent tool
        // (the task_* delegation family) instead SURFACES a failed finish: a
        // delegation that dies before its child is created (unknown playbook,
        // validation error, pre-spawn budget refusal) emits no subagent
        // lifecycle, so the `Subagents` block has nothing to show and dropping
        // the failure chip too would make the failed delegation invisible.
        const vocab = lookupToolVocab(event.toolName);
        const reveal = vocab.silent === true && vocab.revealFailure === true && status !== 'done';
        if (!vocab.silent || reveal) {
          // A silent tool emitted no tool:start, so a lone tool:end would
          // no-op in the reducer (it finalizes a card that was never opened —
          // state.ts tool:end returns empty on an unknown toolId). Synthesize
          // the opening card here, in the SAME batch, so the failed chip
          // renders; the reducer pairs start+end by toolId. No live noise: the
          // pair collapses straight to the scrollback failure chip.
          if (reveal) {
            out.push({
              type: 'tool:start',
              ts,
              toolId: event.toolUseId,
              name: event.toolName,
              activeVerb: vocab.activeVerb,
              finalVerb: vocab.finalVerb,
              subject: null,
            });
          }
          out.push({
            type: 'tool:end',
            ts,
            toolId: event.toolUseId,
            status,
            durationMs: event.durationMs,
            ...(summary !== undefined ? { summary } : {}),
            ...(event.outputTruncated === true ? { outputTruncated: true } : {}),
            ...(tool?.diff !== undefined ? { diff: tool.diff } : {}),
            ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          });
        }
        return out;
      }

      case 'compaction_started':
        // Live chip (transient) + a scrollback warn (the record). The chip
        // is the same one /compact shows — one bracket, both surfaces.
        out.push({ type: 'compacting:start', ts });
        out.push({
          type: 'warn',
          ts,
          message: `compacting context (~${event.promptTokens} tokens > ${Math.round(event.threshold)} threshold)`,
        });
        return out;

      case 'compaction_finished': {
        // Close the chip first — even on 'skipped', which returns early
        // below before pushing the warn.
        out.push({ type: 'compacting:end', ts, contextChanged: event.strategy !== 'skipped' });
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
          // Not the yellow warn channel: this is a passive caveat about the
          // checkpoint's reversibility, not an actionable alert. It rides the
          // info channel in `secondary` (greyscale) so it recedes rather than
          // reading as an alarm the operator must act on.
          out.push({
            type: 'info',
            ts,
            tone: 'secondary',
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

      case 'todo_updated': {
        // Per-field map + drop soft-deleted rows: `removed` items stay in
        // the store (id never recycled) but are invisible to the UI. The
        // `=== 'removed'` guard also narrows the status to the
        // TodoStatusForUI subset, so the inline build type-checks without
        // `removed` leaking into the renderer's GLYPHS — and any OTHER new
        // status that isn't representable in the UI fails to compile here.
        // Reducer handles full-replace semantics (spec §7.4).
        const items: TodoItemForUI[] = [];
        for (const item of event.items) {
          if (item.status === 'removed') continue;
          items.push({ content: item.content, activeForm: item.activeForm, status: item.status });
        }
        out.push({ type: 'todo:update', ts, items });
        return out;
      }

      case 'working_state_updated': {
        // Render the current panel as a scrollback `info` block — focus / next /
        // open hypotheses (not the log; that's history). The per-call tool chip
        // is silent (TOOL_VOCAB), so this event IS the operator-facing feedback.
        // A FAILED update never reaches here (the store didn't mutate, so no
        // event fires) — it surfaces via the tool's `revealFailure` chip
        // instead. Skip when the panel has nothing operational to show.
        // Header stays DEFAULT tone (labels the update); the body is the
        // `secondary` grey meta channel — operational scaffolding that recedes,
        // not primary content.
        const panel = formatWorkingStatePanel(event.state);
        if (panel !== null) {
          out.push({
            type: 'info',
            ts,
            header: panel.header,
            message: panel.body,
            tone: 'secondary',
          });
        }
        return out;
      }

      case 'checkpoints_unavailable':
        out.push({
          type: 'warn',
          ts,
          message: `checkpoints disabled: ${event.reason}`,
        });
        return out;

      case 'sandbox_degraded_active': {
        // §13.6 degraded banner (slice 92). Non-suppressible
        // operator-facing warning. First emission uses a stronger
        // "no longer available" headline; recurring nudges use
        // "still" so operators see whether the issue has been
        // freshly detected vs is ongoing.
        const reasonSuffix = event.reason.length > 0 ? ` (${event.reason})` : '';
        const headline = event.firstEmission
          ? `⚠ Sandbox no longer available${reasonSuffix}`
          : `⚠ Sandbox still unavailable${reasonSuffix}`;
        out.push({ type: 'warn', ts, message: headline });
        out.push({
          type: 'warn',
          ts,
          message: '  All tool calls now require manual confirmation.',
        });
        out.push({
          type: 'warn',
          ts,
          message: `  Run '${forjaCommand('doctor')}' to investigate.`,
        });
        return out;
      }

      case 'subagent_start':
        // Pass-through into the existing UIEvent shape (defined in
        // events.ts). The harness producer carries `prompt` (the
        // raw seed text the model passed); the UIEvent calls it
        // `goal` to match the spec UI.md vocabulary — "what is
        // this child doing for me?". Renderer truncates upstream;
        // we forward verbatim.
        out.push({
          type: 'subagent:start',
          ts,
          subagentId: event.subagentId,
          name: event.name,
          goal: event.prompt,
        });
        return out;

      case 'subagent_progress': {
        // Compose a one-liner from the most recent child
        // HarnessEvent. We don't carry the full child event
        // through to the UI — the parent's renderer has no
        // business modeling the child's full state. Coalescing
        // happens here so the reducer / renderer stay simple.
        // Format aims for "what's the child doing right now"
        // not "what just happened" — present tense, present
        // detail.
        const inner = event.lastEvent;
        // Quiet inner: the child's per-response display cue is for
        // the parent REPL's stats refresh (handled before the
        // adapter), not for the heartbeat text — the default arm
        // below would print a noisy literal 'usage_persisted' after
        // every child response.
        if (inner.type === 'usage_persisted') return out;
        let progress: string;
        // Optional live-cost piggyback (D232). When the inner
        // event is `cost_update`, the cumulative figure flows
        // through to the reducer for the per-row `$X.XX` chip.
        // Skipped for other inner events to leave `liveCostUsd`
        // alone (semantics: undefined = "no change").
        let cumulativeCostUsd: number | undefined;
        // The child's tools no longer stream into scrollback live — they
        // feed the row's line 2 (`currentTool`) and a per-type aggregate
        // (`toolDone`, counted by the reducer) that collapses into the
        // grouped summary block on end.
        let currentTool: string | undefined;
        let toolDone: string | undefined;
        switch (inner.type) {
          case 'step_start':
            progress = `step ${inner.stepN}`;
            break;
          case 'tool_invoking': {
            progress = `running ${inner.toolName}`;
            // Build the compact line-2 label: short tool name + subject
            // (the file/pattern), e.g. `read engine.ts` / `grep "x"`.
            let subject: string | null = null;
            try {
              subject = lookupToolVocab(inner.toolName).subject?.(inner.args) ?? null;
            } catch {
              subject = null;
            }
            // The subject is model/child-authored (a grep pattern, a bash
            // command, a path) and flows verbatim over IPC. `currentTool`
            // is re-rendered into the LIVE region every heartbeat tick, so
            // a raw ESC/BEL/CR would ring the bell, paint fake SGR, or
            // forge cursor moves on every redraw. sanitizeOneLineForDisplay
            // strips ANSI + C0 control bytes, collapses to one line, and
            // caps the length at the STATE boundary (not just at render).
            subject = subject !== null ? sanitizeOneLineForDisplay(subject) : null;
            currentTool =
              subject !== null && subject.length > 0
                ? `${shortToolName(inner.toolName)} ${subject}`
                : shortToolName(inner.toolName);
            break;
          }
          case 'tool_finished':
            progress = inner.failed ? `${inner.toolName} failed` : `${inner.toolName} done`;
            toolDone = inner.toolName;
            break;
          case 'compaction_started':
            progress = 'compacting context';
            break;
          case 'compaction_finished':
            progress = `compacted (${inner.foldedCount} folded)`;
            break;
          case 'todo_updated': {
            // Count active rows only — soft-deleted (removed) items are
            // invisible everywhere else; keep the heartbeat consistent.
            const n = inner.items.filter((i) => i.status !== 'removed').length;
            progress = `${n} todo${n === 1 ? '' : 's'}`;
            break;
          }
          case 'tool_warning':
            progress = `warn: ${inner.message}`;
            break;
          case 'cost_update':
            // Cost-only events: keep the existing progress
            // text by emitting the inner type as a verb. The
            // load-bearing payload is `cumulative` — even
            // when the operator can't read the heartbeat
            // text fast enough, the row's cost chip updates.
            progress = `+$${inner.delta.toFixed(4)}`;
            cumulativeCostUsd = inner.cumulative;
            break;
          default:
            // Unmodeled inner events still produce a heartbeat
            // — silent passes would let a chatty child appear
            // hung in the renderer.
            progress = inner.type;
            break;
        }
        out.push({
          type: 'subagent:update',
          ts,
          subagentId: event.subagentId,
          progress,
          ...(cumulativeCostUsd !== undefined ? { cumulativeCostUsd } : {}),
          ...(currentTool !== undefined ? { currentTool } : {}),
          ...(toolDone !== undefined ? { toolDone } : {}),
        });
        // tool_warning from the child propagates as a top-level
        // `warn` so the operator sees the warning explicitly in the
        // permanent scrollback. Defensive field-presence guard:
        // the IPC `event` payload is `unknown` at the wire boundary
        // (parsed via `as HarnessEvent`), so a child on a different
        // version that omits `toolName` / `message` would otherwise
        // surface as `subagent <id> · undefined: undefined`.
        if (
          inner.type === 'tool_warning' &&
          typeof inner.toolName === 'string' &&
          typeof inner.message === 'string'
        ) {
          out.push({
            type: 'warn',
            ts,
            message: `subagent ${event.subagentId.slice(0, 8)} · ${inner.toolName}: ${inner.message}`,
          });
        }
        // Soft cap crossed inside the child — surface to the
        // operator's scrollback so the regression signal isn't
        // hidden inside subagent_progress heartbeat text.
        // Defensive field-presence guard mirrors the
        // tool_warning path: IPC payload is `unknown` at the
        // wire boundary; ill-typed events fall through silently
        // rather than rendering "$undefined > $NaN".
        if (
          inner.type === 'cost_soft_cap_warn' &&
          typeof inner.threshold === 'number' &&
          typeof inner.cumulative === 'number'
        ) {
          const fmt = (usd: number): string => (Math.round(usd * 100) / 100).toFixed(2);
          out.push({
            type: 'warn',
            ts,
            message: `subagent ${event.subagentId.slice(0, 8)} over budget estimate ($${fmt(inner.cumulative)} > $${fmt(inner.threshold)})`,
          });
        }
        // The child's tools do NOT stream into scrollback live anymore:
        // they feed the row's line 2 (`currentTool`, above) while running
        // and a per-type aggregate (`toolDone`) that collapses into the
        // grouped summary block on `subagent_finished`. So no nested
        // `tool:*` chips and no child entries in `state.tools` here.
        return out;
      }

      case 'subagent_finished':
        // Forward the FULL HarnessResult.status (done /
        // interrupted / exhausted / error). The previous shape
        // collapsed everything non-done to 'error' and the
        // operator lost the distinction — "Failed in 96s" gave
        // no signal whether the run hit a budget cap, was
        // user-cancelled, or crashed. The renderer uses the
        // detailed status + reason to render an honest cause
        // label ("Exhausted (cost cap, $0.59)" vs "Aborted" vs
        // "Error").
        out.push({
          type: 'subagent:end',
          ts,
          subagentId: event.subagentId,
          status: event.status,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          costUsd: event.costUsd,
          summary: event.summary,
          durationMs: event.durationMs,
        });
        return out;

      case 'cost_update':
        // Internal-bookkeeping event: the harness emits one per
        // turn so subagent runs can stream live spend up to the
        // parent over IPC (spec ORCHESTRATION.md §3.5). The TUI
        // doesn't render it directly — the existing `step:budget`
        // event already updates the cost token on the status
        // line. Returning `out` (likely empty since no other
        // case fired) makes the adapter ignore the event without
        // breaking the exhaustive switch contract.
        return out;

      case 'usage_persisted':
        // Display-refresh cue consumed by the REPL directly (it
        // recomputes the footer's DB-derived chips and emits
        // `stats:refresh` itself) — nothing for the adapter to
        // translate.
        return out;

      case 'cap_watchdog_fired':
        // Cost-cap watchdog killed every active handle (spec
        // ORCHESTRATION.md §3.5). Surface as a permanent
        // banner-style warn so the operator sees the cause —
        // without it, the active subagent rows just disappear
        // and the operator has to root-cause via /sessions or
        // logs. The cumulative + cap figures spell out which
        // limit got hit, so the operator can decide whether to
        // raise the cap or rein in the model.
        out.push({
          type: 'warn',
          ts,
          message: `cap watchdog: ${event.cancelledCount} subagent${event.cancelledCount === 1 ? '' : 's'} cancelled — cumulative $${event.cumulativeUsd.toFixed(4)} exceeded cap $${event.capUsd.toFixed(4)}`,
        });
        return out;

      case 'cost_soft_cap_warn': {
        // Per-playbook soft cap crossed (spec ORCHESTRATION.md
        // §3.5.0). Run continues — this is a regression signal,
        // not a termination. Half-up rounding to two decimals
        // matches the formatter used in subagent_summary so the
        // displayed cents are consistent across surfaces.
        const fmt = (usd: number): string => (Math.round(usd * 100) / 100).toFixed(2);
        out.push({
          type: 'warn',
          ts,
          message: `over budget estimate ($${fmt(event.cumulative)} > $${fmt(event.threshold)})`,
        });
        return out;
      }

      case 'parallel_status':
        // Parallelism observability snapshot (spec
        // ORCHESTRATION.md §1.3 / §3.3). Translates 1:1 into a
        // UIEvent that updates state.parallelStatus; the
        // footer's `subagents R+Q/cap` and `tools R/cap`
        // chips read from there. Emitted by the harness on
        // every transition (handle spawn / dispatch / settle,
        // tool dispatch enter/exit), so the chips stay in sync
        // without polling.
        out.push({
          type: 'parallel:status',
          ts,
          subagentsRunning: event.subagentsRunning,
          subagentsQueued: event.subagentsQueued,
          subagentsCap: event.subagentsCap,
          toolsRunning: event.toolsRunning,
          toolsCap: event.toolsCap,
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
          // Wall-clock duration of the turn, plumbed to the
          // turn-end marker (UI.md §3.2 → "Cogitated for 1m23s").
          durationMs: r.durationMs,
          // Pass-through abortCause when the harness produced one.
          // Meaningful only when reason ==='aborted'
          // — the harness's finish() helper guarantees this invariant
          // by setting abortCause exclusively on the abort path.
          ...(r.abortCause !== undefined ? { abortCause: r.abortCause } : {}),
        });
        return out;
      }
    }
  };

  return { translate };
};
