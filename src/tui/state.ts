// Live region state + event reducer. Spec: UI.md §2.2, §3.
//
// `LiveState` captures everything currently rendered in the bottom 3-15
// lines of the terminal. The reducer (`applyEvent`) is pure: given a
// state and a UIEvent, it returns the next state plus an array of
// structured `PermanentItem` records the renderer turns into scrollback
// lines. Glyph + color decisions live downstream in `formatPermanent`
// (renderer.ts) — the reducer never sees `Capabilities`. The renderer
// wires the I/O around this — see renderer.ts.
//
// Wired so far: session lifecycle, user submit, assistant streaming,
// thinking, tool lifecycle (start/delta/end with preview cap), step
// budget, error/warn, interrupt, checkpoint, and the modal pattern
// (`*:ask` / `permission:answer` / `modal:select`). Subagent / bg /
// todo events accept silently and land alongside their render
// functions.

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

// Confirm-style modal. Spec: UI.md §5.5. Lives in `LiveState` so the
// renderer composes it; the modal-manager (src/tui/modal-manager.ts)
// owns the async lifecycle (promise + queue + bus dispatch). Default
// selected = 'no' is enforced by the manager when it constructs the
// state, never by individual setters — keeps the safety invariant in
// one place.
export interface ConfirmState {
  // ID assigned by the producer; threaded through `permission:ask` and
  // matched by `permission:answer` to resolve the right promise.
  promptId: string;
  // Flavor lets the renderer pick a heading and the reducer route to
  // the right "answer" event. We keep all confirm-shaped modals
  // (permission, trust, memory write, plan review, critique) in this
  // single state field to simplify focus + render — only one modal
  // visible at a time anyway. Their per-flavor payloads live alongside.
  flavor: 'permission' | 'trust' | 'memory-write' | 'plan-review' | 'critique';
  // Lines the modal renders. First entry is the headline; rest are
  // dim continuation lines (paths, code excerpts, etc.).
  message: string;
  details: string[];
  // User's current selection. Default = 'no' (UI.md §5.5 D5 — safety:
  // Enter without navigating rejects).
  selected: 'yes' | 'no';
}

export interface LiveState {
  input: InputState;
  status: StatusState;
  // Keyed by toolId so updates are O(1). Insertion order is preserved
  // by `Map`, so the renderer can iterate and produce stable layout.
  activeTools: Map<string, ActiveTool>;
  pendingAssistant: PendingAssistant | null;
  thinking: { startedAt: number } | null;
  // Active modal, or null when no modal is up. Composer (compose.ts)
  // replaces the input box with `renderModal(modal, caps)` whenever
  // this is non-null. Status line + tool cards stay visible.
  modal: ConfirmState | null;
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
  modal: null,
  ended: false,
});

// Maximum lines kept in a tool's preview window. Anything longer
// would push the live region past its budget (UI.md §2.2: max 15
// lines). The cap is conservative — renderer-side truncation can
// shrink further per layout.
const TOOL_PREVIEW_MAX_LINES = 5;

// Structured records representing scrollback entries the reducer wants
// the renderer to print. Glyph + color decisions live in the renderer
// (which sees `caps`), not here — keeping the reducer free of capability
// awareness. The renderer's `formatPermanent(item, caps)` turns each
// record into one or more output strings.
//
// Adding a new kind: extend the union, handle it in `formatPermanent`
// (renderer.ts), and emit from the relevant `applyEvent` branch.
export type PermanentItem =
  | {
      kind: 'session-header';
      sessionId: string;
      profile: string;
      project: string;
      model: string;
    }
  | { kind: 'session-footer'; reason: string }
  | { kind: 'user-submit'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool-end';
      name: string;
      args: string;
      status: 'done' | 'error' | 'denied';
      durationMs: number;
      summary?: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'warn'; message: string };

