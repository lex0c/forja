// Focus stack — generic stack of key handlers. Spec: UI.md §5.7.
//
// The REPL loop dispatches every keystroke through this stack. The
// TOP of the stack runs first; if it returns false (didn't consume),
// the next handler down gets a chance. Modal-manager pushes a
// handler when a modal opens and pops on close, so modal input
// shadows editor input cleanly without the editor needing modal
// awareness.
//
// Pure data structure: no I/O, no state beyond the handler array.
// A single instance is owned by the REPL loop.

import type { KeyEvent } from './keys.ts';

// Returns true when the handler consumed the key (the dispatch loop
// stops). False lets the dispatcher try the next handler down.
export type FocusHandler = (key: KeyEvent) => boolean;

export interface FocusStack {
  push: (handler: FocusHandler) => void;
  // Removes a specific handler (the one that was pushed). Pass the
  // exact reference returned to the caller. Returns true if the
  // handler was found and removed.
  remove: (handler: FocusHandler) => boolean;
  // Dispatch a key to the stack. Walks top-to-bottom, stops on first
  // handler that returns true. Returns whether ANY handler consumed.
  dispatch: (key: KeyEvent) => boolean;
  // Number of handlers currently on the stack.
  size: () => number;
  // Drop everything. Used at shutdown.
  clear: () => void;
}

export const createFocusStack = (): FocusStack => {
  // Stored bottom-to-top: stack[stack.length - 1] is the top.
  const stack: FocusHandler[] = [];

  return {
    push: (handler) => {
      stack.push(handler);
    },
    remove: (handler) => {
      // Search top-down — the most recently pushed handler is the
      // most likely to be removed (LIFO is the common case for
      // modals, autocomplete, etc.).
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === handler) {
          stack.splice(i, 1);
          return true;
        }
      }
      return false;
    },
    dispatch: (key) => {
      for (let i = stack.length - 1; i >= 0; i--) {
        const handler = stack[i];
        if (handler === undefined) continue;
        if (handler(key)) return true;
      }
      return false;
    },
    size: () => stack.length,
    clear: () => {
      stack.length = 0;
    },
  };
};
