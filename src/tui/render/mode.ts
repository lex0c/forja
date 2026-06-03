// Shared input-mode predicates for the live region. Single source of
// truth so every render site agrees — the input prompt/color, the rules
// around it, the cursor strip (composeCursor), and the footer indicator
// MUST compute "bash mode" identically or they desync (a yellow input
// with a `> ` prompt, or a caret one column off).

import type { LiveState } from '../state.ts';

// "Is a turn in flight right now?" — true across the WHOLE turn, not
// just the instants a tool or stream is live. Includes `awaitingProvider`
// (the model deliberating before the first token — often the LONGEST
// phase of a turn); without it the predicate flickers off during that
// wait. Used by the footer to choose the interrupt cue, and by
// `isBashMode` to refuse the shell-escape visuals mid-turn.
export const isTurnRunning = (state: LiveState): boolean =>
  state.activeTools.size > 0 ||
  state.thinking !== null ||
  state.pendingAssistant !== null ||
  state.awaitingProvider !== null;

// Bash mode: the operator is composing a `!cmd` shell command that could
// actually run RIGHT NOW. Three conditions:
//   - buffer starts with `!` (the mode trigger),
//   - not reverse-search-dimmed (that overlay owns the palette),
//   - the REPL is idle.
// The idle gate matters: a `!` typed mid-turn is REFUSED on submit
// (`isBusy()` serialization in repl.ts), so flipping the input/rules
// yellow + footer to "shell mode" then would advertise a mode that
// can't run AND shadow the load-bearing "esc to interrupt" footer cue.
// While a turn runs the buffer just reads as a normal (gray) draft; it
// flips to bash mode the moment the turn ends, ready to submit.
export const isBashMode = (state: LiveState): boolean =>
  state.reverseSearch === null && !isTurnRunning(state) && state.input.value.startsWith('!');
