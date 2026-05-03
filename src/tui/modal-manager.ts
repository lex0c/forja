// Modal manager — async API + bus + focus-stack glue. Spec: UI.md
// §5.5 / §4.10.13.
//
// The producer (harness/REPL) calls one of the `ask*` methods and
// gets a promise that resolves with the user's answer (per-flavor
// union). Under the hood, the manager:
//
//   1. emits `*:ask` on the bus (the reducer adds the modal to
//      LiveState; the renderer picks it up automatically via
//      composeLive)
//   2. pushes a focus handler that translates ↑/↓/Tab into a
//      `modal:select` (selectedIndex update) and Enter/Esc/hotkey
//      into resolution
//   3. on resolve / reject: emits `modal:answer` so the reducer
//      clears the modal, pops the focus handler, and resolves the
//      promise
//
// Default `selectedIndex = options.length - 1` per D5/D65 — last
// option is conventionally the safe choice (No / Reject / Skip).
// Esc returns 'cancel' (distinct from 'no') so audit can tell
// "user closed without deciding" from "user explicitly rejected".
//
// One modal at a time. Concurrent `ask*` calls queue; the queue
// drains FIFO when a prior modal resolves.

import type { Bus } from './bus.ts';
import type { UIEvent } from './events.ts';
import type { FocusHandler, FocusStack } from './focus-stack.ts';
import type { ConfirmOption, PermissionAnswer } from './state.ts';
export type { PermissionAnswer } from './state.ts';

// One pending request in the queue.
interface Pending<Answer extends string = string> {
  open: () => string; // emits the *:ask event with a fresh promptId, returns the id
  resolve: (answer: Answer) => void;
  options: readonly ConfirmOption[];
  // Optional timeout handle so we can clear it on early resolve.
  timeout: unknown;
}

export interface ConfirmAskOptions {
  // Auto-reject (resolves cancel) after this many ms. Absent = no
  // timeout (the spec marks `permission:ask` as no-timeout per UI.md
  // §5.5 rule 6; trust:ask uses 5min via the caller).
  timeoutMs?: number;
}

export interface PermissionAskArgs {
  toolName: string;
  command: string;
  cwd: string;
  rule?: string;
  reason?: string;
}

// Permission flavor's option list, kept in sync with the reducer's
// ConfirmState construction. Exported so producers can introspect /
// override (future trust/memory variants do their own lists).
const PERMISSION_OPTIONS = (toolName: string): ConfirmOption[] => [
  { key: '1', label: 'Yes', value: 'yes' },
  {
    key: '2',
    label: `Yes, allow all ${toolName} during this session`,
    value: 'session-allow',
    shortcut: 'shift+tab',
  },
  { key: '3', label: 'No', value: 'no' },
];

export interface ModalManager {
  // Permission flavor. Returns the user's choice (or 'cancel' on Esc /
  // close / timeout). Callers translate semantics: yes → execute,
  // session-allow → execute + write session-layer rule (deferred,
  // see 1.d.7), no/cancel → deny.
  askPermission: (args: PermissionAskArgs, opts?: ConfirmAskOptions) => Promise<PermissionAnswer>;
  // Number of pending modals (active + queued). Tests inspect.
  pendingCount: () => number;
  // Drop the queue and resolve any pending promise as `cancel`. Used
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
  let active: { promptId: string; selectedIndex: number; pending: Pending } | null = null;
  let activeHandler: FocusHandler | null = null;
  let closed = false;

  // Match a key event against an option's hotkey or shortcut. Hotkeys
  // are compared as bare chars (`'1'`, `'a'`); shortcuts are named
  // chords (`'shift+tab'`).
  const matchesKey = (key: Parameters<FocusHandler>[0], keyOrShortcut: string): boolean => {
    if (key.kind === 'char') return !key.alt && !key.ctrl && key.char === keyOrShortcut;
    if (key.kind !== 'key') return false;
    if (keyOrShortcut === 'shift+tab') return key.name === 'tab' && key.shift === true;
    if (keyOrShortcut === 'tab') return key.name === 'tab' && key.shift !== true;
    return key.name === keyOrShortcut;
  };

