// /quit — clean REPL shutdown.
//
// Signals the REPL via `requestShutdown()`; the actual exit happens
// through the same path as Ctrl+C-with-empty-buffer (drains a
// running turn first if any, closes DB, removes listeners, resolves
// the exit promise). The dispatcher returns `{kind: 'exit'}` so the
// caller knows to stop processing further commands in the queue
// (none in practice — slash commands aren't queued — but keeps
// the contract explicit).

import type { SlashCommand } from '../types.ts';

export const quitCommand: SlashCommand = {
  name: 'quit',
  description: 'exit the REPL cleanly',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return { kind: 'error', message: '/quit: takes no arguments' };
    }
    ctx.requestShutdown();
    return { kind: 'exit' };
  },
};
