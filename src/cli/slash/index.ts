// Slash command public surface. Spec: UI.md §5.3.
//
// Imports each builtin, registers them, exports the registry +
// dispatcher entry point. The dispatcher (in repl.ts) calls
// `dispatch()` after parsing the user's slash input; this module
// owns the lookup-and-execute path.

import { agentPolicyCommand } from './commands/agent-policy.ts';
import { budgetCommand } from './commands/budget.ts';
import { clearCommand } from './commands/clear.ts';
import { compactCommand } from './commands/compact.ts';
import { costCommand } from './commands/cost.ts';
import { effortCommand } from './commands/effort.ts';
import { buildHelpCommand } from './commands/help.ts';
import { historyCommand } from './commands/history.ts';
import { hooksCommand } from './commands/hooks.ts';
import { mcpCommand } from './commands/mcp.ts';
import { memoryCommand } from './commands/memory.ts';
import { modelCommand } from './commands/model.ts';
import { permsCommand } from './commands/perms.ts';
import { quitCommand } from './commands/quit.ts';
import { recapCommand } from './commands/recap.ts';
import { sessionsCommand } from './commands/sessions.ts';
import { skillCommand } from './commands/skill.ts';
import { statsCommand } from './commands/stats.ts';
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
// Playbooks have no operator-facing slash command (the `/review`-style
// shortcuts were withdrawn). They stay reachable via task_sync /
// task_async and the model's playbook hint.
export const createBuiltinRegistry = (): SlashRegistry => {
  // Two-pass: build the registry without help first, then add help
  // with a closure over its `list()`. Avoids the chicken-and-egg
  // (help needs to know about itself + everything).
  const builtinsWithoutHelp: readonly SlashCommand[] = [
    quitCommand,
    clearCommand,
    compactCommand,
    costCommand,
    statsCommand,
    sessionsCommand,
    recapCommand,
    subagentsCommand,
    modelCommand,
    budgetCommand,
    effortCommand,
    permsCommand,
    historyCommand,
    memoryCommand,
    mcpCommand,
    // `/pin` withdrawn: with pin_context also pulled from the model,
    // no surface creates context pins anymore. pinCommand + its test
    // and the context_pins store/infra stay intact (dormant) — only
    // the slash entry is removed (see BACKLOG 2026-06-15).
    hooksCommand,
    agentPolicyCommand,
    skillCommand,
  ];
  const allWithoutHelp: readonly SlashCommand[] = builtinsWithoutHelp;
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