export interface ApplyResult {
  state: LiveState;
  // Structured records for the renderer to emit as scrollback. Empty
  // array = no scrollback output for this event. Strings happen later
  // in `formatPermanent` (renderer.ts) — that's where `caps` decides
  // glyphs (Unicode vs ASCII) and color (red error vs plain).
  permanent: PermanentItem[];
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
      return {
        state: { ...state, status, ended: false },
        permanent: [
          {
            kind: 'session-header',
            sessionId: event.sessionId,
            profile: event.profile,
            project: event.project,
            model: event.model,
          },
        ],
      };
    }

    case 'session:end':
      return {
        state: { ...state, ended: true },
        permanent: [{ kind: 'session-footer', reason: event.reason }],
      };

    case 'user:submit':
      return {
        state: { ...state, input: { value: '', cursor: 0 } },
        permanent: [{ kind: 'user-submit', text: event.text }],
      };

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
      const permanent: PermanentItem[] = text.length > 0 ? [{ kind: 'assistant', text }] : [];
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
      const item: PermanentItem = {
        kind: 'tool-end',
        name: tool.name,
        args: tool.args,
        status: event.status,
        durationMs: event.durationMs,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      };
      return { state: { ...state, activeTools: next }, permanent: [item] };
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
      return { state, permanent: [{ kind: 'error', message: event.message }] };

    case 'warn':
      return { state, permanent: [{ kind: 'warn', message: event.message }] };

    case 'interrupt':
      // Renderer surfaces interrupt prompt in the input box area;
      // permanent log only on confirmation, handled by a separate
      // event the producer emits afterwards.
      return { state, permanent: [] };

    // ─── Modal events ──────────────────────────────────────────────
    // Each `*:ask` raises a confirm-shaped modal with `selected = 'no'`
    // by default (UI.md §5.5 D5). The matching `*:answer` (or
    // `permission:answer` for the permission flavor) clears the modal.
    // Producer (modal-manager) is responsible for re-emitting if
    // multiple modals queue up; the reducer never queues itself.
    case 'permission:ask':
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'permission',
            message: `${event.toolName}: ${event.command}`,
            details: [
              `cwd: ${event.cwd}`,
              ...(event.rule !== undefined ? [`rule: ${event.rule}`] : []),
              ...(event.reason !== undefined ? [`reason: ${event.reason}`] : []),
            ],
            selected: 'no',
          },
        },
        permanent: [],
      };

    case 'permission:answer': {
      // Only clear the modal when the answer matches the open prompt.
      // A late answer from a stale prompt (e.g. cancelled then a new
      // ask raised before the cancel propagated) shouldn't dismiss
      // the wrong modal.
      if (state.modal === null || state.modal.promptId !== event.promptId) {
        return { state, permanent: [] };
      }
      return { state: { ...state, modal: null }, permanent: [] };
    }

    case 'modal:select': {
      // In-modal toggle. Updates only `selected`; never reconstructs
      // contents. Stale events (mismatched promptId, or arrived after
      // the modal closed) are dropped silently.
      if (state.modal === null || state.modal.promptId !== event.promptId) {
        return { state, permanent: [] };
      }
      return {
        state: { ...state, modal: { ...state.modal, selected: event.selected } },
        permanent: [],
      };
    }

    case 'trust:ask':
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'trust',
            message: 'unknown directory',
            details: [
              event.path,
              ...(event.agentsMd ? ['AGENTS.md present (not yet trusted)'] : []),
            ],
            selected: 'no',
          },
        },
        permanent: [],
      };

    case 'memory:write:ask':
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'memory-write',
            message: `memory write proposed (${event.scope})`,
            details: [`name: ${event.name}`, '', ...event.body.split('\n')],
            selected: 'no',
          },
        },
        permanent: [],
      };

    case 'plan:review':
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'plan-review',
            message: `plan review · ${event.steps.length} steps`,
            details: [
              ...event.steps.map((s, i) => `${i + 1}. ${s}`),
              '',
              `estimated: ${event.estimatedCalls} tool calls · $${event.estimatedCostUsd.toFixed(2)}`,
            ],
            selected: 'no',
          },
        },
        permanent: [],
      };

    case 'critique:ask':
      return {
        state: {
          ...state,
          modal: {
            promptId: event.promptId,
            flavor: 'critique',
            message: `critique · ${event.issues.length} issue(s)`,
            details: event.issues.map(
              (i) => `[${i.severity}] (${i.confidence.toFixed(2)}) ${i.message}`,
            ),
            selected: 'no',
          },
        },
        permanent: [],
      };

    // ─── Not yet wired (subagent / bg / todo render arrives later) ──
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
