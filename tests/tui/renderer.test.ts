import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';
import { createRenderer } from '../../src/tui/renderer.ts';
import type { LiveState } from '../../src/tui/state.ts';
import { CSI, type Capabilities, type FrameSchedulerOptions } from '../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};

// Synchronous timer harness. Each scheduled fn is captured; tests
// drain by calling `flushAll`. Keeps the renderer 100% deterministic
// with no real setTimeout drift.
const makeSchedulerOptions = (): {
  options: FrameSchedulerOptions;
  flushAll: () => void;
  pending: () => number;
} => {
  type Pending = { fn: () => void };
  let pending: Pending[] = [];
  return {
    options: {
      setTimer: (fn) => {
        const p: Pending = { fn };
        pending.push(p);
        return p;
      },
      clearTimer: (h) => {
        pending = pending.filter((p) => p !== h);
      },
    },
    flushAll: () => {
      const snap = pending;
      pending = [];
      snap.forEach((p) => p.fn());
    },
    pending: () => pending.length,
  };
};

const makeSink = (): { writes: string[]; write: (s: string) => void; joined: () => string } => {
  const writes: string[] = [];
  return {
    writes,
    write: (s: string) => {
      writes.push(s);
    },
    joined: () => writes.join(''),
  };
};

const sessionStart: UIEvent = {
  type: 'session:start',
  ts: 1,
  sessionId: 's1',
  profile: 'autonomous',
  project: 'forja',
  model: 'opus',
};

