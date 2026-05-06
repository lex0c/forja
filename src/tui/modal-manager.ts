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
  // Producer-driven cancellation. When the signal aborts, the modal
  // resolves to 'cancel' immediately — same shape as the
  // timeout/Esc paths. Two cases collapse to the same outcome:
  //   - Active modal: same as resolveActive('cancel'); fires the
  //     answer event, drains the next from the queue.
  //   - Still queued: remove from queue and resolve. Emits a
  //     queue-depth update keyed to the active modal so the
  //     `(+N waiting)` suffix corrects down (mirrors the
  //     queued-timeout path).
  // Used by the subagent permission proxy (spec docs/spec/IPC.md §7)
  // so a child dying with its modal open closes the prompt instead
  // of blocking the operator on a stale request whose answer would
  // go into a closed channel.
  signal?: AbortSignal;
}

export interface PermissionAskArgs {
  toolName: string;
  command: string;
  cwd: string;
  rule?: string;
  reason?: string;
  // Subagent attribution. Set by the parent harness when
  // proxying a child's `permission:ask` over IPC (spec
  // docs/spec/IPC.md §7). The reducer prefixes the modal title
  // so the operator distinguishes a parent confirm from a child
  // confirm. Undefined for the parent's own confirms.
  subagent?: { sessionId: string; name: string };
}

// Trust flavor — first-run "is this directory safe to operate in?"
// prompt (AGENTIC_CLI.md §9.1). Answer maps to: yes → persist
// the cwd to trusted_dirs.json and continue; no/cancel → exit
// cleanly without entering the REPL.
export interface TrustAskArgs {
  path: string;
  agentsMd?: boolean;
}

export type TrustAnswer = 'yes' | 'no' | 'cancel';

// History-clear flavor (HISTORY.md §2.3 `/history clear` modal).
// `yes` = clear only, `yes-disable` = clear + write the
// `.agent/no-history` marker (permanent per-project opt-out), `no` =
// reject explicitly, `cancel` = closed via Esc / timeout. The
// dispatcher is the place that distinguishes 'no' vs 'cancel' for
// audit; for history specifically both are no-ops on disk.
export interface HistoryClearAskArgs {
  entryCount: number;
  projectRoot: string;
}
export type HistoryClearAnswer = 'yes' | 'yes-disable' | 'no' | 'cancel';

// Memory-write flavor (MEMORY.md §5.1 modal). Producer is the
// `memory_write` tool. The modal renders the `body` verbatim
// (multi-line) plus the `scope/name` subject so the operator
// reviews the exact bytes about to land on disk. `yes` =
// persist via MemoryRegistry.write, `no` = explicit reject (audit
// row gets `refused`), `cancel` = Esc/timeout (audit row gets
// `refused` with reason='cancelled').
export interface MemoryWriteAskArgs {
  // Mirrors `MemoryScopeForUI` in events.ts. The values must stay
  // in sync with `MemoryScope` from `src/memory/types.ts`.
  scope: 'user' | 'project_shared' | 'project_local';
  name: string;
  body: string;
}
export type MemoryWriteAnswer = 'yes' | 'no' | 'cancel';

// User-scope second-confirm flavor (MEMORY.md §7.2.5). Producer:
// `memory_write` after the first modal returns yes AND the
// proposed scope is `user`. Distinct args from MemoryWriteAskArgs
// (no scope — by definition we're at user scope when this fires)
// so the type system makes the call sites un-confusable.
export interface MemoryUserScopeAskArgs {
  name: string;
  body: string;
}

// Generic memory-action confirm (MEMORY.md §5.4 / §5.5 / §6.3).
// Producers: `/memory delete`, `/memory promote shared`,
// `/memory demote local`. Caller constructs the copy; manager
// just queues the modal. `action` is forwarded to the event for
// audit / telemetry.
export interface MemoryActionAskArgs {
  action: 'delete' | 'promote' | 'demote';
  title: string;
  subject: string;
  preview: string[];
  question: string;
}

// Trust flavor's option list. Kept in sync with the reducer's
// `trust:ask` ConfirmState construction in state.ts.
const TRUST_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, I trust this folder', value: 'yes' },
  { key: '2', label: 'No, exit', value: 'no' },
];

// History-clear flavor (HISTORY.md §2.3). Kept in sync with the
// reducer's `history-clear:ask` ConfirmState construction.
const HISTORY_CLEAR_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, wipe', value: 'yes' },
  { key: '2', label: 'Yes, wipe and disable persistence', value: 'yes-disable' },
  { key: '3', label: 'No', value: 'no' },
];

// Memory-write flavor (MEMORY.md §5.1). Two options — persist the
// proposed memory or skip. Default is the last (No), matching the
// conservative-default convention used by every other confirm
// flavor (D5/D65). Labels match what the reducer constructs in
// `state.ts:869` so the manager's option list and the rendered
// modal stay in sync.
const MEMORY_WRITE_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, write memory', value: 'yes' },
  { key: '2', label: 'No, skip', value: 'no' },
];

