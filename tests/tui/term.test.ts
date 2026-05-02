import { afterEach, describe, expect, test } from 'bun:test';
import {
  CSI,
  type Capabilities,
  clearDown,
  clearLine,
  createFrameScheduler,
  createResizeWatcher,
  cursorBack,
  cursorDown,
  cursorForward,
  cursorTo,
  cursorUp,
  detectCapabilities,
  disableBracketedPasteOn,
  disableRawMode,
  enableBracketedPasteOn,
  enableRawMode,
  isBracketedPasteActive,
  isRawModeActive,
  paint,
  reverse,
} from '../../src/tui/term.ts';

describe('detectCapabilities', () => {
  test('TTY + UTF-8 locale + no NO_COLOR → basic color, unicode on', () => {
    const caps = detectCapabilities({
      stdout: { isTTY: true, columns: 100, rows: 30 },
      env: { LANG: 'en_US.UTF-8' },
    });
    expect(caps).toEqual({
      isTTY: true,
      cols: 100,
      rows: 30,
      color: 'basic',
      unicode: true,
    });
  });

  test('non-TTY without CLICOLOR_FORCE → color none', () => {
    const caps = detectCapabilities({ stdout: { isTTY: false }, env: { LANG: 'en_US.UTF-8' } });
    expect(caps.color).toBe('none');
    expect(caps.isTTY).toBe(false);
  });

  test('NO_COLOR overrides everything (even CLICOLOR_FORCE)', () => {
    const caps = detectCapabilities({
      stdout: { isTTY: true },
      env: { NO_COLOR: '1', CLICOLOR_FORCE: '1' },
    });
    expect(caps.color).toBe('none');
  });

  test('CLICOLOR_FORCE=1 enables color even on non-TTY', () => {
    const caps = detectCapabilities({
      stdout: { isTTY: false },
      env: { CLICOLOR_FORCE: '1', LANG: 'en_US.UTF-8' },
    });
    expect(caps.color).toBe('basic');
  });

  test('locale without UTF-8 → unicode disabled', () => {
    const caps = detectCapabilities({
      stdout: { isTTY: true },
      env: { LANG: 'C', LC_ALL: 'POSIX' },
    });
    expect(caps.unicode).toBe(false);
  });

  test('LC_CTYPE wins over LANG when both set', () => {
    const caps = detectCapabilities({
      stdout: { isTTY: true },
      env: { LANG: 'C', LC_CTYPE: 'en_US.UTF-8' },
    });
    expect(caps.unicode).toBe(true);
  });

  test('missing columns falls back to 80×24', () => {
    const caps = detectCapabilities({ stdout: { isTTY: true }, env: {} });
    expect(caps.cols).toBe(80);
    expect(caps.rows).toBe(24);
  });

  test('NO_COLOR set to empty string is ignored (per spec)', () => {
    // The NO_COLOR convention says ANY value disables, but the empty
    // string is treated as unset by most implementations. We follow
    // that lenient interpretation so accidental `export NO_COLOR=`
    // doesn't break colors.
    const caps = detectCapabilities({
      stdout: { isTTY: true },
      env: { NO_COLOR: '', LANG: 'en_US.UTF-8' },
    });
    expect(caps.color).toBe('basic');
  });
});

describe('ANSI helpers', () => {
  test('cursor helpers no-op on n <= 0', () => {
    expect(cursorUp(0)).toBe('');
    expect(cursorUp(-3)).toBe('');
    expect(cursorDown(0)).toBe('');
    expect(cursorBack(-1)).toBe('');
  });

  test('cursorUp(N) emits CSI N A', () => {
    expect(cursorUp(5)).toBe(`${CSI}5A`);
  });

  test('cursorTo is 1-indexed', () => {
    expect(cursorTo(1, 1)).toBe(`${CSI}1;1H`);
    expect(cursorTo(10, 20)).toBe(`${CSI}10;20H`);
  });

  test('clearLine and clearDown are exact escape strings', () => {
    expect(clearLine).toBe(`${CSI}2K`);
    expect(clearDown).toBe(`${CSI}J`);
  });

  test('paint wraps with SGR when color enabled', () => {
    const caps: Pick<Capabilities, 'color'> = { color: 'basic' };
    expect(paint(caps, 'error', 'oops')).toBe(`${CSI}31moops${CSI}0m`);
  });

  test('paint passes through when color disabled', () => {
    const caps: Pick<Capabilities, 'color'> = { color: 'none' };
    expect(paint(caps, 'error', 'oops')).toBe('oops');
  });

  test('cursorForward(N) emits CSI N C', () => {
    expect(cursorForward(5)).toBe(`${CSI}5C`);
    expect(cursorForward(0)).toBe('');
    expect(cursorForward(-2)).toBe('');
  });

  test('reverse wraps with SGR 7 unconditionally (works under NO_COLOR)', () => {
    // Spec UI.md §4.10.8: reverse is an attribute, not a color —
    // emits the escape regardless of caps.color.
    expect(reverse('hello')).toBe(`${CSI}7mhello${CSI}0m`);
  });
});

