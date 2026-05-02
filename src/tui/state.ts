// Live region state + event reducer. Spec: UI.md §2.2, §3.
//
// `LiveState` captures everything currently rendered in the bottom 3-15
// lines of the terminal. The reducer (`applyEvent`) is pure: given a
// state and a UIEvent, it returns the next state plus an array of
// already-formatted lines to push into the scrollback (permanent
// content). The renderer wires the I/O around this — see renderer.ts.
//
// Events for which UI rendering has not been wired yet (modals,
// subagents, bg, todo, plan/critique/permission/trust/memory) are
// accepted by the reducer as no-ops with a TODO marker. They land
// fully when the modal pattern (UI.md §5.5) and render functions
// arrive in the next slices.

import type { UIEvent } from './events.ts';

export interface InputState {
  // Current value of the input box (multi-line allowed via `\n`).
  value: string;
  // Cursor position, in JS code units within `value`. UTF-16 surrogate
  // pairs are treated as two positions; renderers that care about
  // grapheme clusters can re-derive from `value`.
  cursor: number;
}

export interface ActiveTool {
  toolId: string;
  name: string;
  args: string;
  startedAt: number;
  // Last few lines of streaming output. Capped so a tool that emits
  // a megabyte of stdout doesn't bloat the live region — the full
  // content has already gone through the scrollback as `tool:delta`
  // permanent lines (or, in this slice, will once delta lines are
  // wired to print permanently).
  preview: string[];
}

export interface StatusState {
  sessionId: string | null;
  profile: string | null;
  project: string | null;
  model: string | null;
  steps: number;
  maxSteps: number;
  costUsd: number;
  // null = no cap configured. Renderer shows steps/cost without budget
  // shading when cap absent.
  maxCostUsd: number | null;
}

export interface PendingAssistant {
  messageId: string;
  text: string;
}

export interface LiveState {
  input: InputState;
  status: StatusState;
  // Keyed by toolId so updates are O(1). Insertion order is preserved
  // by `Map`, so the renderer can iterate and produce stable layout.
  activeTools: Map<string, ActiveTool>;
  pendingAssistant: PendingAssistant | null;
  thinking: { startedAt: number } | null;
  // Set true after `session:end`; renderer uses to decide whether to
  // accept further input or stop redrawing.
  ended: boolean;
}

export const createInitialState = (): LiveState => ({
  input: { value: '', cursor: 0 },
  status: {
    sessionId: null,
    profile: null,
    project: null,
    model: null,
    steps: 0,
    maxSteps: 0,
    costUsd: 0,
    maxCostUsd: null,
  },
  activeTools: new Map(),
  pendingAssistant: null,
  thinking: null,
  ended: false,
});

// Maximum lines kept in a tool's preview window. Anything longer
// would push the live region past its budget (UI.md §2.2: max 15
// lines). The cap is conservative — renderer-side truncation can
// shrink further per layout.
const TOOL_PREVIEW_MAX_LINES = 5;

export interface ApplyResult {
  state: LiveState;
  // Lines to emit to permanent stdout in order. Each string represents
  // one line WITHOUT its trailing newline — the renderer adds `\n`.
  // Empty array = no scrollback output for this event.
  permanent: string[];
}

// Append output lines to a tool's preview, keeping only the last N.
const appendPreview = (tool: ActiveTool, text: string): ActiveTool => {
  // Split on `\n` but ignore a trailing empty line (common when the
  // chunk ended exactly at a newline — we don't want a phantom empty
  // preview row).
  const incoming = text.split('\n');
  if (incoming[incoming.length - 1] === '') incoming.pop();
  if (incoming.length === 0) return tool;
  const merged = [...tool.preview, ...incoming];
  const dropped = Math.max(0, merged.length - TOOL_PREVIEW_MAX_LINES);
  return { ...tool, preview: merged.slice(dropped) };
};

const cloneTools = (tools: Map<string, ActiveTool>): Map<string, ActiveTool> => new Map(tools);

// Format a permanent line summarizing a finished tool call. Matches the
// shape from UI.md §4.1 final form — one head line + optional summary.
//
// TODO(1.c structural): glyphs and color are capability-aware in the
// spec (`▶`/`✓`/`✗` vs ASCII; red on error). The reducer can't see
// `caps`, so this function emits ASCII-only and a separate `permanent`
// shape (PermanentItem[]) is the cleaner long-term fix. Tracking under
// "Decision #3" in the 1.b code review — held until the render-functions
// slice lands so we don't churn the contract twice.
const formatToolFinal = (
  tool: ActiveTool,
  status: 'done' | 'error' | 'denied',
  durationMs: number,
  summary: string | undefined,
): string[] => {
  // 'done' uses an asterisk (Unicode `✓` lands with the render
  // functions). 'error' and 'denied' MUST be distinct so users can
  // tell "policy blocked me" from "tool crashed" — UI.md §4.1/§4.6.
  const glyph = status === 'done' ? '*' : status === 'error' ? 'x' : '!';
  const ms = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  const head = `${glyph} ${tool.name} · ${tool.args}    ${ms}`;
  return summary ? [head, `  ${summary}`] : [head];
};

