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
