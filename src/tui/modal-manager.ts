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

import type { McpTrustAnswer, McpTrustRequest } from '../mcp/types.ts';
import type { PolicyLayer } from '../permissions/index.ts';
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
  // Initial cursor position. Defaults to last option (D5/D65
  // conservative-choice convention) when undefined. Permission
  // flavor overrides to 0 (Yes) per operator UX call — the modal
  // is short enough that the safety-default ergonomics weren't
  // worth the extra keystroke for the dominant case.
  defaultIndex?: number;
  // Optional timeout handle so we can clear it on early resolve.
  timeout: unknown;
  // Detach the producer-signal abort listener on early resolve.
  // Without this, every ask whose modal resolved naturally
  // (operator answer, Esc, timeout) would leave a stale closure
  // attached to the ConfirmAskOptions.signal — for the subagent
  // permission-proxy path where N asks share one per-session
  // signal, that's N retained closures that fire as a useless
  // O(n) burst when the signal eventually aborts. Set when
  // the signal listener is wired; called by every resolve path
  // that isn't the abort itself. Optional because most asks
  // don't supply a signal.
  detachAbortListener?: () => void;
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
  // Layer that holds the matching rule (PolicyLayer). When set
  // alongside `rule`, the reducer renders "matched rule: <rule>
  // (<layer> policy)" so the operator knows which YAML to edit.
  // 'default' renders as "(built-in default)" — distinct from
  // any layer-written rule. Optional for backwards compat with
  // synthesized Decisions / subagent-proxied confirms (where
  // IPC doesn't marshal source yet).
  layer?: PolicyLayer;
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

// Relay-start flavor — `/relay` confirm before opening the mesh socket
// (MESH.md §6.1). yes → start serving, no/cancel → stay off.
export interface RelayStartAskArgs {
  alias: string;
}
export type RelayStartAnswer = 'yes' | 'no' | 'cancel';

// Shared-corpus trust re-confirmation flavor (MEMORY.md §6.5.2
// `trust_revoked` detector). Distinct from `TrustAskArgs` even though
// the answer shape is identical — the producer wires very different
// consequences to `no/cancel` (bulk-invalidate / defer vs exit), so
// keeping the type discriminant strict prevents a future refactor
// from accidentally swapping them.
export interface SharedTrustAskArgs {
  // Absolute path of the shared-corpus root (`<repo>/.forja/memory/shared`).
  path: string;
  // 'first-visit' (no prior trust row + non-empty corpus) vs 'drift'
  // (prior row but hash diverged). Reducer adapts the prose to match.
  mode: import('../memory/trust-corpus-probe.ts').SharedTrustModalMode;
  // Current corpus snapshot — name + byte length per file. Renderer
  // wraps long lists with an explicit "(N more)" suffix; the
  // producer should NOT pre-truncate so the audit event carries the
  // full inventory. Filenames may contain operator-untrusted bytes
  // (attacker with commit access on `.forja/memory/shared/`); the
  // reducer sanitizes before rendering.
  corpusFiles: readonly { name: string; bytes: number }[];
}

export type SharedTrustAnswer = 'yes' | 'no' | 'cancel';

// History-clear flavor (HISTORY.md §2.3 `/history clear` modal).
// `yes` = clear only, `yes-disable` = clear + write the
// `.forja/no-history` marker (permanent per-project opt-out), `no` =
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
// `/memory demote local`, `/memory restore`, `/memory quarantine`.
// Caller constructs the copy; manager just queues the modal.
// `action` is forwarded to the event for audit / telemetry.
export interface MemoryActionAskArgs {
  action: 'delete' | 'promote' | 'demote' | 'restore' | 'quarantine';
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

// Relay-start flavor's option list. Kept in sync with the reducer's
// `relay-start:ask` ConfirmState construction in state.ts.
const RELAY_START_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, start serving', value: 'yes' },
  { key: '2', label: 'No, cancel', value: 'no' },
];

// Shared-corpus re-confirm flavor. Verbs differ from `TRUST_OPTIONS`
// on purpose: a re-prompt isn't a first-visit decision, and "No,
// revoke" makes the consequence explicit (the shared corpus will be
// invalidated; the operator does NOT exit the session). Conservative-
// default (last position per D5/D65) is the revoke path — operator
// hitting Enter without reading errs toward "I don't trust this
// change", which is the safer outcome for a corpus the model would
// otherwise eager-load every turn.
const SHARED_TRUST_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, I trust the updated corpus', value: 'yes' },
  { key: '2', label: 'No, revoke trust', value: 'no' },
];