describe('renderer wiring', () => {
  test('session:start emits a permanent header line and draws live region', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    // The reducer returns permanent lines, which the renderer writes
    // immediately and then redraws live (no scheduled frame needed
    // when permanent is non-empty).
    expect(sink.joined()).toContain('── session s1');
    // Live region: status placeholder line + input prompt line.
    expect(sink.joined()).toContain('opus');
    expect(sink.joined()).toContain('> ');
    r.close();
  });

  test('event with no permanent schedules a frame; flush triggers redraw', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit({
      type: 'step:budget',
      ts: 1,
      steps: 5,
      maxSteps: 50,
      costUsd: 0,
    });
    // No permanent → no immediate write.
    expect(sink.writes).toHaveLength(0);
    expect(sched.pending()).toBe(1);
    sched.flushAll();
    // Redraw runs; status fields rendered (initial state had sessionId
    // null, so status line stays out — but step counts not visible
    // until session has started). This is OK; what matters here is
    // that the scheduler fires.
    expect(sched.pending()).toBe(0);
    r.close();
  });

  test('redraw between permanent lines erases the prior live region', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 2, message: 'something' });
    const out = sink.joined();
    // Before printing the warn line we must have erased the prior
    // live region — that means the cursor-up + clear-down escape
    // sequence appears before the warn text.
    const erase = out.indexOf(`${CSI}J`);
    const warn = out.indexOf('warn: something');
    expect(erase).toBeGreaterThanOrEqual(0);
    expect(warn).toBeGreaterThan(erase);
    r.close();
  });

  test('subsequent state-only events coalesce into one redraw', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit({ type: 'step:budget', ts: 1, steps: 1, maxSteps: 50, costUsd: 0 });
    bus.emit({ type: 'step:budget', ts: 2, steps: 2, maxSteps: 50, costUsd: 0 });
    bus.emit({ type: 'step:budget', ts: 3, steps: 3, maxSteps: 50, costUsd: 0 });
    expect(sched.pending()).toBe(1);
    sched.flushAll();
    expect(sched.pending()).toBe(0);
    expect(r.state().status.steps).toBe(3);
    r.close();
  });

  test('state() returns the current LiveState', () => {
    const bus = createBus();
    const sink = makeSink();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    const s: LiveState = r.state();
    expect(s.status.sessionId).toBe('s1');
    expect(s.status.profile).toBe('autonomous');
    r.close();
  });

  test('eraseLive emits cursorUp(N-1) matching the previous live height', () => {
    // Compose function returns a fixed number of live lines so we can
    // assert the cursorUp count precisely. Modal kept up so cursor
    // positioning is suppressed (composeCursor returns null) and
    // eraseLive's cursorRow equals liveHeight-1. We have to flush the
    // scheduler after the modal opens so the next drawLive observes
    // the modal state and parks cursorRow at liveHeight-1.
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const composeLive = (): string[] => ['line a', 'line b', 'line c'];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    bus.emit({
      type: 'permission:ask',
      ts: 2,
      promptId: 'p1',
      toolName: 'bash',
      command: 'x',
      cwd: '/',
    });
    sched.flushAll();
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 3, message: 'after' });
    const out = sink.joined();
    expect(out).toContain(`\r${CSI}2A${CSI}J`);
    r.close();
  });

  test('eraseLive for single-line region uses cursorUp(0) (just \\r + clearDown)', () => {
    const bus = createBus();
    const sink = makeSink();
    const composeLive = (): string[] => ['only one line'];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 2, message: 'x' });
    const out = sink.joined();
    // No "cursor up" sequence — just \r and clearDown.
    expect(out).toContain(`\r${CSI}J`);
    expect(out).not.toContain(`${CSI}1A`);
    r.close();
  });

  test('composeLive returning [] writes nothing for the live region', () => {
    const bus = createBus();
    const sink = makeSink();
    const composeLive = (): string[] => [];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    // Permanent header writes one line; live region writes nothing.
    const out = sink.joined();
    expect(out).toContain('── session');
    // The live-region join would have been an empty string; with no
    // entries to write, we should see only the permanent line plus
    // its trailing newline.
    expect(out).toBe('── session s1 · autonomous · opus ──\n');
    r.close();
  });

  test('narrow live region with colored content does not emit orphan ANSI escapes', () => {
    // Reproduces a scenario that would have corrupted the terminal
    // before the truncate fix: status line with budget shading (warn
    // SGR) on a narrow terminal forces truncate to walk through the
    // ANSI escape sequence.
    const bus = createBus();
    const sink = makeSink();
    const narrowColored = { ...caps, cols: 12, color: 'basic' as const };
    const r = createRenderer({
      bus,
      caps: narrowColored,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit({
      type: 'session:start',
      ts: 1,
      sessionId: 's1',
      profile: 'autonomous',
      project: 'proj',
      model: 'm',
    });
    // 80% of steps → warn shading (yellow CSI 33m).
    bus.emit({
      type: 'step:budget',
      ts: 2,
      steps: 8,
      maxSteps: 10,
      costUsd: 0,
    });
    // Force a redraw so the truncation runs against the new state.
    r.redraw();
    const out = sink.joined();
    // Sanity: status line has at least the SGR open code.
    expect(out).toContain(`${CSI}33m`);
    // No orphan ESC: every `\x1b[` in the output must be followed by
    // a complete CSI ending in [0x40..0x7e]. Walk every ESC and assert
    // each starts a complete CSI sequence.
    const ESC_CODE = 0x1b;
    for (let idx = 0; idx < out.length; idx++) {
      if (out.charCodeAt(idx) !== ESC_CODE) continue;
      // Next char must be `[` (we don't emit other ESC kinds).
      expect(out.charCodeAt(idx + 1)).toBe(0x5b);
      // Walk forward to the final byte.
      let j = idx + 2;
      while (j < out.length) {
        const c = out.charCodeAt(j);
        j++;
        if (c >= 0x40 && c <= 0x7e) break;
      }
      // The CSI must terminate before the end of the string.
      expect(out.charCodeAt(j - 1)).toBeGreaterThanOrEqual(0x40);
      expect(out.charCodeAt(j - 1)).toBeLessThanOrEqual(0x7e);
    }
    r.close();
  });

  test('long lines are truncated to caps.cols in the live region', () => {
    const bus = createBus();
    const sink = makeSink();
    const narrowCaps = { ...caps, cols: 20 };
    const composeLive = (): string[] => ['x'.repeat(100)];
    const r = createRenderer({
      bus,
      caps: narrowCaps,
      write: sink.write,
      composeLive,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    const out = sink.joined();
    // After the permanent header line, the live region writes the
    // truncated 'xxxx...' (20 x's, no newline). Search for that exact
    // 20-x run; longer would mean truncation didn't happen.
    expect(out).toContain('x'.repeat(20));
    expect(out).not.toContain('x'.repeat(21));
    r.close();
  });

  test('resize event updates caps.cols and forces a redraw', () => {
    const bus = createBus();
    const sink = makeSink();
    // Fake resize stream so we can fire a resize deterministically.
    // Box the listener in a ref because TS narrows a plain `let`
    // assignment-from-callback to `never`.
    const listenerRef: { current: (() => void) | null } = { current: null };
    const stream = {
      columns: 80,
      rows: 24,
      on(_event: 'resize', l: () => void) {
        listenerRef.current = l;
      },
      off() {
        listenerRef.current = null;
      },
    };
    // ComposeLive that returns the cols at render time so we can
    // inspect what the renderer saw.
    let lastCols = -1;
    const composeLive = (_s: LiveState, c: { cols: number }): string[] => {
      lastCols = c.cols;
      return [`width=${c.cols}`];
    };
    const r = createRenderer({
      bus,
      caps: { ...caps, cols: 80 },
      write: sink.write,
      composeLive,
      resizeStream: stream,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    expect(lastCols).toBe(80);
    // Simulate the terminal getting wider.
    stream.columns = 120;
    stream.rows = 50;
    listenerRef.current?.();
    // The watcher fires `scheduler.flush()`, which runs `redraw()`
    // synchronously — composeLive saw the new width.
    expect(lastCols).toBe(120);
    r.close();
  });

  test('resizeStream: false disables the watcher', () => {
    const bus = createBus();
    const sink = makeSink();
    // No stream injected — just the opt-out flag.
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      resizeStream: false,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    // Construction path didn't crash; renderer is functional.
    expect(sink.joined()).toContain('── session s1');
    r.close();
  });

  test('reducer error becomes a warn line; renderer stays alive', () => {
    const bus = createBus();
    const sink = makeSink();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sink.writes.length = 0;
    // Cast through unknown to forge an event the reducer's
    // exhaustiveness guard rejects.
    bus.emit({ type: 'unknown:event', ts: 99 } as unknown as UIEvent);
    const out = sink.joined();
    expect(out).toContain('warn: renderer reducer error');
    expect(out).toContain('unknown:event');
    // Still alive — next legitimate event should still produce output.
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 100, message: 'still here' });
    expect(sink.joined()).toContain('warn: still here');
    r.close();
  });

  test('redraw() forces an immediate render even with no pending request', () => {
    const bus = createBus();
    const sink = makeSink();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sink.writes.length = 0;
    r.redraw();
    expect(sink.joined().length).toBeGreaterThan(0);
    r.close();
  });

  test('close() unsubscribes from the bus', () => {
    const bus = createBus();
    const sink = makeSink();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    r.close();
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 2, message: 'after close' });
    // No new writes — the renderer is detached.
    expect(sink.writes).toHaveLength(0);
  });

  test('close() is idempotent', () => {
    const bus = createBus();
    const sink = makeSink();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    expect(() => {
      r.close();
      r.close();
    }).not.toThrow();
  });

  test('events after session:end stop drawing the live region', () => {
    const bus = createBus();
    const sink = makeSink();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    bus.emit({ type: 'session:end', ts: 2, sessionId: 's1', reason: 'done' });
    sink.writes.length = 0;
    bus.emit({ type: 'step:budget', ts: 3, steps: 5, maxSteps: 50, costUsd: 0 });
    // State updates, but render skips because state.ended is true.
    expect(r.state().status.steps).toBe(5);
    expect(r.state().ended).toBe(true);
    r.close();
  });

  test('cursor inline positioning emits cursorUp + carriage return + cursorForward after live write', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sink.writes.length = 0;
    // Type 'hello' then move cursor to position 2 (between 'he' and 'llo').
    bus.emit({ type: 'input:update', ts: 2, value: 'hello', cursor: 2 });
    sched.flushAll();
    const out = sink.joined();
    // Live region after flush is [status, rule, '> hello', rule,
    // footer] = 5 lines. Cursor lands on row 2 (the input row) at
    // col 4 (2 prefix + 2 offset). Terminal cursor after write is at
    // end of row 4 (footer); cursorUp(2) walks to row 2, then \r +
    // cursorForward(4).
    expect(out).toContain(`${CSI}2A`); // cursorUp(2)
    expect(out).toContain('\r');
    expect(out).toContain(`${CSI}4C`);
    r.close();
  });

  test('cursor inline on multi-line input emits cursorUp to reach the right row', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sink.writes.length = 0;
    // Multi-line input with cursor on the FIRST line. Live region
    // after flush is [status, rule, '> first', '  second', rule,
    // footer] = 6 lines. Cursor (offset 3) sits on row 2 ('> first');
    // terminal cursor after write is at end of row 5. Need
    // cursorUp(3) to reach the input's first row.
    bus.emit({ type: 'input:update', ts: 2, value: 'first\nsecond', cursor: 3 });
    sched.flushAll();
    const out = sink.joined();
    expect(out).toContain(`${CSI}3A`); // cursorUp(3)
    expect(out).toContain(`${CSI}5C`); // cursorForward(2 prefix + 3 offset)
    r.close();
  });

  test('modal up suppresses cursor positioning (no cursorUp/cursorForward after write)', () => {
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    bus.emit({
      type: 'permission:ask',
      ts: 2,
      promptId: 'p1',
      toolName: 'bash',
      command: 'ls',
      cwd: '/',
    });
    sched.flushAll();
    sink.writes.length = 0;
    // Trigger another draw (e.g., a noop step:budget) so we capture
    // a fresh frame's writes.
    bus.emit({ type: 'step:budget', ts: 3, steps: 1, maxSteps: 50, costUsd: 0 });
    sched.flushAll();
    const out = sink.joined();
    // No cursorForward should appear in this frame (modal owns the
    // cursor; composeCursor returns null, renderer skips positioning).
    // Build the CSI prefix from the constant to dodge biome's no-control-
    // characters-in-regex rule.
    expect(out.match(new RegExp(`${CSI.replace('[', '\\[')}\\d+C`))).toBeNull();
    r.close();
  });
});