  // Pulls the next entry off the queue and opens it. No-op when
  // already active or queue is empty.
  const drain = (): void => {
    if (closed) return;
    if (active !== null) return;
    const next = queue.shift();
    if (next === undefined) return;
    const promptId = next.open();
    // Default selectedIndex = last option (conservative choice).
    active = { promptId, selectedIndex: next.options.length - 1, pending: next };
    activeHandler = (key) => {
      if (active === null) return false;

      // Direct hotkey activation: any option whose `key` or `shortcut`
      // matches resolves immediately with that option's value.
      const hit = next.options.findIndex(
        (o) => matchesKey(key, o.key) || (o.shortcut !== undefined && matchesKey(key, o.shortcut)),
      );
      if (hit >= 0) {
        const value = next.options[hit]?.value ?? '';
        resolveActive(value);
        return true;
      }

      if (key.kind !== 'key') return true; // swallow chars while modal up
      const k = key.name;

      if (k === 'up' || (k === 'tab' && key.shift === true)) {
        moveSelection(-1);
        return true;
      }
      if (k === 'down' || (k === 'tab' && key.shift !== true)) {
        moveSelection(1);
        return true;
      }
      if (k === 'enter') {
        const opt = next.options[active.selectedIndex];
        resolveActive(opt?.value ?? '');
        return true;
      }
      if (k === 'escape') {
        // Esc returns 'cancel' regardless of which option was
        // highlighted. Distinct from 'no' so audit / telemetry can
        // tell explicit rejection from passive close.
        resolveActive('cancel');
        return true;
      }
      // Any other key while modal up: swallow (no fall-through to
      // the editor). Caller's contract — "modal nevers surprises".
      return true;
    };
    focusStack.push(activeHandler);
  };

  const moveSelection = (delta: number): void => {
    if (active === null) return;
    const max = active.pending.options.length - 1;
    const next = Math.max(0, Math.min(max, active.selectedIndex + delta));
    if (next === active.selectedIndex) return;
    active.selectedIndex = next;
    bus.emit({
      type: 'modal:select',
      ts: now(),
      promptId: active.promptId,
      selectedIndex: next,
    });
  };

  const resolveActive = (value: string): void => {
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
    // caller's `.then` runs. `decision` is a flavor-specific string
    // — `permission` uses 'yes'/'session-allow'/'no'/'cancel',
    // `plan-review` uses 'yes'/'edit'/'no'/'cancel', etc. Consumers
    // narrow per-flavor by reading the original `*:ask` event.
    bus.emit({
      type: 'modal:answer',
      ts: now(),
      promptId,
      decision: value,
    });
    pending.resolve(value);
    // Drain next from the queue (if any).
    drain();
  };

  const enqueueConfirm = <Answer extends string>(
    open: (promptId: string) => UIEvent,
    optionsList: readonly ConfirmOption[],
    timeoutMs: number | undefined,
  ): Promise<Answer> =>
    new Promise<Answer>((resolve) => {
      // Already-closed manager: resolve immediately as 'cancel' so
      // the caller doesn't hang. We don't enqueue or push focus.
      if (closed) {
        resolve('cancel' as Answer);
        return;
      }
      const pending: Pending<Answer> = {
        open: () => {
          const id = newPromptId();
          bus.emit(open(id));
          return id;
        },
        resolve,
        options: optionsList,
        timeout: null,
      };
      queue.push(pending as Pending);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        pending.timeout = setTimer(() => {
          // Timeout while ACTIVE: same as Esc (resolve cancel).
          // Timeout while still queued: drop the entry and resolve.
          if (active !== null && active.pending === (pending as Pending)) {
            resolveActive('cancel');
          } else {
            const idx = queue.indexOf(pending as Pending);
            if (idx >= 0) queue.splice(idx, 1);
            pending.resolve('cancel' as Answer);
          }
        }, timeoutMs);
      }
      drain();
    });

  return {
    askPermission: (args, opts) =>
      enqueueConfirm<PermissionAnswer>(
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
        PERMISSION_OPTIONS(args.toolName),
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
        p.resolve('cancel');
      }
    },
  };
};