// User-scope second-confirm options (MEMORY.md §7.2.5). Same
// shape as memory-write but distinct labels so the operator
// re-reads the question rather than habitually pressing 1.
// Reducer matches at `state.ts` `memory:user-scope:ask`.
const MEMORY_USER_SCOPE_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, persist to user scope', value: 'yes' },
  { key: '2', label: 'No, cancel write', value: 'no' },
];

// Generic memory-action options (delete / promote / demote).
// Reducer matches at `state.ts` `memory:action:ask`. Generic
// labels — caller's title carries the verb-tense specificity.
const MEMORY_ACTION_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, proceed', value: 'yes' },
  { key: '2', label: 'No, cancel', value: 'no' },
];

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
  // session-allow → execute + write session-layer rule (deferred),
  // no/cancel → deny.
  askPermission: (args: PermissionAskArgs, opts?: ConfirmAskOptions) => Promise<PermissionAnswer>;
  // Trust flavor. Returns the operator's choice (or 'cancel' on Esc /
  // close / timeout). Caller (REPL boot) translates: yes → persist
  // and continue, no/cancel → exit before entering the REPL. Spec
  // §9.1 calls for a 5-minute timeout that defaults to read-only —
  // we forward that via `opts.timeoutMs` so the producer decides.
  askTrust: (args: TrustAskArgs, opts?: ConfirmAskOptions) => Promise<TrustAnswer>;
  // History-clear flavor (HISTORY.md §2.3). Surfaces the entry count
  // and project root so the modal can render blast radius up front.
  askHistoryClear: (
    args: HistoryClearAskArgs,
    opts?: ConfirmAskOptions,
  ) => Promise<HistoryClearAnswer>;
  // Memory-write flavor (MEMORY.md §5.1). Producer is the
  // `memory_write` tool. Caller (ToolContext.confirmMemoryWrite) maps
  // the answer onto the writer: yes → MemoryRegistry.write,
  // no/cancel → audit row `refused` (caller distinguishes 'no' from
  // 'cancel' for telemetry).
  askMemoryWrite: (
    args: MemoryWriteAskArgs,
    opts?: ConfirmAskOptions,
  ) => Promise<MemoryWriteAnswer>;
  // User-scope second-confirm flavor (MEMORY.md §7.2.5). Fires
  // AFTER `askMemoryWrite` resolves yes for a `user`-scope
  // proposal. Reuses `MemoryWriteAnswer` since the answer
  // semantics are identical (yes=proceed, no=explicit reject,
  // cancel=Esc/timeout); the wording in the modal is what
  // changes per spec ("vai afetar todas as sessões").
  askMemoryUserScope: (
    args: MemoryUserScopeAskArgs,
    opts?: ConfirmAskOptions,
  ) => Promise<MemoryWriteAnswer>;
  // Generic memory-action confirm (delete / promote / demote).
  // Producer (slash command) constructs the copy; reducer renders
  // it. Reuses `MemoryWriteAnswer` since the answer triad is
  // identical (yes/no/cancel).
  askMemoryAction: (
    args: MemoryActionAskArgs,
    opts?: ConfirmAskOptions,
  ) => Promise<MemoryWriteAnswer>;
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
  // Called when the operator presses Ctrl+C with a modal open.
  // The REPL wires this to its triggerInterrupt() so the abort
  // ladder fires alongside the modal's 'cancel' resolution. Without
  // this seam, modal-manager would have to fall through to the
  // editor's cancelInput path — which only fires when the input
  // buffer is empty, so a draft mid-typing would dismiss the modal
  // and clear the buffer but FAIL to abort the run (operator stuck
  // having to press Ctrl+C again, draft lost). Optional: callers
  // that don't run inside a REPL (tests, headless modal flows)
  // omit it and accept that Ctrl+C only resolves the modal.
  onInterrupt?: () => void;
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
    // Initial queue-depth snapshot for the just-opened modal. The
    // event MUST fire AFTER `next.open()` so the reducer has
    // already created the modal slot before this update lands —
    // otherwise the reducer's mismatched-promptId guard would
    // drop it. `queue.length` reflects what's STILL waiting AFTER
    // popping this one (see queue.shift above) — exactly the
    // count the renderer's `(+N waiting)` suffix needs.
    if (queue.length > 0) {
      bus.emit({
        type: 'modal:queue-depth',
        ts: now(),
        promptId,
        depth: queue.length,
      });
    }
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

      // Ctrl+C escapes the modal AND triggers the REPL's interrupt
      // ladder. Three things happen, in order:
      //   1. Modal resolves with 'cancel' (same semantic as Esc).
      //   2. onInterrupt callback fires (REPL aborts the run).
      //   3. Return TRUE — keystroke fully consumed, editor never
      //      sees it. Critical: the editor's Ctrl+C only fires
      //      cancelInput when its buffer is empty; a draft mid-
      //      typing would otherwise dismiss the modal and clear
      //      the buffer but NOT abort the run, leaving the operator
      //      stuck (and draft lost). Returning true preserves the
      //      buffer; onInterrupt does the abort directly.
      //
      // When onInterrupt isn't wired (tests, headless flows), the
      // modal still resolves and the keystroke is consumed — abort
      // simply doesn't fire, matching the documented contract.
      if (key.kind === 'char' && key.ctrl && key.char === 'c') {
        resolveActive('cancel');
        options.onInterrupt?.();
        return true;
      }

      if (key.kind !== 'key') return true; // swallow other chars while modal up
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
    signal: AbortSignal | undefined,
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
      // Live update for an existing modal: a new ask just landed
      // behind the active one. Bump the displayed `(+N waiting)`
      // suffix so the operator sees the queue grow in real time
      // — without this, only the snapshot at modal-open time
      // would show, and any asks arriving afterward would be
      // invisible until the operator answered. `drain()` below
      // will be a no-op when active !== null, so no double-emit.
      if (active !== null) {
        bus.emit({
          type: 'modal:queue-depth',
          ts: now(),
          promptId: active.promptId,
          depth: queue.length,
        });
      }
      // Cancel-on-resolve helper — wired by both the timeout and
      // signal paths to keep the cleanup uniform. Two cases
      // collapse to the same outcome:
      //   - Active modal: same as Esc / resolveActive('cancel');
      //     fires the answer event, drains the next from the
      //     queue (drain emits its own queue-depth update for
      //     the newly-active modal).
      //   - Still queued: remove from queue, resolve the promise,
      //     and emit queue-depth keyed to the active modal so
      //     the visible `(+N waiting)` suffix corrects down
      //     immediately. Without that emit the count would lie
      //     until the active modal resolves and drain pops the
      //     next.
      // Idempotent: a second call on an already-resolved pending
      // hits `pending.resolve` (no-op on settled promises) and
      // `queue.indexOf` returns -1 (no double-emit). Safe under
      // races between the timeout firing and the signal aborting.
      const cancelPending = (): void => {
        if (active !== null && active.pending === (pending as Pending)) {
          resolveActive('cancel');
          return;
        }
        const idx = queue.indexOf(pending as Pending);
        if (idx >= 0) queue.splice(idx, 1);
        pending.resolve('cancel' as Answer);
        if (active !== null && idx >= 0) {
          bus.emit({
            type: 'modal:queue-depth',
            ts: now(),
            promptId: active.promptId,
            depth: queue.length,
          });
        }
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        pending.timeout = setTimer(cancelPending, timeoutMs);
      }
      // Producer signal — wires the same cancel path as timeout.
      // The signal handler runs at most once: AbortSignal listeners
      // fire on the first abort and don't re-fire. `cancelPending`
      // itself is idempotent over the pending entry's identity
      // (resolve is a no-op after the promise already settled),
      // so a late timer firing AFTER the signal already cancelled
      // (or vice versa) is harmless.
      if (signal !== undefined) {
        if (signal.aborted) {
          // Pre-aborted signal: cancel synchronously. We already
          // pushed onto the queue, so cancelPending finds the
          // entry and resolves immediately as cancel.
          cancelPending();
        } else {
          signal.addEventListener('abort', cancelPending, { once: true });
        }
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
          ...(args.subagent !== undefined ? { subagent: args.subagent } : {}),
        }),
        PERMISSION_OPTIONS(args.toolName),
        opts?.timeoutMs,
        opts?.signal,
      ),
    askTrust: (args, opts) =>
      enqueueConfirm<TrustAnswer>(
        (promptId) => ({
          type: 'trust:ask',
          ts: now(),
          promptId,
          path: args.path,
          agentsMd: args.agentsMd === true,
        }),
        TRUST_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
      ),
    askHistoryClear: (args, opts) =>
      enqueueConfirm<HistoryClearAnswer>(
        (promptId) => ({
          type: 'history-clear:ask',
          ts: now(),
          promptId,
          entryCount: args.entryCount,
          projectRoot: args.projectRoot,
        }),
        HISTORY_CLEAR_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
      ),
    askMemoryWrite: (args, opts) =>
      enqueueConfirm<MemoryWriteAnswer>(
        (promptId) => ({
          type: 'memory:write:ask',
          ts: now(),
          promptId,
          scope: args.scope,
          name: args.name,
          body: args.body,
        }),
        MEMORY_WRITE_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
      ),
    askMemoryUserScope: (args, opts) =>
      enqueueConfirm<MemoryWriteAnswer>(
        (promptId) => ({
          type: 'memory:user-scope:ask',
          ts: now(),
          promptId,
          name: args.name,
          body: args.body,
        }),
        MEMORY_USER_SCOPE_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
      ),
    askMemoryAction: (args, opts) =>
      enqueueConfirm<MemoryWriteAnswer>(
        (promptId) => ({
          type: 'memory:action:ask',
          ts: now(),
          promptId,
          action: args.action,
          title: args.title,
          subject: args.subject,
          preview: args.preview,
          question: args.question,
        }),
        MEMORY_ACTION_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
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
