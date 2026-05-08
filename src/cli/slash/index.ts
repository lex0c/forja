// Slash command public surface. Spec: UI.md §5.3.
//
// Imports each builtin, registers them, exports the registry +
// dispatcher entry point. The dispatcher (in repl.ts) calls
// `dispatch()` after parsing the user's slash input; this module
// owns the lookup-and-execute path.

import type { SubagentSet } from '../../subagents/index.ts';
import { budgetCommand } from './commands/budget.ts';
import { clearCommand } from './commands/clear.ts';
import { costCommand } from './commands/cost.ts';
import { critiqueCommand } from './commands/critique.ts';
import { buildHelpCommand } from './commands/help.ts';
import { historyCommand } from './commands/history.ts';
import { hooksCommand } from './commands/hooks.ts';
import { memoryCommand } from './commands/memory.ts';
import { modelCommand } from './commands/model.ts';
import { permsCommand } from './commands/perms.ts';
import { planCommand } from './commands/plan.ts';
import { buildPlaybookSlashCommands } from './commands/playbook.ts';
import { quitCommand } from './commands/quit.ts';
import { recapCommand } from './commands/recap.ts';
import { sessionsCommand } from './commands/sessions.ts';
import { subagentsCommand } from './commands/subagents.ts';
import { parseSlashInput } from './parse.ts';
import { type SlashRegistry, createRegistry } from './registry.ts';
import type { SlashCommand, SlashContext, SlashResult } from './types.ts';

export type { ParsedSlash } from './parse.ts';
export { parseSlashInput } from './parse.ts';
export type { SlashRegistry } from './registry.ts';
export { createRegistry } from './registry.ts';
export type { SlashCommand, SlashContext, SlashResult } from './types.ts';

// Build the canonical builtin registry. Help is built last so it
// can list every other command via `listCommands`. Order matters
// for /help output (operator reads top-to-bottom).
//
// `subagents` is optional: when provided, every definition with a
// `slash` field contributes one entry to the registry, registered
// AFTER builtins. A builtin name and a playbook slash colliding is
// the playbook author's mistake — the registry's duplicate-name
// check throws at construction so the operator sees the conflict
// at boot, not at first `/<conflict>` press. Builtins keep their
// names because the playbook is the new arrival; the author
// renames `slash:` in their .md to fix.
export const createBuiltinRegistry = (subagents?: SubagentSet): SlashRegistry => {
  // Two-pass: build the registry without help first, then add help
  // with a closure over its `list()`. Avoids the chicken-and-egg
  // (help needs to know about itself + everything).
  const builtinsWithoutHelp: readonly SlashCommand[] = [
    quitCommand,
    clearCommand,
    costCommand,
    critiqueCommand,
    sessionsCommand,
    recapCommand,
    subagentsCommand,
    modelCommand,
    planCommand,
    budgetCommand,
    permsCommand,
    historyCommand,
    memoryCommand,
    hooksCommand,
  ];
  const playbookCommands =
    subagents !== undefined ? buildPlaybookSlashCommands(subagents.byName.values()) : [];
  const allWithoutHelp: readonly SlashCommand[] = [...builtinsWithoutHelp, ...playbookCommands];
  const helpCommand = buildHelpCommand(() => [helpCommand, ...allWithoutHelp]);
  return createRegistry([helpCommand, ...allWithoutHelp]);
};

export interface DispatchOptions {
  registry: SlashRegistry;
  ctx: SlashContext;
  // Sink for unknown-command and execution errors. Defaults to
  // emitting an `error` UIEvent on the bus; tests inject collectors.
  errorSink?: (message: string) => void;
}

// Run a parsed slash input. Returns the SlashResult so callers
// (REPL) can react to `exit`. Notes from successful commands are
// emitted as warns on the bus before returning. Unknown command
// names produce a recognizable error so the dispatcher can surface
// "no such command: /<name>" without command-specific code.
export const dispatch = async (
  parsed: { name: string; args: string[] },
  options: DispatchOptions,
): Promise<SlashResult> => {
  const { registry, ctx } = options;
  const errorSink =
    options.errorSink ??
    ((m: string) => ctx.bus.emit({ type: 'error', ts: ctx.now(), message: m }));

  // Bare `/` is not an executable command — autocomplete handles
  // showing all options. Returning ok-no-notes so the dispatcher
  // doesn't surface an error for a UI-only state.
  if (parsed.name === '') return { kind: 'ok' };

  const cmd = registry.lookup(parsed.name);
  if (cmd === undefined) {
    const message = `unknown command: /${parsed.name} (try /help)`;
    errorSink(message);
    return { kind: 'error', message };
  }

  let result: SlashResult;
  try {
    result = await cmd.exec(parsed.args, ctx);
  } catch (e) {
    const message = `/${parsed.name} crashed: ${e instanceof Error ? e.message : String(e)}`;
    errorSink(message);
    return { kind: 'error', message };
  }

  // Emit successful command output as info lines so it lands in
  // scrollback without coloring it as a warning. Errors go through
  // `errorSink` (default = bus error event).
  if (result.kind === 'ok' && result.notes !== undefined) {
    for (const line of result.notes) {
      ctx.bus.emit({ type: 'info', ts: ctx.now(), message: line });
    }
  } else if (result.kind === 'error') {
    errorSink(result.message);
  }
  return result;
};

// Re-export for convenience: callers in repl.ts get the parser +
// dispatcher + registry from one path.
export { parseSlashInput as parseInput };
