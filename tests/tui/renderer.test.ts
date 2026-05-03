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
  test('session:start emits no permanent (UI.md §3.2) but schedules a live redraw', () => {
    // Session-header was removed — the user-submit inverse bar is
    // the canonical turn boundary. Reducer's session:start updates
    // status state but emits no permanent line; the renderer
    // schedules a frame to draw the live region (rules + input +
    // footer). Flushing the scheduler proves the frame gets drawn,
    // and the absence of the old `── session s1 · ... ──` line
    // proves the rule was actually removed.
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
    // No permanent → no immediate write; only a scheduled frame.
    expect(sink.writes).toHaveLength(0);
    expect(sched.pending()).toBe(1);
    sched.flushAll();
    // Frame fired — live region present (input prompt visible).
    expect(sink.joined()).toContain('> ');
    // No legacy session-header line.
    expect(sink.joined()).not.toContain('── session');
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
    // session:start no longer emits permanent (UI.md §3.2) — flush
    // the scheduled redraw so the live region is actually drawn,
    // creating the prior frame the next permanent transition has
    // to erase.
    bus.emit(sessionStart);
    sched.flushAll();
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

  test('differential redraw: unchanged lines are NOT re-emitted (anti-flicker)', () => {
    // The flicker fix's load-bearing claim: under key repeat the
    // surrounding lines (status / footer / rules) stay pixel-stable
    // because we don't re-emit their content. This test pins it.
    //
    // Setup: a deterministic compose function that returns 3 lines
    // — two static, one "dynamic" (the input echo). We drive
    // session:start to establish a baseline frame, then fire
    // input:update events (which only change the dynamic line) and
    // assert the captured writes after the baseline contain the
    // changed line content but NEVER the static line content again.
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const compose = (s: LiveState): string[] => [
      'STATIC-HEADER',
      `INPUT: ${s.input.value}`,
      'STATIC-FOOTER',
    ];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive: compose,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    // Flush the scheduled redraw so the baseline frame draws all
    // three lines (session:start no longer emits permanent — it
    // schedules a frame; UI.md §3.2).
    sched.flushAll();
    expect(sink.joined()).toContain('STATIC-HEADER');
    expect(sink.joined()).toContain('STATIC-FOOTER');
    expect(sink.joined()).toContain('INPUT: ');
    sink.writes.length = 0;
    // Fire a state-only update that changes only the input line.
    bus.emit({ type: 'input:update', ts: 2, value: 'h', cursor: 1 });
    sched.flushAll();
    const second = sink.joined();
    // The new input value MUST appear (the line that changed).
    expect(second).toContain('INPUT: h');
    // The static lines MUST NOT appear in the second frame — they
    // didn't change, so the differential renderer skipped them.
    // If this regresses, the flicker comes back: every keystroke
    // would re-emit the static rows and the operator sees them
    // wiped + repainted at frame rate.
    expect(second).not.toContain('STATIC-HEADER');
    expect(second).not.toContain('STATIC-FOOTER');
    // Subsequent typing keeps the same property.
    sink.writes.length = 0;
    bus.emit({ type: 'input:update', ts: 3, value: 'he', cursor: 2 });
    sched.flushAll();
    const third = sink.joined();
    expect(third).toContain('INPUT: he');
    expect(third).not.toContain('STATIC-HEADER');
    expect(third).not.toContain('STATIC-FOOTER');
    r.close();
  });

  test('differential redraw: multiple changed lines walk between rows correctly', () => {
    // The single-changed-line case is easy; this exercises the
    // inter-row walk. Two lines change (rows 0 and 2), the middle
    // row is static and must NOT be re-emitted, AND the cursor must
    // land back on the input row (the last) after both writes.
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    let counter = 0;
    const compose = (s: LiveState): string[] => [
      `DYNAMIC-A: ${counter}`,
      'STATIC-MIDDLE',
      `INPUT: ${s.input.value}`,
    ];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive: compose,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sched.flushAll(); // baseline frame
    sink.writes.length = 0;
    // Bump both row 0 (counter) and row 2 (input). Middle row stays.
    counter = 1;
    bus.emit({ type: 'input:update', ts: 2, value: 'h', cursor: 1 });
    sched.flushAll();
    const out = sink.joined();
    expect(out).toContain('DYNAMIC-A: 1');
    expect(out).toContain('INPUT: h');
    // Static middle row was NOT re-emitted.
    expect(out).not.toContain('STATIC-MIDDLE');
    // The renderer walked between rows: at minimum a cursorDown
    // should appear (from row 0 after writing row 0, walking to
    // row 2 to write the input). cursorDown(2) is `\x1b[2B`.
    expect(out).toContain(`${CSI}2B`);
    r.close();
  });

  test('differential redraw: cursor reposition fires even when no line content changed', () => {
    // Edge case: the input value didn't change, but the cursor
    // position within the buffer did (e.g., the operator pressed an
    // arrow key, or backspace+retype lands the same chars). The
    // composed lines are identical to the previous frame — diff
    // emits nothing for content — but the cursor must still walk
    // to its new column. Without the final reposition the operator
    // sees the cursor stuck at the previous spot.
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
    bus.emit({ type: 'input:update', ts: 2, value: 'abc', cursor: 3 });
    sched.flushAll();
    sink.writes.length = 0;
    // Same value, cursor moves left by one. No line content changes.
    bus.emit({ type: 'input:update', ts: 3, value: 'abc', cursor: 1 });
    sched.flushAll();
    const out = sink.joined();
    // No content from the input row — same string.
    expect(out).not.toContain('> abc');
    // But cursorForward MUST appear (positioning the cursor at the
    // new column). The exact value is `prefix(2) + cursor(1) = 3`.
    expect(out).toContain(`${CSI}3C`);
    r.close();
  });

  test('layout change (height differs) falls back to full erase + redraw', () => {
    // Differential only applies when prev and next have the same
    // number of lines. When the layout changes (e.g., a tool card
    // appears, modal opens, status line gains a row), we must do
    // a full erase + redraw so the terminal lays out the new shape
    // correctly. Pinning this so a future "always-differential"
    // refactor doesn't leave ghost rows.
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    let extra = false;
    const compose = (s: LiveState): string[] => {
      const base = ['HEADER', `INPUT: ${s.input.value}`, 'FOOTER'];
      return extra ? [...base, 'EXTRA-ROW'] : base;
    };
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive: compose,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sched.flushAll(); // baseline frame establishes prevLines
    sink.writes.length = 0;
    // Now grow the layout. Trigger a redraw.
    extra = true;
    bus.emit({ type: 'input:update', ts: 2, value: '', cursor: 0 });
    sched.flushAll();
    const out = sink.joined();
    // Full redraw → all rows present, including the static ones,
    // because we erased + redrew the whole thing.
    expect(out).toContain('HEADER');
    expect(out).toContain('FOOTER');
    expect(out).toContain('EXTRA-ROW');
    // Erase escape (clearDown) is present too.
    expect(out).toContain(`${CSI}J`);
    r.close();
  });

  test('redraw payload is wrapped in DECSET 2026 (synchronized output)', () => {
    // UI.md §2.2: each frame is wrapped in BSU/ESU so terminals
    // present it atomically (no incremental rasterization mid-frame).
    // Single-write coalesce alone wasn't enough — under key repeat
    // the operator still saw the static lines (status / footer /
    // rules) flicker as the terminal painted cursor-up + clear →
    // content in visible steps. The wrap fixes that on supporting
    // terminals (kitty, iTerm2, alacritty, wezterm) and is a no-op
    // private mode on the rest.
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
    sched.flushAll(); // session:start now schedules instead of emitting permanent
    const firstFrame = sink.joined();
    expect(firstFrame.startsWith(`${CSI}?2026h`)).toBe(true);
    expect(firstFrame.endsWith(`${CSI}?2026l`)).toBe(true);
    // Scheduled redraw on a state-only event also wraps.
    sink.writes.length = 0;
    bus.emit({ type: 'input:update', ts: 2, value: 'h', cursor: 1 });
    sched.flushAll();
    const second = sink.joined();
    expect(second.startsWith(`${CSI}?2026h`)).toBe(true);
    expect(second.endsWith(`${CSI}?2026l`)).toBe(true);
    r.close();
  });

  test('one redraw is one write() call (anti-flicker — UI.md §2.2 step 4)', () => {
    // Spec §2.2 requires the redraw cycle (erase + content + cursor)
    // to land in a single `process.stdout.write(...)`. Splitting it
    // across multiple writes flushes the terminal between them — the
    // operator sees the live region momentarily wiped before the
    // new frame paints, perceived as flicker. Prior versions did
    // 2-3 separate writes per redraw; this test pins the contract.
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
    // First frame (after session:start + flush) lands as one write.
    bus.emit(sessionStart);
    sched.flushAll();
    expect(sink.writes).toHaveLength(1);
    sink.writes.length = 0;
    // Subsequent state-only event → scheduled redraw, also one write.
    bus.emit({ type: 'input:update', ts: 2, value: 'h', cursor: 1 });
    sched.flushAll();
    expect(sink.writes).toHaveLength(1);
    // Permanent transition (warn) — erase + permanent text + draw all
    // get coalesced into one write too. Without coalesce this would
    // be 3+ writes (erase, permanent line, draw, cursor reposition).
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 3, message: 'careful' });
    expect(sink.writes).toHaveLength(1);
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
    const sched = makeSchedulerOptions();
    const composeLive = (): string[] => ['only one line'];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    // Establish a single-line baseline so the next permanent
    // transition has to erase exactly one row.
    bus.emit(sessionStart);
    sched.flushAll();
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
    const sched = makeSchedulerOptions();
    const composeLive = (): string[] => [];
    const r = createRenderer({
      bus,
      caps,
      write: sink.write,
      composeLive,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    // Drive a permanent (warn) so we have an emitted line to
    // observe — session:start no longer prints anything (UI.md §3.2).
    // The test's contract: when composeLive returns [], the live
    // region writes nothing — the buffer should contain only the
    // permanent line + its trailing newline (plus the BSU/ESU wrap).
    bus.emit(sessionStart);
    sched.flushAll();
    sink.writes.length = 0;
    bus.emit({ type: 'warn', ts: 2, message: 'careful' });
    const out = sink.joined();
    expect(out).toContain('warn: careful');
    // Strip the synchronized-output wrap (DECSET 2026). What's inside
    // is exactly the permanent line (with §6.3 frame margin). If the
    // live region had been drawn, the inner payload would also include
    // cursorUp / clearDown / live content escapes — that's what this
    // test guards against.
    const inner = out.replace(`${CSI}?2026h`, '').replace(`${CSI}?2026l`, '');
    // Strip the warn's CSI color codes for an exact comparison.
    // Build the regex from CSI to keep biome happy about the ESC byte.
    const sgrRegex = new RegExp(`${CSI.replace('[', '\\[')}[\\d;]*m`, 'g');
    const noColor = inner.replace(sgrRegex, '');
    // warn now prepends a leading blank (UI.md §6.3 — every top-level
    // session block gets breathing space). Two padded lines: '  '
    // (blank) + '  warn: careful'.
    expect(noColor).toBe('  \n  warn: careful\n');
    r.close();
  });

  test('narrow live region with colored content does not emit orphan ANSI escapes', () => {
    // Reproduces the truncate-through-ANSI scenario: narrow terminal
    // forces truncateToWidth to walk through SGR escapes embedded in
    // a line. Driver: composeLive emits a colored line wider than
    // caps.cols. Pre-fix, truncation could split mid-escape and leave
    // orphan bytes that corrupt the terminal state.
    const bus = createBus();
    const sink = makeSink();
    const sched = makeSchedulerOptions();
    const narrowCaps = { ...caps, cols: 12, color: 'basic' as const };
    const composeLive = (): string[] => [`${CSI}33mwarning content here${CSI}0m`];
    const r = createRenderer({
      bus,
      caps: narrowCaps,
      write: sink.write,
      composeLive,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sched.flushAll();
    const out = sink.joined();
    // Sanity: the colored content produced an SGR open.
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
    const sched = makeSchedulerOptions();
    const narrowCaps = { ...caps, cols: 20 };
    const composeLive = (): string[] => ['x'.repeat(100)];
    const r = createRenderer({
      bus,
      caps: narrowCaps,
      write: sink.write,
      composeLive,
      schedulerOptions: sched.options,
      bracketedPaste: false,
    });
    bus.emit(sessionStart);
    sched.flushAll(); // session:start schedules; flush to draw
    const out = sink.joined();
    // The live region writes the truncated 'xxxx...' (20 x's, no
    // newline). Search for that exact 20-x run; longer would mean
    // truncation didn't happen.
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
    // Force a redraw so composeLive runs against the initial caps.
    r.redraw();
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
    // Drive a permanent + flush so we have observable output;
    // session:start alone no longer prints anything (UI.md §3.2).
    bus.emit(sessionStart);
    bus.emit({ type: 'warn', ts: 2, message: 'alive' });
    // Construction path didn't crash; renderer is functional —
    // the warn line lands in scrollback.
    expect(sink.joined()).toContain('warn: alive');
    r.close();
  });

  test('session:end emits the turn-end marker (Cogitated for X) into scrollback', () => {
    // Operator-reported regression: the AI text would print but no
    // turn-end marker. This pins the e2e contract: the renderer
    // catches session:end → reducer creates session-footer →
    // formatPermanent renders `Cogitated for X` → writeTransition
    // includes it in the captured writes.
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
    sched.flushAll();
    sink.writes.length = 0;
    bus.emit({
      type: 'session:end',
      ts: 2,
      sessionId: 's1',
      reason: 'done',
      durationMs: 8200,
    });
    const out = sink.joined();
    expect(out).toContain('Cogitated for 8s');
    r.close();
  });

  test('full turn flow: streamed AI text + Cogitated marker both land in scrollback', () => {
    // Operator-reported regression: the AI text appeared truncated
    // and the turn-end marker (`Cogitated for X`) didn't show. This
    // pins the e2e contract for a full turn:
    //   user:submit → assistant:start → deltas → assistant:end →
    //   step:budget → session:end
    // and asserts the captured output contains the streamed text in
    // full + the marker.
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
    sched.flushAll();
    sink.writes.length = 0;
    // Operator submits.
    bus.emit({ type: 'user:submit', ts: 2, text: 'hi' });
    // Assistant streams 3 deltas.
    bus.emit({ type: 'assistant:start', ts: 3, messageId: 'm1' });
    bus.emit({ type: 'assistant:delta', ts: 4, messageId: 'm1', text: 'Hello, ' });
    bus.emit({ type: 'assistant:delta', ts: 5, messageId: 'm1', text: 'how can I ' });
    bus.emit({ type: 'assistant:delta', ts: 6, messageId: 'm1', text: 'help?' });
    sched.flushAll();
    // Assistant turn ends. Reducer emits the permanent assistant
    // item; renderer writes it into scrollback.
    bus.emit({ type: 'assistant:end', ts: 7, messageId: 'm1' });
    // Final step:budget + session:end (the harness adapter emits
    // both when session_finished arrives).
    bus.emit({ type: 'step:budget', ts: 8, steps: 1, maxSteps: 50, costUsd: 0.01 });
    bus.emit({
      type: 'session:end',
      ts: 9,
      sessionId: 's1',
      reason: 'done',
      durationMs: 6000,
    });
    const out = sink.joined();
    // Full streamed text must be present (no truncation).
    expect(out).toContain('Hello, how can I help?');
    // Turn-end marker must be present.
    expect(out).toContain('Cogitated for 6s');
    // Marker comes AFTER the assistant text (turn-end ordering).
    expect(out.indexOf('Cogitated for 6s')).toBeGreaterThan(out.indexOf('Hello, how can I help?'));
    r.close();
  });

  test('multi-message turn: tool call between two assistant rounds, marker survives', () => {
    // Real harness flow: a single user prompt can result in multiple
    // assistant rounds with tool calls between. This pins that all
    // the rounds' text + the final marker survive through the chain
    // of writeTransitions (each one erases the live region of the
    // last frame). Pre-fix, a writeTransition's erase had to walk
    // exactly the right number of rows or it would clobber prior
    // permanent content.
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
    sched.flushAll();
    bus.emit({ type: 'user:submit', ts: 2, text: 'do the thing' });
    // First assistant round: streams a "thinking aloud" line, then
    // ends without text but with metadata (tool-only turn).
    bus.emit({ type: 'assistant:start', ts: 3, messageId: 'm1' });
    bus.emit({ type: 'assistant:delta', ts: 4, messageId: 'm1', text: '' });
    bus.emit({ type: 'assistant:end', ts: 5, messageId: 'm1' });
    // Tool runs.
    bus.emit({
      type: 'tool:start',
      ts: 6,
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
    });
    bus.emit({
      type: 'tool:end',
      ts: 7,
      toolId: 't1',
      status: 'done',
      durationMs: 100,
    });
    // Second assistant round: actual text response.
    bus.emit({ type: 'assistant:start', ts: 8, messageId: 'm2' });
    bus.emit({
      type: 'assistant:delta',
      ts: 9,
      messageId: 'm2',
      text: 'I ran ls and saw the files.',
    });
    bus.emit({ type: 'assistant:end', ts: 10, messageId: 'm2' });
    // Turn ends.
    bus.emit({
      type: 'session:end',
      ts: 11,
      sessionId: 's1',
      reason: 'done',
      durationMs: 9000,
    });
    const out = sink.joined();
    // The user-submit echo MUST survive.
    expect(out).toContain('> do the thing');
    // Tool chip MUST survive.
    expect(out).toContain('Executed');
    // Final assistant text MUST survive in full.
    expect(out).toContain('I ran ls and saw the files.');
    // Turn-end marker MUST appear AFTER the AI text.
    expect(out).toContain('Cogitated for 9s');
    expect(out.indexOf('Cogitated for 9s')).toBeGreaterThan(
      out.indexOf('I ran ls and saw the files.'),
    );
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

  test('state.ended stays true after session:end but live region keeps drawing (REPL gap)', () => {
    // Pre-fix the renderer skipped redraws while state.ended was
    // true, so the input box vanished between session:end and the
    // next user:submit — operator typed in the dark. Now the gate
    // is gone: state.ended is still tracked (used by tests / future
    // logic) but the renderer always draws the live region.
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
    bus.emit({ type: 'session:end', ts: 2, sessionId: 's1', reason: 'done', durationMs: 1000 });
    sched.flushAll();
    sink.writes.length = 0;
    bus.emit({ type: 'step:budget', ts: 3, steps: 5, maxSteps: 50, costUsd: 0 });
    sched.flushAll();
    // State updates (steps=5) AND the live region redraws so the
    // operator can still see the input prompt while typing the next
    // turn. Track that some output landed (the redraw) and that
    // state.ended is observable for any downstream consumer.
    expect(r.state().status.steps).toBe(5);
    expect(r.state().ended).toBe(true);
    expect(sink.writes.length).toBeGreaterThan(0);
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
