// /clear — wipe the visible scrollback (terminal Ctrl+L behavior).
//
// Emits a `screen:clear` UIEvent the renderer interprets as "write
// the ANSI clear-screen escape and redraw the live region".
// Scrollback above the visible area is preserved by the terminal
// (xterm `\x1b[2J\x1b[H` doesn't touch it).
//
// Distinct from a session reset: the harness state, history,
// running turn — all unaffected.
//
// Modal-up guard lives in the renderer's `screen:clear` handler
// (renderer.ts) — it skips the clear when state.modal !== null so
// the modal frame doesn't get wiped mid-decision. A guard here
// would be redundant for the slash path (modal handler swallows
// keys before the editor handler runs, so /clear is unreachable
// while modal is up via slash) but the renderer-side guard catches
// any other producer that emits screen:clear directly.

import type { SlashCommand } from '../types.ts';

export const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'clear the visible scrollback (preserves session)',
  exec: async (args, ctx) => {
    if (args.length > 0) {
      return { kind: 'error', message: '/clear: takes no arguments' };
    }
    ctx.bus.emit({ type: 'screen:clear', ts: ctx.now() });
    return { kind: 'ok' };
  },
};
