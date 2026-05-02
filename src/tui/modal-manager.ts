// Modal manager — async API + bus + focus-stack glue. Spec: UI.md §5.5.
//
// The producer (harness) calls one of the `ask*` methods and gets a
// promise. Under the hood, the manager:
//
//   1. emits `*:ask` on the bus (the reducer adds the modal to
//      LiveState; the renderer picks it up automatically via
//      composeLive)
//   2. pushes a focus handler that translates ←/→/Tab into a
//      `modal:select` toggle and Enter/Esc into resolution
//   3. on resolve / reject: emits `permission:answer` so the reducer
//      clears the modal, pops the focus handler, and resolves the
//      promise
//
// Default `selected = 'no'` is set in the `*:ask` event; toggles fire
// `modal:select` (cheap event, only updates `state.modal.selected`).
// We do NOT re-emit `*:ask` on toggle — that would rebuild the modal
// contents from scratch and erase the message/details.
//
// One modal at a time. Concurrent `ask*` calls queue; the queue
// drains FIFO when a prior modal resolves.

import type { Bus } from './bus.ts';
import type { UIEvent } from './events.ts';
import type { FocusHandler, FocusStack } from './focus-stack.ts';

// One pending request in the queue.
interface Pending {
  open: () => string; // emits the *:ask event with a fresh promptId, returns the id
  resolve: (accepted: boolean) => void;
  // Optional timeout handle so we can clear it on early resolve.
  timeout: unknown;
}

export interface ConfirmAskOptions {
  details?: string[];
  // Auto-reject (resolves false) after this many ms. Absent = no
  // timeout (the spec marks `permission:ask` as no-timeout per UI.md
  // §5.5 rule 6; trust:ask uses 5min via the caller).
  timeoutMs?: number;
}

export interface ModalManager {
  // Permission flavor. Caller (harness) passes the rendered command
  // and cwd; the bus event carries them to the reducer which builds
  // the visual.
  askPermission: (
    args: { toolName: string; command: string; cwd: string; rule?: string; reason?: string },
    opts?: ConfirmAskOptions,
  ) => Promise<boolean>;
  // Number of pending modals (active + queued). Tests inspect.
  pendingCount: () => number;
  // Drop the queue and reject any pending promise as `false`. Used
  // at shutdown.
  close: () => void;
}

export interface ModalManagerOptions {
  bus: Bus;
  focusStack: FocusStack;
  // Time + ID injectables for tests.
  now?: () => number;
  newPromptId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

let promptCounter = 0;
const defaultPromptId = (): string => {
  promptCounter++;
  return `modal-${Date.now()}-${promptCounter}`;
};

export const createModalManager = (options: ModalManagerOptions): ModalManager => {
  const { bus, focusStack } = options;
  const now = options.now ?? (() => Date.now());
  const newPromptId = options.newPromptId ?? defaultPromptId;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const queue: Pending[] = [];
  let active: { promptId: string; selected: 'yes' | 'no'; pending: Pending } | null = null;
  let activeHandler: FocusHandler | null = null;
  let closed = false;

  // Pulls the next entry off the queue and opens it. No-op when
  // already active or queue is empty.
  const drain = (): void => {
    if (closed) return;
    if (active !== null) return;
    const next = queue.shift();
    if (next === undefined) return;
    const promptId = next.open();
    active = { promptId, selected: 'no', pending: next };
    activeHandler = (key) => {
      if (active === null) return false;
      if (key.kind !== 'key') return true; // swallow chars while modal up
      const k = key.name;
      if (k === 'left' || k === 'right' || k === 'tab') {
        active.selected = active.selected === 'yes' ? 'no' : 'yes';
        // Cheap toggle event: reducer updates only `state.modal.selected`,
        // never rebuilds the modal contents. Flavor-agnostic — works
        // for permission, trust, memory-write, plan-review, critique.
        bus.emit({
          type: 'modal:select',
          ts: now(),
          promptId: active.promptId,
          selected: active.selected,
        });
        return true;
      }
      if (k === 'enter') {
        resolveActive(active.selected === 'yes');
        return true;
      }
      if (k === 'escape') {
        resolveActive(false);
        return true;
      }
      // Any other key while modal up: swallow (no fall-through to
      // the editor). Caller's contract — "modal nevers surprises".
      return true;
    };
    focusStack.push(activeHandler);
  };

  const resolveActive = (accepted: boolean): void => {
    if (active === null) return;
    const promptId = active.promptId;
    const pending = active.pending;
    if (pending.timeout !== null && pending.timeout !== undefined) {
      clearTimer(pending.timeout);
    }
    if (activeHandler !== null) {
      focusStack.remove(activeHandler);
      activeHandler = null;
    }
    active = null;
    // Emit the answer event BEFORE resolving the promise so any
    // listener (audit, telemetry) sees the resolution before the
    // caller's `.then` runs.
    bus.emit({
      type: 'permission:answer',
      ts: now(),
      promptId,
      decision: accepted ? 'accept' : 'reject',
    });
    pending.resolve(accepted);
    // Drain next from the queue (if any).
    drain();
  };

  const enqueueConfirm = (
    open: (promptId: string) => UIEvent,
    timeoutMs: number | undefined,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      // Already-closed manager: resolve immediately as `false` so the
      // caller doesn't hang. We don't enqueue or push focus.
      if (closed) {
        resolve(false);
        return;
      }
      const pending: Pending = {
        open: () => {
          const id = newPromptId();
          bus.emit(open(id));
          return id;
        },
        resolve,
        timeout: null,
      };
      queue.push(pending);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        pending.timeout = setTimer(() => {
          // Timeout while ACTIVE: same as Esc (reject false).
          // Timeout while still queued: drop the entry and reject.
          if (active !== null && active.pending === pending) {
            resolveActive(false);
          } else {
            const idx = queue.indexOf(pending);
            if (idx >= 0) queue.splice(idx, 1);
            pending.resolve(false);
          }
        }, timeoutMs);
      }
      drain();
    });

  return {
    askPermission: (args, opts) =>
      enqueueConfirm(
        (promptId) => ({
          type: 'permission:ask',
          ts: now(),
          promptId,
          toolName: args.toolName,
          command: args.command,
          cwd: args.cwd,
          ...(args.rule !== undefined ? { rule: args.rule } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        }),
        opts?.timeoutMs,
      ),
    pendingCount: () => (active !== null ? 1 : 0) + queue.length,
    close: () => {
      closed = true;
      const drainList: Pending[] = [];
      if (active !== null) {
        if (active.pending.timeout !== null && active.pending.timeout !== undefined) {
          clearTimer(active.pending.timeout);
        }
        if (activeHandler !== null) {
          focusStack.remove(activeHandler);
          activeHandler = null;
        }
        drainList.push(active.pending);
        active = null;
      }
      drainList.push(...queue.splice(0));
      for (const p of drainList) {
        if (p.timeout !== null && p.timeout !== undefined) clearTimer(p.timeout);
        p.resolve(false);
      }
    },
  };
};
