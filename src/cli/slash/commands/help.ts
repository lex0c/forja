// /help — list every registered command in scrollback.
//
// Output goes via the dispatcher's `notes` mechanism (rendered as
// warn lines). A modal-style "info popup" would be a separate
// rendering pattern from "ask user for decision"; we don't have an
// info flavor yet, so warn-list keeps the slice scoped and the
// output stays in scrollback for review.

import type { SlashCommand } from '../types.ts';

export const buildHelpCommand = (listCommands: () => SlashCommand[]): SlashCommand => ({
  name: 'help',
  description: 'show all slash commands',
  exec: async (args, _ctx) => {
    if (args.length > 0) {
      return { kind: 'error', message: '/help: takes no arguments' };
    }
    const cmds = listCommands();
    // Two-column layout: `/<name>` padded to the longest, then desc.
    const longest = cmds.reduce((max, c) => Math.max(max, c.name.length), 0);
    const lines = cmds.map((c) => `/${c.name.padEnd(longest)}  ${c.description}`);
    return { kind: 'ok', notes: ['Slash commands:', ...lines] };
  },
});