describe('raw mode toggle', () => {
  let calls: boolean[] = [];
  const fakeStdin = {
    setRawMode(mode: boolean) {
      calls.push(mode);
      return undefined;
    },
  };

  afterEach(() => {
    // Reset module state to avoid cross-test bleed.
    disableRawMode(fakeStdin);
    calls = [];
  });

  test('enableRawMode flips the flag once', () => {
    expect(isRawModeActive()).toBe(false);
    expect(enableRawMode(fakeStdin)).toBe(true);
    expect(isRawModeActive()).toBe(true);
    enableRawMode(fakeStdin);
    expect(calls).toEqual([true]);
  });

  test('disableRawMode resets', () => {
    enableRawMode(fakeStdin);
    disableRawMode(fakeStdin);
    expect(isRawModeActive()).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  test('enableRawMode returns false on stream without setRawMode', () => {
    expect(enableRawMode({})).toBe(false);
  });
});

describe('bracketed paste toggle', () => {
  test('writes enable + disable escapes once each', () => {
    const writes: string[] = [];
    const write = (s: string): void => {
      writes.push(s);
    };
    enableBracketedPasteOn(write);
    enableBracketedPasteOn(write);
    expect(isBracketedPasteActive()).toBe(true);
    expect(writes).toEqual([`${CSI}?2004h`]);

    disableBracketedPasteOn(write);
    disableBracketedPasteOn(write);
    expect(isBracketedPasteActive()).toBe(false);
    expect(writes).toEqual([`${CSI}?2004h`, `${CSI}?2004l`]);
  });
});

describe('createResizeWatcher', () => {
  test('emits on stdout resize event', () => {
    const listeners: Array<() => void> = [];
    const stream = {
      columns: 80,
      rows: 24,
      on(_event: 'resize', l: () => void) {
        listeners.push(l);
      },
      off() {},
    };
    const watcher = createResizeWatcher(stream);
    const seen: { cols: number; rows: number }[] = [];
    watcher.onResize((e) => seen.push(e));
    stream.columns = 120;
    stream.rows = 40;
    listeners.forEach((l) => l());
    expect(seen).toEqual([{ cols: 120, rows: 40 }]);
    watcher.close();
  });

  test('unsubscribe stops further events', () => {
    const listeners: Array<() => void> = [];
    const stream = {
      columns: 80,
      rows: 24,
      on(_event: 'resize', l: () => void) {
        listeners.push(l);
      },
      off() {},
    };
    const watcher = createResizeWatcher(stream);
    let count = 0;
    const off = watcher.onResize(() => {
      count++;
    });
    listeners.forEach((l) => l());
    off();
    listeners.forEach((l) => l());
    expect(count).toBe(1);
    watcher.close();
  });
});

describe('createFrameScheduler', () => {
  // Shared deterministic timer harness — one queue, manual advance.
  type Pending = { fn: () => void; ms: number };
  const makeHarness = (): {
    setTimer: (fn: () => void, ms: number) => Pending;
    clearTimer: (h: unknown) => void;
    flushAll: () => void;
    pending: () => Pending[];
  } => {
    let pending: Pending[] = [];
    return {
      setTimer: (fn, ms) => {
        const p = { fn, ms };
        pending.push(p);
        return p;
      },
      clearTimer: (h) => {
        pending = pending.filter((p) => p !== h);
      },
      flushAll: () => {
        const snap = pending;
        pending = [];
        snap.forEach((p) => p.fn());
      },
      pending: () => pending.slice(),
    };
  };

  test('coalesces multiple requests into one render', () => {
    const h = makeHarness();
    let renders = 0;
    const sched = createFrameScheduler(() => renders++, {
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.request();
    sched.request();
    sched.request();
    expect(h.pending()).toHaveLength(1);
    h.flushAll();
    expect(renders).toBe(1);
    sched.close();
  });

  test('request after a render schedules a new frame', () => {
    const h = makeHarness();
    let renders = 0;
    const sched = createFrameScheduler(() => renders++, {
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.request();
    h.flushAll();
    sched.request();
    h.flushAll();
    expect(renders).toBe(2);
    sched.close();
  });

  test('flush() renders even when no request was pending', () => {
    const h = makeHarness();
    let renders = 0;
    const sched = createFrameScheduler(() => renders++, {
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.flush();
    expect(renders).toBe(1);
    expect(h.pending()).toHaveLength(0);
    sched.close();
  });

  test('flush() renders immediately and cancels pending timer', () => {
    const h = makeHarness();
    let renders = 0;
    const sched = createFrameScheduler(() => renders++, {
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.request();
    expect(h.pending()).toHaveLength(1);
    sched.flush();
    expect(renders).toBe(1);
    expect(h.pending()).toHaveLength(0);
    sched.close();
  });

  test('close prevents further renders even if a timer fires', () => {
    const h = makeHarness();
    let renders = 0;
    const sched = createFrameScheduler(() => renders++, {
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.request();
    sched.close();
    h.flushAll();
    expect(renders).toBe(0);
  });

  test('fps option sets timer interval', () => {
    const h = makeHarness();
    const sched = createFrameScheduler(() => {}, {
      fps: 60,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    sched.request();
    expect(h.pending()[0]?.ms).toBe(16);
    sched.close();
  });
});
