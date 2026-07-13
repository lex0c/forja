import type { HarnessConfig, HarnessEvent } from './types.ts';

// Emit a HarnessEvent to the optional renderer callback, swallowing any throw.
// A renderer that throws must never derail the harness. The loop, the terminal
// (session-end) path, and every other emitter share this single guard so the
// swallow-on-throw behavior can't drift between them — the previous two
// byte-identical copies (loop.ts + terminal.ts) are folded in here.
export const safeEmit = (onEvent: HarnessConfig['onEvent'], event: HarnessEvent): void => {
  if (onEvent === undefined) return;
  try {
    onEvent(event);
  } catch {
    // Renderers throwing must not derail the harness.
  }
};
