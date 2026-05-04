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

const key = (
  name: KeyName,
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
): KeyEvent => ({
  kind: 'key',
  name,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
  raw: '',
});

const charKey = (char: string, mods: { ctrl?: boolean; alt?: boolean } = {}): KeyEvent => ({
  kind: 'char',
  char,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  raw: char,
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
const make = (overrides: { onInterrupt?: () => void } = {}): Setup => {
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
    ...(overrides.onInterrupt !== undefined ? { onInterrupt: overrides.onInterrupt } : {}),
  });
  return { bus, fs, manager, events, timer, ids: () => ids.slice() };
};

describe('askPermission (3-option modal per UI.md §4.10.13)', () => {
  test('emits permission:ask, pushes a focus handler', () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'rm',
      cwd: '/',
    });
    expect(s.fs.size()).toBe(1);
    expect(s.events.some((e) => e.type === 'permission:ask')).toBe(true);
    s.fs.dispatch(key('escape'));
    return promise;
  });

  test('default selectedIndex = last option (No); Enter without navigating resolves "no"', async () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'rm',
      cwd: '/',
    });
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe('no');
  });

  test('Esc resolves "cancel" (distinct from "no")', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('escape'));
    await expect(promise).resolves.toBe('cancel');
  });

  test('Ctrl+C resolves "cancel" AND fires onInterrupt without falling through', async () => {
    // Modal handles Ctrl+C atomically: resolve the modal AND trigger
    // the REPL's interrupt ladder via onInterrupt, then consume the
    // keystroke. The earlier "fall through to editor" approach was
    // broken — the editor's Ctrl+C only fires cancelInput when the
    // input buffer is empty, so a draft mid-typing dismissed the
    // modal AND cleared the buffer but FAILED to abort the run.
    // The operator was stuck pressing Ctrl+C twice (losing draft).
    //
    // New contract: onInterrupt is the single hook for the abort
    // path; lower handlers don't see the keystroke (return true =
    // consumed). Buffer is preserved.
    let interruptFired = 0;
    const s = make({
      onInterrupt: () => {
        interruptFired += 1;
      },
    });
    let observedByLower = false;
    const lowerHandler = (k: KeyEvent): boolean => {
      if (k.kind === 'char' && k.char === 'c' && k.ctrl) observedByLower = true;
      return true;
    };
    s.fs.push(lowerHandler);
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(charKey('c', { ctrl: true }));
    await expect(promise).resolves.toBe('cancel');
    expect(interruptFired).toBe(1);
    // Lower handler must NOT have observed the keystroke — it was
    // fully consumed by the modal handler.
    expect(observedByLower).toBe(false);
  });

  test('Ctrl+C without onInterrupt still resolves the modal (callback optional)', async () => {
    // Tests / headless flows that build a modal-manager without a
    // REPL still get the "dismiss on Ctrl+C" behavior — abort just
    // doesn't fire because there's nothing to abort. Documented
    // contract.
    const s = make(); // no onInterrupt
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(charKey('c', { ctrl: true }));
    await expect(promise).resolves.toBe('cancel');
  });

  test('hotkey "1" resolves "yes" directly (no navigate-then-Enter)', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(charKey('1'));
    await expect(promise).resolves.toBe('yes');
  });

  test('hotkey "2" resolves "session-allow"', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(charKey('2'));
    await expect(promise).resolves.toBe('session-allow');
  });

  test('hotkey "3" resolves "no" (same as default Enter)', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(charKey('3'));
    await expect(promise).resolves.toBe('no');
  });

  test('Shift+Tab as secondary shortcut activates session-allow option', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('tab', { shift: true }));
    await expect(promise).resolves.toBe('session-allow');
  });

  test('Up arrow moves selection up by one; Enter resolves the new selection', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    // Default is index 2 ('no'). Up → 1 ('session-allow'). Enter resolves it.
    s.fs.dispatch(key('up'));
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe('session-allow');
  });

  test('Down arrow at the bottom is a no-op (clamps to last index)', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    // Default = last (index 2). Down should clamp.
    s.fs.dispatch(key('down'));
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe('no');
  });

  test('Up at the top is a no-op (clamps to index 0)', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('up')); // 2 → 1
    s.fs.dispatch(key('up')); // 1 → 0
    s.fs.dispatch(key('up')); // clamps at 0
    s.fs.dispatch(key('up')); // still 0
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe('yes');
  });

  test('Up arrow emits modal:select with the new selectedIndex', () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    const beforeNav = s.events.length;
    s.fs.dispatch(key('up'));
    const emitted = s.events.slice(beforeNav);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'modal:select', selectedIndex: 1 });
    s.fs.dispatch(key('escape'));
    return promise;
  });

  test('Multiple navigations emit a modal:select per move with the right index', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    const beforeNav = s.events.length;
    s.fs.dispatch(key('up')); // 2 → 1
    s.fs.dispatch(key('up')); // 1 → 0
    s.fs.dispatch(key('down')); // 0 → 1
    const indices = s.events
      .slice(beforeNav)
      .filter((e): e is Extract<UIEvent, { type: 'modal:select' }> => e.type === 'modal:select')
      .map((e) => e.selectedIndex);
    expect(indices).toEqual([1, 0, 1]);
    s.fs.dispatch(key('escape'));
    await promise;
  });

  test('emits modal:answer before the promise resolves', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    let answerEmittedBeforeResolve = false;
    void promise.then(() => {
      answerEmittedBeforeResolve = s.events.some((e) => e.type === 'modal:answer');
    });
    s.fs.dispatch(key('enter'));
    await promise;
    expect(answerEmittedBeforeResolve).toBe(true);
  });

  test('modal:answer carries the user-selected decision string', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(charKey('2')); // session-allow
    await promise;
    const answer = s.events.find(
      (e): e is Extract<UIEvent, { type: 'modal:answer' }> => e.type === 'modal:answer',
    );
    expect(answer?.decision).toBe('session-allow');
  });

  test('modal:answer carries "cancel" on Esc (distinct from "no")', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    s.fs.dispatch(key('escape'));
    await promise;
    const answer = s.events.find(
      (e): e is Extract<UIEvent, { type: 'modal:answer' }> => e.type === 'modal:answer',
    );
    expect(answer?.decision).toBe('cancel');
  });

  test('focus handler is removed after resolution', async () => {
    const s = make();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    expect(s.fs.size()).toBe(1);
    s.fs.dispatch(key('enter'));
    await promise;
    expect(s.fs.size()).toBe(0);
  });

  test('non-matching printable char is swallowed (no fall-through to editor)', async () => {
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
    s.fs.dispatch(key('enter')); // resolves p1 with 'no' (default)
    await p1;
    // After draining, the second modal is now active.
    expect(s.fs.size()).toBe(1);
    s.fs.dispatch(charKey('1')); // resolves p2 with 'yes'
    await expect(p2).resolves.toBe('yes');
    expect(s.manager.pendingCount()).toBe(0);
  });
});