export const applyEvent = (state: LiveState, event: UIEvent): ApplyResult => {
  switch (event.type) {
    case 'session:start': {
      const status: StatusState = {
        ...state.status,
        sessionId: event.sessionId,
        profile: event.profile,
        project: event.project,
        model: event.model,
      };
      const header = `── session ${event.sessionId} · ${event.profile} · ${event.model} ──`;
      return { state: { ...state, status, ended: false }, permanent: [header] };
    }

    case 'session:end': {
      const summary = `── session end · ${event.reason} ──`;
      return { state: { ...state, ended: true }, permanent: [summary] };
    }

    case 'user:submit': {
      // Echo the prompt to scrollback and clear the input box. Multi-line
      // input is preserved with newlines; renderer joins for display.
      const lines = event.text.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
      return {
        state: { ...state, input: { value: '', cursor: 0 } },
        permanent: lines,
      };
    }

    case 'assistant:start':
      return {
        state: { ...state, pendingAssistant: { messageId: event.messageId, text: '' } },
        permanent: [],
      };

    case 'assistant:delta': {
      const current = state.pendingAssistant;
      // Late delta with no matching start — happens if the producer
      // emitted out of order or session resumed mid-stream. We open
      // a buffer on the fly rather than dropping content.
      const buf = current ?? { messageId: event.messageId, text: '' };
      return {
        state: { ...state, pendingAssistant: { ...buf, text: buf.text + event.text } },
        permanent: [],
      };
    }

    case 'assistant:end': {
      const buf = state.pendingAssistant;
      const text = buf?.text ?? '';
      const permanent = text.length > 0 ? text.split('\n') : [];
      return { state: { ...state, pendingAssistant: null }, permanent };
    }

    case 'thinking:start':
      return { state: { ...state, thinking: { startedAt: event.ts } }, permanent: [] };

    case 'thinking:end':
    case 'thinking:delta':
      // Delta events don't change state — duration is computed at render
      // time from `startedAt`. End clears the indicator.
      return {
        state: event.type === 'thinking:end' ? { ...state, thinking: null } : state,
        permanent: [],
      };

    case 'tool:start': {
      const tool: ActiveTool = {
        toolId: event.toolId,
        name: event.name,
        args: event.args,
        startedAt: event.ts,
        preview: [],
      };
      const next = cloneTools(state.activeTools);
      next.set(event.toolId, tool);
      return { state: { ...state, activeTools: next }, permanent: [] };
    }

    case 'tool:delta': {
      const tool = state.activeTools.get(event.toolId);
      // Delta for an unknown tool: drop. Producer error or out-of-order
      // event after `tool:end`. Don't synthesize a tool from a delta —
      // we'd lack name/args.
      if (tool === undefined) return { state, permanent: [] };
      const next = cloneTools(state.activeTools);
      next.set(event.toolId, appendPreview(tool, event.text));
      return { state: { ...state, activeTools: next }, permanent: [] };
    }

    case 'tool:end': {
      const tool = state.activeTools.get(event.toolId);
      const next = cloneTools(state.activeTools);
      next.delete(event.toolId);
      if (tool === undefined) return { state: { ...state, activeTools: next }, permanent: [] };
      const lines = formatToolFinal(tool, event.status, event.durationMs, event.summary);
      return { state: { ...state, activeTools: next }, permanent: lines };
    }

    case 'step:budget': {
      const status: StatusState = {
        ...state.status,
        steps: event.steps,
        maxSteps: event.maxSteps,
        costUsd: event.costUsd,
        maxCostUsd: event.maxCostUsd ?? null,
      };
      return { state: { ...state, status }, permanent: [] };
    }

    case 'checkpoint:create':
      // No live element yet — checkpoint flash on status line lands
      // with the status-line render function.
      return { state, permanent: [] };

    case 'error':
      return { state, permanent: [`error: ${event.message}`] };

    case 'warn':
      return { state, permanent: [`warn: ${event.message}`] };

    case 'interrupt':
      // Renderer surfaces interrupt prompt in the input box area;
      // permanent log only on confirmation, handled by a separate
      // event the producer emits afterwards.
      return { state, permanent: [] };

    // ─── Not yet wired (modal pattern + render functions arrive in
    // subsequent slices). Accept silently so producers can emit them
    // without crashing the renderer; permanent output stays empty
    // until each is properly handled. ──────────────────────────────
    case 'permission:ask':
    case 'permission:answer':
    case 'trust:ask':
    case 'memory:write:ask':
    case 'plan:review':
    case 'critique:ask':
    case 'todo:update':
    case 'subagent:start':
    case 'subagent:update':
    case 'subagent:end':
    case 'bg:start':
    case 'bg:update':
    case 'bg:end':
      return { state, permanent: [] };

    default: {
      // Exhaustiveness guard: TypeScript marks `event` as `never` here
      // when every case is handled. If a new UIEvent kind is added and
      // not wired, this throws at runtime — failing fast beats silent
      // drops for new producer events.
      const _exhaustive: never = event;
      void _exhaustive;
      throw new Error(`applyEvent: unhandled event type ${(event as { type: string }).type}`);
    }
  }
};