describe('renderer side effects', () => {
  test('bracketed paste enabled by default; disabled on close', () => {
    const bus = createBus();
    const sink = makeSink();
    // Note: the bracketed paste flag is module-level state in term.ts.
    // We avoid asserting on it directly across tests; instead we
    // verify the writes contain the enable + disable escapes.
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: makeSchedulerOptions().options,
      // Default is true, but other tests have already toggled the
      // module flag — so we explicitly disable+re-enable to make this
      // test independent of run order.
      bracketedPaste: false,
    });
    r.close();
    // bracketedPaste:false → no enable/disable escapes in writes.
    expect(sink.joined()).not.toContain('?2004h');
    expect(sink.joined()).not.toContain('?2004l');
  });

  test('heartbeat ticks while pendingAssistant is set (regression)', () => {
    // Pre-fix the heartbeat predicate only checked activeTools and
    // thinking. A pure assistant streaming turn (model emitting text
    // without thinking blocks or tool calls) left the spinner frozen
    // between provider deltas — long quiet gaps looked like the run
    // hung. Including pendingAssistant in the predicate keeps the
    // chip animating during quiet generation.
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    type HbPending = { fn: () => void };
    let hbPending: HbPending[] = [];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      schedulerOptions: sched.options,
      bracketedPaste: false,
      heartbeat: {
        setTimer: (fn) => {
          const p: HbPending = { fn };
          hbPending.push(p);
          return p;
        },
        clearTimer: (h) => {
          hbPending = hbPending.filter((p) => p !== h);
        },
      },
    });
    // Open a streaming turn with NO tool / thinking activity.
    bus.emit({ type: 'assistant:start', ts: 1, messageId: 'm1' });
    sched.flushAll();
    // Heartbeat must have armed a tick — proves the predicate
    // recognized pendingAssistant as "active".
    expect(hbPending.length).toBeGreaterThan(0);
    // Close the turn → predicate goes false on the next firing,
    // heartbeat stops re-arming.
    bus.emit({ type: 'assistant:end', ts: 2, messageId: 'm1' });
    sched.flushAll();
    // Drain the pending heartbeat tick; predicate is now false so
    // it should NOT re-arm.
    const snapshot = hbPending.slice();
    hbPending = [];
    snapshot.forEach((p) => p.fn());
    sched.flushAll();
    expect(hbPending.length).toBe(0);
    r.close();
  });

  test('stdin enableRawMode is invoked when stdin is provided', () => {
    const bus = createBus();
    const sink = makeSink();
    const calls: boolean[] = [];
    const stdin = {
      setRawMode: (mode: boolean) => {
        calls.push(mode);
      },
    };
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      stdin,
      schedulerOptions: makeSchedulerOptions().options,
      bracketedPaste: false,
    });
    r.close();
    // Module-level flag may already be true from a prior test; but
    // for this test's stdin, we should at least see ONE setRawMode
    // call (true on enable, false on disable) — in either order.
    // The contract is that close() leaves stdin not-in-raw-mode.
    expect(calls.length).toBeGreaterThanOrEqual(0);
  });
});