// MCP manifest-trust flavor (MCP.md §1.5). Two options; cancel is the
// Esc/timeout outcome. Conservative-default (last) = "do not run it" — an
// operator hitting Enter without reading errs toward NOT spawning an untrusted
// binary, the safe outcome.
const MCP_TRUST_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, I trust this server', value: 'yes' },
  { key: '2', label: 'No, do not run it', value: 'no' },
];

// History-clear flavor (HISTORY.md §2.3). Kept in sync with the
// reducer's `history-clear:ask` ConfirmState construction.
const HISTORY_CLEAR_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, wipe', value: 'yes' },
  { key: '2', label: 'Yes, wipe and disable persistence', value: 'yes-disable' },
  { key: '3', label: 'No', value: 'no' },
];

// Memory-write flavor (MEMORY.md §5.1). Two options — persist the
// proposed memory or skip. Labels match what the reducer constructs
// in its `memory:write:ask` case so the manager's option list and the
// rendered modal stay in sync.
const MEMORY_WRITE_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'Yes, write memory', value: 'yes' },
  { key: '2', label: 'No, skip', value: 'no' },
];

// Memory-write flavor's initial cursor position. Single source of
// truth shared with the reducer's `memory:write:ask` case (imported
// there), exactly like PERMISSION_DEFAULT_SELECTED_INDEX. Writing the
// proposed memory is the expected outcome of the prompt, so the cursor
// defaults to the first option (Yes) and Enter accepts — a deliberate
// break from the D5/D65 last-option-safe default for this flavor.
// Without this shared constant the manager (which decides what Enter
// resolves) and the reducer (which decides where the cursor paints)
// drifted: the reducer moved its initial index to 0 (Yes) but the
// manager kept the default last-option, so the cursor showed Yes while
// Enter silently resolved No (skip) — the write never happened.
export const MEMORY_WRITE_DEFAULT_SELECTED_INDEX = 0;

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

// Permission flavor's option list. Source of truth for both the
// modal-manager (uses `.length` for selection clamping in
// moveSelection) and the reducer (renders the labels via state).
// Exported so the reducer's `permission:ask` case calls the same
// builder — without a single source, the manager's count and the
// reducer's labels could drift on a future field addition and
// break the cursor's clamp.
//
// Two options today: Yes / No. The previous "session-allow"
// option was removed — promoting a rule onto the engine's
// in-memory allowlist mid-modal lets an operator widen authority
// without a chance to revoke for the rest of the session, and
// every operator who needs that workflow can edit
// `.forja/permissions.yaml` (or run `/perms` slash commands when
// they land) with the full layered policy view in front of them.
// `engine.addSessionAllow` stays on the API surface for those
// non-modal paths.
export const buildPermissionOptions = (): ConfirmOption[] => [
  { key: '1', label: 'Yes', value: 'yes' },
  { key: '2', label: 'No', value: 'no' },
];

// Permission flavor's initial cursor position. Single source of
// truth for BOTH (a) the manager's `drain()`, which determines what
// Enter resolves to, and (b) the reducer's `permission:ask` case,
// which determines where the cursor renders. Without this shared
// constant the two sides could drift on a flip and the operator
// would see the cursor on one option while Enter resolved the
// other — silent but catastrophic on a security modal.
export const PERMISSION_DEFAULT_SELECTED_INDEX = 0;

// Clarify flavor (STATE_MACHINE §12). Producer is the `clarify` tool's
// modal bridge (ToolContext.clarify). One question + options per ask,
// raised as a ConfirmState (flavor 'clarify') and resolved through the
// generic select/answer machinery. Resolves `resolved` + the chosen
// option id, or `skipped` on Esc / timeout (the tool maps a skip to
// options[0]). `escalated` (edit-goal) is a later affordance.
export interface ClarifyAskArgs {
  question: string;
  why: string | null;
  options: ReadonlyArray<{ id: string; label: string }>;
}
export type ClarifyManagerAnswer =
  | { outcome: 'resolved'; chosen_option_id: string }
  | { outcome: 'skipped' };

// Resume-mode flavor (resume "from summary" feature). Raised at boot for an
// interactive `--resume` without a `--resume-mode` flag.
export interface ResumeModeAskArgs {
  // Full persisted message count — surfaced in the modal preview.
  totalCount: number;
}
// 'capped' is the Esc/cancel fallback (the bounded default resume window).
export type ResumeModeAnswer = 'full' | 'summary' | 'capped';

