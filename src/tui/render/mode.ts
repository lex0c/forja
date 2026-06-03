// Shared input-mode predicates for the live region. Single source of
// truth so every render site agrees — the input prompt/color, the rules
// around it, the cursor strip (composeCursor), and the footer indicator
// MUST compute "bash mode" identically or they desync (a yellow input
// with a `> ` prompt, or a caret one column off).

import type { LiveState } from '../state.ts';

// Bash mode: the operator is composing a `!cmd` shell command that could
// actually run RIGHT NOW. Three conditions:
//   - buffer starts with `!` (the mode trigger),
//   - not reverse-search-dimmed (that overlay owns the palette),
//   - the REPL is idle — gated on `state.busy`, the renderer's mirror of
//     the REPL's `isBusy()` (`busy:change` events). This MUST match the
//     submit gate: `isBusy()` refuses a `!` while a turn, a playbook, OR
//     another `!cmd` is in flight (none of which a render-derived
//     turn-activity check could see — playbook / operator-bash leave no
//     LiveState turn fields set). Without the match, typing `!` during a
//     playbook or a running `!cmd` would flip the input/rules/footer to
//     shell mode for a command Enter then refuses, and shadow the
//     interrupt cue. While busy the buffer reads as a normal gray draft;
//     it flips to bash mode the moment the REPL idles.
export const isBashMode = (state: LiveState): boolean =>
  state.reverseSearch === null && !state.busy && state.input.value.startsWith('!');
