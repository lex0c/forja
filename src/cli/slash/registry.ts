// Slash command registry. Spec: UI.md §5.3.
//
// Dictionary keyed by command name. Lookup is exact-match (no
// fuzzy / no abbreviations); autocomplete uses prefix matching for
// the popover but execution requires the full name.
//
// Single registry per REPL instance. Built once at boot from the
// builtin commands; future plugin extension would push more entries
// here. No global mutable state.

import type { SlashCommand } from './types.ts';

export interface SlashRegistry {
  // Exact name → command, or undefined.
  lookup: (name: string) => SlashCommand | undefined;
  // Prefix matches sorted by name; bare prefix (empty string)
  // returns ALL commands. Used by the autocomplete popover. Caller
  // decides the cap (spec §5.3 says max 8 visible) — registry
  // returns the full list.
  complete: (prefix: string) => SlashCommand[];
  // All commands in registration order. Used by /help to render the
  // table.
  list: () => SlashCommand[];
}

export const createRegistry = (commands: readonly SlashCommand[]): SlashRegistry => {
  const byName = new Map<string, SlashCommand>();
  const ordered: SlashCommand[] = [];
  for (const cmd of commands) {
    if (byName.has(cmd.name)) {
      // Duplicate registration is a programmer bug, not user input —
      // throw at construction time so it surfaces in tests, not
      // mid-session.
      throw new Error(`slash registry: duplicate command name '${cmd.name}'`);
    }
    byName.set(cmd.name, cmd);
    ordered.push(cmd);
  }
  return {
    lookup: (name) => byName.get(name),
    // Both empty + prefix paths return registration order so the
    // popover sequence stays predictable as the user types — first
    // typed character shouldn't reshuffle the visible list.
    complete: (prefix) => {
      if (prefix === '') return ordered.slice();
      const lower = prefix.toLowerCase();
      return ordered.filter((c) => c.name.toLowerCase().startsWith(lower));
    },
    list: () => ordered.slice(),
  };
};
