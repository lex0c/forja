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

import type { HarnessConfig } from '../../harness/index.ts';
import type { DB } from '../../storage/index.ts';
import type { Bus } from '../../tui/bus.ts';
import type { ModalManager } from '../../tui/modal-manager.ts';

export interface SlashContext {
  // Read-only snapshot of the harness config the REPL bootstrapped
  // with. Commands read model id, plan flag, budget caps from here.
  // Mutation commands (future slice) will need a different shape.
  baseConfig: HarnessConfig;
  // Persistent DB handle for commands that read history (/sessions).
  db: DB;
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
  // Execute. `args` is the parsed positional args (everything after
  // the command name, split on whitespace, leading/trailing trimmed).
  // Tests verify per-command args parsing; commands assume `args`
  // is a clean array.
  exec: (args: string[], ctx: SlashContext) => Promise<SlashResult>;
}
