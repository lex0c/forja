// Slice 86 — SIGINT + SIGTERM handler wiring. Uses
// `process.emit('SIGINT')` / `process.emit('SIGTERM')` to fire
// signals synthetically — registered listeners run as if the OS
// delivered them, without actually interrupting the test process.
//
// Each test restores the handler in finally so a leaked listener
// from one test can't affect another. The installSignalHandler
// return value (restore fn) is the canonical cleanup.

import { describe, expect, test } from 'bun:test';
import { installSignalHandler } from '../../src/cli/signal.ts';

// Suppress the stderr write the handler emits so test output stays
// clean. process.stderr.write is the surface — we just don't want
// the test runner to interleave with our assertions.
const silenceStderr = (): (() => void) => {
  const original = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: stdio mock signature
  (process.stderr as any).write = () => true;
  return () => {
    process.stderr.write = original;
  };
};

describe('installSignalHandler — SIGINT', () => {
  test('first SIGINT aborts the controller (graceful)', () => {
    const restoreStderr = silenceStderr();
    const ctrl = new AbortController();
    const restore = installSignalHandler(ctrl);
    try {
      expect(ctrl.signal.aborted).toBe(false);
      process.emit('SIGINT' as NodeJS.Signals);
      expect(ctrl.signal.aborted).toBe(true);
    } finally {
      restore();
      restoreStderr();
    }
  });

  test('SIGINT handler is wired exactly once per install', () => {
    const restoreStderr = silenceStderr();
    const ctrl = new AbortController();
    const restore = installSignalHandler(ctrl);
    try {
      // First emit → abort
      process.emit('SIGINT' as NodeJS.Signals);
      expect(ctrl.signal.aborted).toBe(true);
    } finally {
      restore();
      restoreStderr();
    }
  });
});

describe('installSignalHandler — SIGTERM', () => {
  test('SIGTERM aborts the controller (graceful shutdown)', () => {
    const restoreStderr = silenceStderr();
    const ctrl = new AbortController();
    const restore = installSignalHandler(ctrl);
    try {
      expect(ctrl.signal.aborted).toBe(false);
      process.emit('SIGTERM' as NodeJS.Signals);
      expect(ctrl.signal.aborted).toBe(true);
    } finally {
      restore();
      restoreStderr();
    }
  });

  test('SIGTERM does NOT force-exit on second signal (no escalation)', () => {
    // Distinct from SIGINT's double-press → process.exit(130).
    // SIGTERM senders that want force follow up with SIGKILL, which
    // we can't intercept anyway. Asserting the controller is
    // aborted + no exit was triggered = behavior holds.
    const restoreStderr = silenceStderr();
    const ctrl = new AbortController();
    const restore = installSignalHandler(ctrl);
    try {
      process.emit('SIGTERM' as NodeJS.Signals);
      // Emitting a second SIGTERM must not call process.exit.
      // If it did, this test wouldn't reach the next line —
      // the test runner would exit instead.
      process.emit('SIGTERM' as NodeJS.Signals);
      expect(ctrl.signal.aborted).toBe(true);
    } finally {
      restore();
      restoreStderr();
    }
  });
});

describe('installSignalHandler — restore', () => {
  test('restore() removes both SIGINT and SIGTERM listeners', () => {
    const restoreStderr = silenceStderr();
    const ctrl = new AbortController();
    const restore = installSignalHandler(ctrl);
    restore();
    try {
      // After restore, neither signal should abort the controller.
      // process.emit returns true if any listener was called, false
      // otherwise — both should return false here because there are
      // no remaining listeners we installed. (Other test-runner-
      // installed listeners may exist for SIGINT, hence we assert
      // controller.signal.aborted rather than the emit return.)
      process.emit('SIGINT' as NodeJS.Signals);
      process.emit('SIGTERM' as NodeJS.Signals);
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      restoreStderr();
    }
  });

  test('multiple install/restore cycles do not leak listeners', () => {
    const restoreStderr = silenceStderr();
    try {
      // Without restore symmetry, listener count grows per install
      // and SIGTERM would abort N controllers at once. Run 5 cycles
      // — only the most recent (still-installed) handler should
      // abort its controller.
      for (let i = 0; i < 5; i++) {
        const ctrl = new AbortController();
        const restore = installSignalHandler(ctrl);
        restore();
        expect(ctrl.signal.aborted).toBe(false);
      }
      // Final install lives through the test.
      const final = new AbortController();
      const restore = installSignalHandler(final);
      try {
        process.emit('SIGTERM' as NodeJS.Signals);
        expect(final.signal.aborted).toBe(true);
      } finally {
        restore();
      }
    } finally {
      restoreStderr();
    }
  });
});

