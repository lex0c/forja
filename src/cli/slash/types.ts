// Slash command types. Spec: UI.md §5.3.
//
// Commands are async (some need DB IO — `/sessions` reads recent
// runs, `/cost` reads cumulative usage). Each command receives a
// `SlashContext` carrying handles to the bus, modal manager, REPL
// state, and config — enough to surface output as scrollback warns,
// open a modal, or trigger shutdown.
//
// Commands return a `SlashResult` rather than mutating state
// directly. Lets the dispatcher gate side effects through one path
// (audit, error handling, future telemetry) instead of scattering
// `bus.emit` calls across every command.

import type { HarnessConfig, SessionContext } from '../../harness/index.ts';
import type { HookChainResult, HookEventPayload } from '../../hooks/types.ts';
import type { ModelRegistry } from '../../providers/registry.ts';
import type { DB } from '../../storage/index.ts';
import type { ContextPinsStore } from '../../storage/repos/context-pins.ts';
import type { Bus } from '../../tui/bus.ts';
import type { ModalManager } from '../../tui/modal-manager.ts';

export interface SlashContext {
  // Shared mutable harness-config handle the REPL bootstrapped
  // with. Commands read model id and budget caps from
  // here. Mutation commands (`/model`, `/memory governance
  // enable|disable`) update fields IN PLACE; the next `startTurn`
  // reads the updated value via its spread copy. Current in-flight
  // turn is unaffected — its config was already snapshot at turn
  // start.
  baseConfig: HarnessConfig;
  // Persistent DB handle for commands that read history (/sessions).
  db: DB;
  // Model registry for /model <id> mutation. Threaded from the REPL
  // (which builds it once at boot via createDefaultRegistry) so the
  // command can lookup + factory the new provider without re-importing
  // the registry module — keeps the command unit-testable with a
  // fixture registry instead of the full default set.
  modelRegistry: ModelRegistry;
  // Bus for emitting scrollback warns, errors, info, status updates.
  bus: Bus;
  // Modal manager for /help (and future flavors that need a modal).
  modalManager: ModalManager;
  // Cumulative-cost tracker the REPL maintains across turns. /cost
  // reads it. Numbers are USD; the bridge formats for display.
  cumulative: {
    costUsd: number;
    steps: number;
    turns: number;
  };
  // Wall-clock source for emitted UIEvents. Defaults to Date.now in
  // production; tests inject a counter.
  now: () => number;
  // Trigger REPL shutdown (cleanly: aborts running turn if any,
  // closes db, removes listeners). Used by /quit.
  requestShutdown: () => void;
  // True when a turn is in flight. Used by mutation commands to
  // append a "current turn already snapshot its config" cue to the
  // confirmation note — without this, an operator who mutates mid-
  // turn might assume the new value applies to the in-flight prompt
  // (it doesn't; the harness reads its config exactly once at
  // startTurn). Read fresh per-call so a turn that started AFTER
  // the slash command was queued still reports correctly.
  isRunning: () => boolean;
  // Most recent session id, or null when no turn has run yet in
  // this REPL instance. Slash commands that emit audit rows
  // (today only `/memory show` via `registry.read`) forward this
  // as `auditSessionId` so the row groups with the operator's
  // current session in `/memory audit` queries. Closure / getter
  // (not static field) because the SlashContext is built once at
  // REPL boot but the session id only exists after the first
  // turn's `session_finished` event lands. Returns null between
  // boot and first turn — callers MUST treat null as "skip the
  // attribution override" rather than passing it through.
  currentSessionId: () => string | null;
  // All session ids the REPL has tracked since boot, oldest
  // first. Each finished turn pushes its session id; playbook
  // subagent dispatches push the child's session id too. Slash
  // commands that aggregate across the whole REPL read this instead
  // of `currentSessionId` so an operator running 5 turns + 1
  // playbook sees data from all 6 sessions, not just the last one.
  // Empty until the first turn finishes — caller treats `[]` as
  // "no sessions yet".
  replSessionIds: () => readonly string[];
  // History controls (HISTORY.md §2.3). `/history off` / `/history on`
  // toggle the session-volatile flag; `/history clear` invokes
  // `clearLocal` AFTER the storage layer wipe so the in-memory
  // mirror used by ↑/↓ recall is dropped in lockstep. Optional so
  // tests / headless contexts that don't run the REPL editor can
  // omit the wiring.
  //
  // `optOutReason` exposes the storage-level opt-out (env / file
  // marker, HISTORY.md §3.3 levels 1+2) so `/history on` can refuse
  // a no-op re-enable: if env says "off", flipping the session flag
  // to "on" is a lie because the storage layer will keep no-opping.
  // `null` = persistence is on at the storage level.
  history?: {
    isEnabled: () => boolean;
    setEnabled: (enabled: boolean) => void;
    clearLocal: () => void;
    optOutReason: () => 'env' | 'file-marker' | null;
  };
  // Pinned context store (CONTEXT_TUNING.md §12.4). Wrap of the
  // db handle so /pin doesn't reach into raw context_pins queries.
  // REPL constructs once at boot via createContextPinsStore(db);
  // tests inject a degenerate one. Absent ⇒ /pin surfaces
  // "store unavailable" cleanly. Same shape as the
  // contextPinsStore field on ToolContext (pin_context tool reads
  // through there); the SlashContext copy is what /pin uses
  // because slash commands don't run inside a ToolContext.
  contextPinsStore?: ContextPinsStore;
  // Hook dispatcher (AGENTIC_CLI.md §10.3 + EVICTION.md §10.3).
  // Wraps `dispatchChain` against the REPL-resolved hooks. Slash
  // commands that emit hook events (today: /memory delete + /memory
  // restore via the Eviction event) thread this into the
  // transitionMemoryState `fireHook` field. Absent in headless /
  // test contexts that don't load hooks.toml; transitions then
  // skip the hook gate entirely (same path as the harness loop's
  // empty-chain short-circuit). Null return mirrors that path so
  // call sites don't branch on the discriminator.
  dispatchHooks?: (payload: HookEventPayload) => Promise<HookChainResult | null>;
  // Live in-memory session context (project_message_single_source).
  // Getter because the REPL holds it and it only exists after the first
  // turn. /compact uses it to compact the conversation the model sees,
  // in place, for the live session. Absent in tests/headless that hold
  // no context ⇒ /compact reports "no live session" cleanly.
  liveContext?: () => SessionContext | null;
  // Run a mutating slash action (today /compact) under the REPL's busy flag
  // so a concurrent turn or a second invocation can't start mid-await and
  // race the live context. The REPL holds `isBusy()` true for the whole fn,
  // and passes an AbortSignal that fires on operator interrupt (Ctrl+C); the
  // fn composes it with its own timeout so a stalled call can't wedge the
  // REPL. Absent in tests/headless — callers run fn directly (no signal).
  runExclusive?: <T>(fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  // Recompute the footer's DB-derived usage chips (cost/token/cache) and
  // push them to the renderer. A mutating slash command that changes the
  // persisted totals (today /compact, which bills a summary call into
  // sessions.total_cost_usd + compaction_events) must call this, otherwise
  // the footer — which is SET only from stats:refresh — stays stale until a
  // later turn/playbook boundary, disagreeing with /stats and /cost (which
  // read the DB on demand). Absent in tests/headless (no live footer).
  refreshStats?: () => void;
}

// Outcome of executing a command. The dispatcher emits any messages
// to the bus and decides what to do with `exit`.
export type SlashResult =
  // Command completed successfully. `notes` (if any) get rendered
  // as warn lines in scrollback so the user sees output without
  // needing a separate render path.
  | { kind: 'ok'; notes?: string[] }
  // Command failed (usage error, IO error). `message` shown as
  // error line.
  | { kind: 'error'; message: string }
  // Command requested REPL exit. /quit. Dispatcher calls
  // ctx.requestShutdown() and resolves; exit happens once the
  // current turn (if any) settles.
  | { kind: 'exit' };

export interface SlashCommand {
  // Bare name (no leading /). Lowercase, snake-case. Used as
  // registry key + autocomplete match prefix.
  name: string;
  // One-line description for the autocomplete popover and the
  // /help modal. Keep under 60 chars.
  description: string;
  // Optional arg syntax shown as a dim inline ghost after the command
  // name in the input box once it's fully typed (e.g. `[low|medium|high]`
  // for `/effort`). Just the args portion — no leading slash, no command
  // name. Commands that take no args omit it. Keep it short: the input
  // renderer drops it when it would overflow the row.
  argHint?: string;
  // Execute. `args` is the parsed positional args (everything after
  // the command name, split on whitespace, leading/trailing trimmed).
  // Tests verify per-command args parsing; commands assume `args`
  // is a clean array.
  exec: (args: string[], ctx: SlashContext) => Promise<SlashResult>;
}