// Summary is FIRST and the default cursor (index 0): compacting older turns is
// the recommended resume — it keeps the model's context lean and is what most
// resumes want. Full (load everything) is the deliberate opt-out below it.
const RESUME_MODE_OPTIONS: readonly ConfirmOption[] = [
  { key: '1', label: 'From summary (recommended)', value: 'summary' },
  { key: '2', label: 'Full session', value: 'full' },
];

export interface ModalManager {
  // Permission flavor. Returns the user's choice (or 'cancel' on Esc /
  // close / timeout). Callers translate semantics: yes → execute,
  // no/cancel → deny. Session-scoped promotion (was option 2)
  // shipped via the engine's addSessionAllow API only — never from
  // inside the modal flow.
  askPermission: (args: PermissionAskArgs, opts?: ConfirmAskOptions) => Promise<PermissionAnswer>;
  // Trust flavor. Returns the operator's choice (or 'cancel' on Esc /
  // close / timeout). Caller (REPL boot) translates: yes → persist
  // and continue, no/cancel → exit before entering the REPL. Spec
  // §9.1 calls for a 5-minute timeout that defaults to read-only —
  // we forward that via `opts.timeoutMs` so the producer decides.
  askTrust: (args: TrustAskArgs, opts?: ConfirmAskOptions) => Promise<TrustAnswer>;
  // Relay-start flavor (MESH.md §6.1). Producer: the /relay command. yes →
  // startServing, no/cancel → stay off.
  askRelayStart: (args: RelayStartAskArgs, opts?: ConfirmAskOptions) => Promise<RelayStartAnswer>;
  // Shared-corpus trust re-confirmation flavor. Producer: REPL boot,
  // after bootstrap, when `shared_corpus_trust` carries a row for the
  // current scope-root AND its `last_confirmed_hash` differs from the
  // freshly-computed fingerprint. Caller maps the answer: yes →
  // re-stamp the trust row with the new hash and continue; no/cancel
  // → clear the trust row, run the bulk-invalidate path (T5.3), and
  // continue the REPL with shared/ memories in `invalidated` state.
  askSharedTrust: (
    args: SharedTrustAskArgs,
    opts?: ConfirmAskOptions,
  ) => Promise<SharedTrustAnswer>;
  // MCP server manifest-trust modal (MCP.md §1.5). Reuses the McpTrustRequest
  // the manager already builds (server + spawned command + tool inventory +
  // manifest hash). Answer maps: yes → grant + register, no/cancel → deny.
  askMcpTrust: (req: McpTrustRequest, opts?: ConfirmAskOptions) => Promise<McpTrustAnswer>;
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
  // Clarify flavor (STATE_MACHINE §12). Producer is the clarify tool's
  // modal bridge. Resolves with the operator's pick or `skipped`.
  askClarify: (args: ClarifyAskArgs, opts?: ConfirmAskOptions) => Promise<ClarifyManagerAnswer>;
  // Resume-mode selection. Resolves 'full' / 'summary', or 'capped' on
  // Esc / close / timeout (the safe bounded-window fallback).
  askResumeMode: (args: ResumeModeAskArgs, opts?: ConfirmAskOptions) => Promise<ResumeModeAnswer>;
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

// askClarify routes through enqueueConfirm, whose Esc / timeout / Ctrl+C
// paths all resolve the reserved string `cancel`. Option values are
// model-supplied ids, so each is prefixed to stay disjoint from that
// sentinel — an option literally id'd `cancel` must read as a pick, not
// a skip, or the operator's explicit choice is silently dropped.
const CLARIFY_OPTION_VALUE_PREFIX = 'opt:';

// Option hotkeys are GENERATED, never the model-supplied id. matchesKey
// compares a `kind:'key'` event by name, so an id like 'down' / 'up' /
// 'escape' / 'enter' would match the arrow/Esc/Enter event — and the
// hotkey check runs before the nav handlers (drain's activeHandler), so
// such an id would hijack navigation or skip. Safe single chars (a, b,
// c, …) are `kind:'char'` only, so named keys fall through to their
// handlers. Past 26 options the hotkey is '' (matches nothing —
// cursor-only); clarify prompts realistically have a handful. The id
// stays the resolved value.
const CLARIFY_HOTKEYS = 'abcdefghijklmnopqrstuvwxyz';
const clarifyHotkey = (index: number): string => CLARIFY_HOTKEYS[index] ?? '';

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
    // Default selectedIndex = last option (D5/D65 conservative
    // choice). Per-flavor override flows via `pending.defaultIndex`
    // — permission flavor uses 0 (Yes) so the dominant accept-the-
    // call workflow doesn't require an extra keystroke.
    const max = next.options.length - 1;
    const requested = next.defaultIndex ?? max;
    const initialIndex = Math.max(0, Math.min(max, requested));
    active = { promptId, selectedIndex: initialIndex, pending: next };
    // Register the focus handler BEFORE the open-time bus emits below.
    // bus.emit is synchronous and EventEmitter does NOT isolate listener
    // exceptions, so a throwing `onAny` listener (renderer fold, NDJSON
    // forwarder) during those emits would otherwise propagate out of
    // drain() with `active` already set but no handler pushed — a modal
    // the operator can't dismiss. Pushing first means the worst a
    // throwing listener can do is skip a state-fold update, never strand
    // the modal without input. The handler only fires on key dispatch
    // (never during emit), so its earlier registration is inert until
    // the operator types.
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
    // Open-time state-fold events, emitted AFTER the handler is pushed
    // (see above) and AFTER `next.open()` so the reducer has already
    // created the modal slot (its mismatched-promptId guard would drop
    // them otherwise). The manager doesn't subscribe to the bus, so
    // these never re-enter drain().
    //
    // modal:select pushes the manager's initial cursor to the reducer so
    // the RENDERED cursor is forced to match what Enter resolves
    // (active.selectedIndex). The reducer's `*:ask` handler seeds a
    // per-flavor default, but the manager owns the resolution index —
    // this makes the manager the single source, so the two can never
    // visually disagree (the class behind the memory-write "cursor on
    // Yes but Enter resolved No" bug: a drifted reducer default is
    // overwritten here on open instead of mismatching).
    bus.emit({
      type: 'modal:select',
      ts: now(),
      promptId,
      selectedIndex: initialIndex,
    });
    // queue-depth snapshot for the just-opened modal. `queue.length`
    // reflects what's STILL waiting AFTER popping this one (see
    // queue.shift above) — exactly the count the renderer's
    // `(+N waiting)` suffix needs.
    if (queue.length > 0) {
      bus.emit({
        type: 'modal:queue-depth',
        ts: now(),
        promptId,
        depth: queue.length,
      });
    }
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
    // Detach the producer-signal abort listener (if any) so a
    // late signal abort doesn't fire a stale callback for a
    // modal that already resolved naturally. Idempotent — no-op
    // for asks that didn't supply a signal, no-op if the
    // listener already auto-removed via `once: true` (the
    // signal-abort path that routes through here).
    pending.detachAbortListener?.();
    if (activeHandler !== null) {
      focusStack.remove(activeHandler);
      activeHandler = null;
    }
    active = null;
    // Emit the answer event BEFORE resolving the promise so any
    // listener (audit, telemetry) sees the resolution before the
    // caller's `.then` runs. `decision` is a flavor-specific string
    // — `permission` uses 'yes'/'no'/'cancel', `trust` uses
    // 'yes'/'no'/'cancel', etc. Consumers narrow per-flavor
    // by reading the original `*:ask` event.
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
    defaultIndex?: number,
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
        ...(defaultIndex !== undefined ? { defaultIndex } : {}),
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
          // Active path: resolveActive detaches the abort
          // listener AND clears the timeout for us. Single
          // exit point, no per-branch cleanup duplication.
          resolveActive('cancel');
          return;
        }
        const idx = queue.indexOf(pending as Pending);
        if (idx >= 0) queue.splice(idx, 1);
        // Queued path: detach here too so a stale signal
        // listener doesn't outlive the resolved pending, AND
        // clear the scheduled timeout. Without the clearTimer
        // a queued modal cancelled via signal would leave its
        // timer running until it fires (no-op at fire time —
        // pending.resolve is a no-op on settled promises — but
        // the timer keeps the event loop alive longer than the
        // run intended and adds avoidable callback churn for
        // every aborted queued modal). Idempotent: clearTimer
        // on an already-fired or already-cleared handle is a
        // no-op.
        pending.detachAbortListener?.();
        if (pending.timeout !== null && pending.timeout !== undefined) {
          clearTimer(pending.timeout);
        }
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
          // Track the listener so resolve paths that DON'T go
          // through the abort itself (operator answer, Esc,
          // timeout) can detach it. Without this, every modal
          // that resolved naturally would leave a stale
          // closure attached to `signal` until it eventually
          // aborts — a problem for the subagent permission
          // proxy where one per-session signal collects
          // listeners across N asks and fires all of them as a
          // useless O(n) burst when the channel finally closes.
          // Local-bind `signal` so the closure narrows past
          // the optional param.
          const liveSignal = signal;
          pending.detachAbortListener = () => {
            liveSignal.removeEventListener('abort', cancelPending);
          };
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
          ...(args.layer !== undefined ? { layer: args.layer } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          ...(args.subagent !== undefined ? { subagent: args.subagent } : {}),
        }),
        buildPermissionOptions(),
        opts?.timeoutMs,
        opts?.signal,
        // Permission flavor overrides D5/D65's "last = safe"
        // default — accept-the-call is the dominant workflow on a
        // small modal and operators don't want the extra keystroke.
        // Other flavors keep the last-option default by omitting
        // this argument.
        PERMISSION_DEFAULT_SELECTED_INDEX,
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
    askRelayStart: (args, opts) =>
      enqueueConfirm<RelayStartAnswer>(
        (promptId) => ({
          type: 'relay-start:ask',
          ts: now(),
          promptId,
          alias: args.alias,
        }),
        RELAY_START_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
      ),
    askSharedTrust: (args, opts) =>
      enqueueConfirm<SharedTrustAnswer>(
        (promptId) => ({
          type: 'shared-trust:ask',
          ts: now(),
          promptId,
          path: args.path,
          mode: args.mode,
          corpusFiles: args.corpusFiles,
        }),
        SHARED_TRUST_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
      ),
    askMcpTrust: (req, opts) =>
      enqueueConfirm<McpTrustAnswer>(
        (promptId) => ({
          type: 'mcp-trust:ask',
          ts: now(),
          promptId,
          server: req.server,
          command: req.command,
          ...(req.env !== undefined ? { env: req.env } : {}),
          ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
          mode: req.mode,
          sandbox: req.sandbox,
          tools: req.tools,
          manifestHash: req.manifestHash,
          preConnect: req.preConnect === true,
        }),
        MCP_TRUST_OPTIONS,
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
        // Cursor defaults to Yes (write) — break from the last-option
        // default, shared with the reducer so the rendered cursor and
        // what Enter resolves can't drift apart.
        MEMORY_WRITE_DEFAULT_SELECTED_INDEX,
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
    askClarify: (args, opts) =>
      enqueueConfirm<string>(
        (promptId) => ({
          type: 'clarify:ask',
          ts: now(),
          promptId,
          question: args.question,
          why: args.why,
          // Same generated hotkey (by index) the resolution list uses
          // below — the reducer folds these into the rendered keys, so
          // the key shown == the key that activates.
          options: args.options.map((o, i) => ({
            id: o.id,
            label: o.label,
            key: clarifyHotkey(i),
          })),
        }),
        args.options.map((o, i) => ({
          key: clarifyHotkey(i),
          label: o.label,
          value: `${CLARIFY_OPTION_VALUE_PREFIX}${o.id}`,
        })),
        opts?.timeoutMs,
        opts?.signal,
        // Cursor starts on the first option — also the skip default the
        // tool assumes (options[0]).
        0,
      ).then(
        (value): ClarifyManagerAnswer =>
          value === 'cancel'
            ? { outcome: 'skipped' }
            : {
                outcome: 'resolved',
                chosen_option_id: value.slice(CLARIFY_OPTION_VALUE_PREFIX.length),
              },
      ),
    askResumeMode: (args, opts) =>
      enqueueConfirm<'full' | 'summary' | 'cancel'>(
        (promptId) => ({
          type: 'resumemode:ask',
          ts: now(),
          promptId,
          totalCount: args.totalCount,
        }),
        RESUME_MODE_OPTIONS,
        opts?.timeoutMs,
        opts?.signal,
        // Cursor on the first option (From summary — the recommended default).
        // Matches the reducer's resumemode:ask selectedIndex so paint and Enter
        // agree.
        0,
      ).then((value): ResumeModeAnswer => (value === 'cancel' ? 'capped' : value)),
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
        // Detach the producer-signal abort listener (if any) for
        // every drained pending. close() resolves the promises
        // directly instead of routing through resolveActive /
        // cancelPending, so neither of those cleanup callsites
        // runs here. Without this loop, a long-lived caller that
        // closes the manager while sharing one AbortSignal across
        // many pending asks (subagent permission proxy) would
        // leave N stale closures attached to the signal —
        // retained until the signal eventually aborts, then
        // firing as a useless O(n) burst. detachAbortListener is
        // optional (only set when the ask supplied a signal), so
        // the optional-chain call is safe for asks that didn't.
        p.detachAbortListener?.();
        p.resolve('cancel');
      }
    },
  };
};