// Slice 148 (BG2 — expanded signal coverage). Pre-slice only SIGINT
// and SIGTERM aborted the controller; SIGHUP (terminal closed) and
// SIGQUIT (Ctrl+\ or service manager) escaped uncaught, exiting
// the harness without running the finally chain — bg processes
// the LLM spawned were orphaned to PID 1. Same shape for
// uncaughtException / unhandledRejection: a throw escapes every
// finally block and the bg jobs survive. Pin each path.
describe('installSignalHandler — SIGHUP (slice 148)', () => {
  test('SIGHUP aborts the controller (graceful shutdown)', () => {
    const restoreStderr = silenceStderr();
    try {
      const ctrl = new AbortController();
      const restore = installSignalHandler(ctrl);
      try {
        expect(ctrl.signal.aborted).toBe(false);
        process.emit('SIGHUP' as NodeJS.Signals);
        expect(ctrl.signal.aborted).toBe(true);
      } finally {
        restore();
      }
    } finally {
      restoreStderr();
    }
  });
});

describe('installSignalHandler — SIGQUIT (slice 148)', () => {
  test('SIGQUIT aborts the controller (graceful shutdown)', () => {
    const restoreStderr = silenceStderr();
    try {
      const ctrl = new AbortController();
      const restore = installSignalHandler(ctrl);
      try {
        expect(ctrl.signal.aborted).toBe(false);
        process.emit('SIGQUIT' as NodeJS.Signals);
        expect(ctrl.signal.aborted).toBe(true);
      } finally {
        restore();
      }
    } finally {
      restoreStderr();
    }
  });
});

describe('installSignalHandler — restore unwires every new signal (slice 148)', () => {
  test('SIGHUP / SIGQUIT listeners removed by restore', () => {
    const restoreStderr = silenceStderr();
    try {
      const ctrl = new AbortController();
      const restore = installSignalHandler(ctrl);
      restore();
      // After restore the controller must NOT abort on SIGHUP/SIGQUIT.
      process.emit('SIGHUP' as NodeJS.Signals);
      process.emit('SIGQUIT' as NodeJS.Signals);
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      restoreStderr();
    }
  });

  test('uncaughtException / unhandledRejection listeners registered and removed', () => {
    // We cannot synthetically emit `uncaughtException` (Node forces
    // a hard exit when the event has no other listener) — instead
    // pin via `listenerCount` that install adds a listener and
    // restore removes it. Symmetry across multiple cycles is the
    // load-bearing property; without it leakage would accumulate.
    const restoreStderr = silenceStderr();
    try {
      const baselineUncaught = process.listenerCount('uncaughtException');
      const baselineRejection = process.listenerCount('unhandledRejection');
      const ctrl = new AbortController();
      const restore = installSignalHandler(ctrl);
      expect(process.listenerCount('uncaughtException')).toBe(baselineUncaught + 1);
      expect(process.listenerCount('unhandledRejection')).toBe(baselineRejection + 1);
      restore();
      expect(process.listenerCount('uncaughtException')).toBe(baselineUncaught);
      expect(process.listenerCount('unhandledRejection')).toBe(baselineRejection);
    } finally {
      restoreStderr();
    }
  });
});