describe('timeout', () => {
  test('timeout fires while active: resolves "cancel"', async () => {
    const s = make();
    const promise = s.manager.askPermission(
      { toolName: 'b', command: 'c', cwd: '/' },
      { timeoutMs: 100 },
    );
    expect(s.timer.pending()).toHaveLength(1);
    const handle = s.timer.pending()[0];
    s.timer.fire(handle);
    await expect(promise).resolves.toBe('cancel');
    expect(s.fs.size()).toBe(0);
  });

  test('explicit answer clears the timeout', async () => {
    const s = make();
    const promise = s.manager.askPermission(
      { toolName: 'b', command: 'c', cwd: '/' },
      { timeoutMs: 100 },
    );
    s.fs.dispatch(charKey('1'));
    await promise;
    // Timer was canceled before firing.
    expect(s.timer.pending()).toHaveLength(0);
  });

  test('timeout while still queued: resolves "cancel" without ever opening', async () => {
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    const p2 = s.manager.askPermission(
      { toolName: 'b', command: 'b', cwd: '/' },
      { timeoutMs: 50 },
    );
    // p2's timer is in the queue while p1 is active.
    const handle = s.timer.pending().find((h) => h !== undefined);
    s.timer.fire(handle);
    await expect(p2).resolves.toBe('cancel');
    // p1 still open; resolve to drain.
    s.fs.dispatch(key('enter'));
    await p1;
  });
});

describe('close', () => {
  test('resolves active and queued modals as "cancel"; clears focus stack', async () => {
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    const p2 = s.manager.askPermission({ toolName: 'b', command: 'b', cwd: '/' });
    s.manager.close();
    await expect(p1).resolves.toBe('cancel');
    await expect(p2).resolves.toBe('cancel');
    expect(s.fs.size()).toBe(0);
    expect(s.manager.pendingCount()).toBe(0);
  });

  test('askPermission after close resolves "cancel" immediately (no orphan promise)', async () => {
    const s = make();
    s.manager.close();
    const promise = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });
    await expect(promise).resolves.toBe('cancel');
    expect(s.fs.size()).toBe(0);
    expect(s.manager.pendingCount()).toBe(0);
  });
});

describe('askMemoryWrite (memory:write:ask producer)', () => {
  test('emits memory:write:ask with scope/name/body and pushes focus handler', () => {
    const s = make();
    s.manager.askMemoryWrite({
      scope: 'project_local',
      name: 'no-console-log',
      body: 'Lorem ipsum.',
    });
    expect(s.fs.size()).toBe(1);
    const ask = s.events.find((e) => e.type === 'memory:write:ask');
    expect(ask).toBeDefined();
    if (ask?.type !== 'memory:write:ask') throw new Error('wrong event type');
    expect(ask.scope).toBe('project_local');
    expect(ask.name).toBe('no-console-log');
    expect(ask.body).toBe('Lorem ipsum.');
  });

  test('default selectedIndex = last (No); plain Enter resolves "no"', async () => {
    const s = make();
    const promise = s.manager.askMemoryWrite({
      scope: 'user',
      name: 'pref',
      body: 'b',
    });
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe('no');
  });

  test('hotkey "1" resolves "yes"', async () => {
    const s = make();
    const promise = s.manager.askMemoryWrite({
      scope: 'project_local',
      name: 'x',
      body: 'b',
    });
    s.fs.dispatch(charKey('1'));
    await expect(promise).resolves.toBe('yes');
  });

  test('Esc resolves "cancel" (distinct from "no")', async () => {
    const s = make();
    const promise = s.manager.askMemoryWrite({
      scope: 'project_local',
      name: 'x',
      body: 'b',
    });
    s.fs.dispatch(key('escape'));
    await expect(promise).resolves.toBe('cancel');
  });
});
