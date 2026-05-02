import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';
import { createFocusStack } from '../../src/tui/focus-stack.ts';
import type { KeyEvent, KeyName } from '../../src/tui/keys.ts';
import { type ModalManager, createModalManager } from '../../src/tui/modal-manager.ts';

// Synchronous timer harness for deterministic timeout tests.
const makeTimer = (): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  fire: (handle: unknown) => void;
  pending: () => unknown[];
} => {
  type Pending = { fn: () => void };
  let queue: Pending[] = [];
  return {
    setTimer: (fn) => {
      const p = { fn };
      queue.push(p);
      return p;
    },
    clearTimer: (h) => {
      queue = queue.filter((q) => q !== h);
    },
    fire: (handle) => {
      const p = queue.find((q) => q === handle) as Pending | undefined;
      if (p === undefined) return;
      queue = queue.filter((q) => q !== p);
      p.fn();
    },
    pending: () => queue.slice(),
  };
};

const key = (name: KeyName): KeyEvent => ({
  kind: 'key',
  name,
  ctrl: false,
  alt: false,
  shift: false,
  raw: '',
});

interface Setup {
  bus: ReturnType<typeof createBus>;
  fs: ReturnType<typeof createFocusStack>;
  manager: ModalManager;
  events: UIEvent[];
  timer: ReturnType<typeof makeTimer>;
  ids: () => string[];
}

let promptCounter = 0;
const make = (): Setup => {
  const bus = createBus();
  const fs = createFocusStack();
  const events: UIEvent[] = [];
  bus.onAny((e) => events.push(e));
  const timer = makeTimer();
  const ids: string[] = [];
  const manager = createModalManager({
    bus,
    focusStack: fs,
    now: () => 1000,
    newPromptId: () => {
      promptCounter++;
      const id = `p-${promptCounter}`;
      ids.push(id);
      return id;
    },
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });
  return { bus, fs, manager, events, timer, ids: () => ids.slice() };
};

describe('askPermission', () => {
  test('emits permission:ask, pushes a focus handler', () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'rm',
      cwd: '/',
    });
    expect(s.fs.size()).toBe(1);
    expect(s.events.some((e) => e.type === 'permission:ask')).toBe(true);
    // Resolve immediately so the test doesn't hang.
    s.fs.dispatch(key('escape'));
    return promise;
  });

  test('Enter on default selection (no) resolves to false', async () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'rm',
      cwd: '/',
    });
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe(false);
  });

  test('Right arrow toggles to yes; Enter resolves to true', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe(true);
  });

  test('Right arrow emits modal:select (NOT a re-emit of permission:ask)', () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    // Drop events from the initial ask so we only see what the toggle
    // emits.
    const beforeToggle = s.events.length;
    s.fs.dispatch(key('right'));
    const emitted = s.events.slice(beforeToggle);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: 'modal:select',
      selected: 'yes',
    });
    expect(emitted[0]?.type).not.toBe('permission:ask');
    s.fs.dispatch(key('escape'));
    return promise;
  });

  test('multiple toggles emit alternating modal:select events', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    const beforeToggle = s.events.length;
    s.fs.dispatch(key('right')); // → yes
    s.fs.dispatch(key('left')); // → no
    s.fs.dispatch(key('tab')); // → yes
    const emitted = s.events.slice(beforeToggle).filter((e) => e.type === 'modal:select');
    expect(emitted.map((e) => e.type === 'modal:select' && e.selected)).toEqual([
      'yes',
      'no',
      'yes',
    ]);
    s.fs.dispatch(key('escape'));
    await promise;
  });

  test('Tab toggles selection same as left/right', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('tab'));
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe(true);
  });

  test('Escape resolves to false even when yes is selected', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('escape'));
    await expect(promise).resolves.toBe(false);
  });

  test('emits permission:answer before the promise resolves', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    let answerEmittedBeforeResolve = false;
    void promise.then(() => {
      answerEmittedBeforeResolve = s.events.some((e) => e.type === 'permission:answer');
    });
    s.fs.dispatch(key('enter'));
    await promise;
    expect(answerEmittedBeforeResolve).toBe(true);
  });

  test('focus handler is removed after resolution', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    expect(s.fs.size()).toBe(1);
    s.fs.dispatch(key('enter'));
    await promise;
    expect(s.fs.size()).toBe(0);
  });

  test('printable char while modal is up is swallowed (handler returns true)', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    const consumed = s.fs.dispatch({
      kind: 'char',
      char: 'x',
      ctrl: false,
      alt: false,
      raw: 'x',
    });
    expect(consumed).toBe(true);
    s.fs.dispatch(key('escape'));
    await promise;
  });
});

describe('queue', () => {
  test('two askPermission calls: first opens, second waits', async () => {
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'c1', cwd: '/' });
    const p2 = s.manager.askPermission({ toolName: 'b', command: 'c2', cwd: '/' });
    expect(s.manager.pendingCount()).toBe(2);
    expect(s.fs.size()).toBe(1); // only one handler at a time
    s.fs.dispatch(key('enter')); // resolves p1 with no
    await p1;
    // After draining, the second modal is now active.
    expect(s.fs.size()).toBe(1);
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('enter'));
    await expect(p2).resolves.toBe(true);
    expect(s.manager.pendingCount()).toBe(0);
  });
});

describe('timeout', () => {
  test('timeout fires while active: rejects as false', async () => {
    const s = make();
    const promise = s.manager.askPermission(
      { toolName: 'b', command: 'c', cwd: '/' },
      { timeoutMs: 100 },
    );
    expect(s.timer.pending()).toHaveLength(1);
    const handle = s.timer.pending()[0];
    s.timer.fire(handle);
    await expect(promise).resolves.toBe(false);
    expect(s.fs.size()).toBe(0);
  });

  test('explicit answer clears the timeout', async () => {
    const s = make();
    const promise = s.manager.askPermission(
      { toolName: 'b', command: 'c', cwd: '/' },
      { timeoutMs: 100 },
    );
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('enter'));
    await promise;
    // Timer was canceled before firing.
    expect(s.timer.pending()).toHaveLength(0);
  });

  test('timeout while still queued: rejects without ever opening', async () => {
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    const p2 = s.manager.askPermission(
      { toolName: 'b', command: 'b', cwd: '/' },
      { timeoutMs: 50 },
    );
    // p2's timer is in the queue while p1 is active.
    const handle = s.timer.pending().find((h) => h !== undefined);
    s.timer.fire(handle);
    await expect(p2).resolves.toBe(false);
    // p1 still open; resolve to drain.
    s.fs.dispatch(key('enter'));
    await p1;
  });
});

describe('close', () => {
  test('rejects active and queued modals as false; clears focus stack', async () => {
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    const p2 = s.manager.askPermission({ toolName: 'b', command: 'b', cwd: '/' });
    s.manager.close();
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false);
    expect(s.fs.size()).toBe(0);
    expect(s.manager.pendingCount()).toBe(0);
  });

  test('askPermission after close resolves false immediately (no orphan promise)', async () => {
    const s = make();
    s.manager.close();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    await expect(promise).resolves.toBe(false);
    // Nothing pushed onto the focus stack, no events emitted for this
    // call (just the close path's no-op).
    expect(s.fs.size()).toBe(0);
    expect(s.manager.pendingCount()).toBe(0);
  });
});
