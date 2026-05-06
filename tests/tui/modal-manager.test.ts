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

  test('subagent attribution is forwarded to permission:ask event', () => {
    // Spec docs/spec/IPC.md §7: when the parent proxies a child's
    // permission:ask, the modal must show which subagent is
    // requesting. The manager threads the optional `subagent`
    // field straight onto the emitted event; the reducer renders.
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'rm',
      cwd: '/p',
      subagent: { sessionId: 'sess-12345678', name: 'explore' },
    });
    const askEvent = s.events.find((e) => e.type === 'permission:ask');
    expect(askEvent).toBeDefined();
    if (askEvent !== undefined && askEvent.type === 'permission:ask') {
      expect(askEvent.subagent).toEqual({
        sessionId: 'sess-12345678',
        name: 'explore',
      });
    }
    s.fs.dispatch(key('escape'));
    return promise;
  });

  test('omitting subagent leaves the event field absent', () => {
    // Defensive — the manager spreads conditionally so consumers
    // that branch on `subagent !== undefined` (the reducer does)
    // never see a truthy field for a parent's own confirm.
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'rm',
      cwd: '/p',
    });
    const askEvent = s.events.find((e) => e.type === 'permission:ask');
    expect(askEvent).toBeDefined();
    if (askEvent !== undefined && askEvent.type === 'permission:ask') {
      expect(askEvent.subagent).toBeUndefined();
    }
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

  test('queue depth events: live updates as asks enqueue + resolve', async () => {
    // Three asks pile up: first opens active, second + third queue.
    // The contract:
    //   - First ask opens → no `modal:queue-depth` (queue empty
    //     behind it, no suffix needed). We skip emitting depth=0
    //     to keep the event stream quieter.
    //   - Second ask enqueues while active → emit depth=1 keyed to
    //     active.promptId so the suffix becomes `(+1 waiting)`.
    //   - Third ask enqueues → emit depth=2.
    //   - Operator answers active → resolveActive → drain pops
    //     second (now active). drain emits depth=1 keyed to the
    //     newly-active modal (one still queued behind).
    //   - Answer that → drain pops third. queue.length === 0 →
    //     no depth event (the modal renders bare).
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'c1', cwd: '/' });
    expect(s.events.filter((e) => e.type === 'modal:queue-depth')).toHaveLength(0);

    const p2 = s.manager.askPermission({ toolName: 'b', command: 'c2', cwd: '/' });
    let depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(1);
    if (depthEvents[0]?.type === 'modal:queue-depth') {
      expect(depthEvents[0].depth).toBe(1);
    }

    const p3 = s.manager.askPermission({ toolName: 'b', command: 'c3', cwd: '/' });
    depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(2);
    if (depthEvents[1]?.type === 'modal:queue-depth') {
      expect(depthEvents[1].depth).toBe(2);
    }

    // Resolve the active. drain pops next; emits depth=1 for it.
    s.fs.dispatch(key('enter')); // p1 → 'no'
    await p1;
    depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(3);
    if (depthEvents[2]?.type === 'modal:queue-depth') {
      expect(depthEvents[2].depth).toBe(1);
    }

    // Resolve the next active. drain pops third — empty queue
    // behind it, no event.
    s.fs.dispatch(key('enter')); // p2 → 'no'
    await p2;
    depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(3);

    // Wrap up.
    s.fs.dispatch(key('enter'));
    await p3;
  });

  test('queue depth events key on the ACTIVE modal promptId, not the enqueued one', async () => {
    // Regression guard: a buggy emit could key the depth event to
    // the just-enqueued ask's promptId instead of the active one.
    // The reducer would then drop it (mismatched promptId), the
    // suffix would never appear. Verify the active's promptId is
    // what gets emitted.
    const s = make();
    s.manager.askPermission({ toolName: 'b', command: 'c1', cwd: '/' });
    const firstAsk = s.events.find((e) => e.type === 'permission:ask');
    expect(firstAsk).toBeDefined();
    const activeId = firstAsk?.type === 'permission:ask' ? firstAsk.promptId : '';
    expect(activeId).not.toBe('');

    s.manager.askPermission({ toolName: 'b', command: 'c2', cwd: '/' });
    const depthEvent = s.events.find((e) => e.type === 'modal:queue-depth');
    expect(depthEvent).toBeDefined();
    if (depthEvent?.type === 'modal:queue-depth') {
      expect(depthEvent.promptId).toBe(activeId);
      expect(depthEvent.depth).toBe(1);
    }

    // Tear down so the test process doesn't leak handles.
    s.fs.dispatch(key('escape'));
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

  test('producer signal aborts the active modal: resolves cancel + drains next', async () => {
    const s = make();
    const ac = new AbortController();
    const p1 = s.manager.askPermission(
      { toolName: 'b', command: 'a', cwd: '/' },
      { signal: ac.signal },
    );
    const p2 = s.manager.askPermission({ toolName: 'b', command: 'b', cwd: '/' });

    // p1 active, p2 queued. Aborting p1's signal must close it
    // and drain p2.
    ac.abort();
    await expect(p1).resolves.toBe('cancel');

    // p2 is now active. Resolve to drain.
    s.fs.dispatch(charKey('1'));
    await expect(p2).resolves.toBe('yes');
  });

  test('producer signal aborts a queued modal: emits queue-depth correction', async () => {
    // Same shape as the queued-timeout regression guard above —
    // verifies the abort path goes through the same
    // cancelPending helper. Active stays untouched; the queued
    // entry vanishes; the active modal's `(+N waiting)` suffix
    // drops by one.
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    const firstAsk = s.events.find((e) => e.type === 'permission:ask');
    const activeId = firstAsk?.type === 'permission:ask' ? firstAsk.promptId : '';

    const ac = new AbortController();
    const p2 = s.manager.askPermission(
      { toolName: 'b', command: 'b', cwd: '/' },
      { signal: ac.signal },
    );
    const p3 = s.manager.askPermission({ toolName: 'b', command: 'c', cwd: '/' });

    let depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(2);
    if (depthEvents[1]?.type === 'modal:queue-depth') {
      expect(depthEvents[1].depth).toBe(2);
    }

    // Abort p2 (queued). Active (p1) must stay; queue depth corrects to 1.
    ac.abort();
    await expect(p2).resolves.toBe('cancel');

    depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(3);
    if (depthEvents[2]?.type === 'modal:queue-depth') {
      expect(depthEvents[2].depth).toBe(1);
      expect(depthEvents[2].promptId).toBe(activeId);
    }

    // Tear down.
    s.fs.dispatch(key('enter'));
    await p1;
    s.fs.dispatch(key('enter'));
    await p3;
  });

  test('producer signal pre-aborted: cancels synchronously without ever opening', async () => {
    const s = make();
    const ac = new AbortController();
    ac.abort();
    const p = s.manager.askPermission(
      { toolName: 'b', command: 'a', cwd: '/' },
      { signal: ac.signal },
    );
    await expect(p).resolves.toBe('cancel');
    expect(s.manager.pendingCount()).toBe(0);
  });

  test('signal listener detaches when modal resolves naturally (no per-ask leak)', async () => {
    // Memory hygiene for shared signals — the subagent permission
    // proxy uses one AbortSignal per child session, but a child
    // can issue many asks. If every resolved ask left its abort
    // listener attached, eventual signal abort would fire an O(n)
    // burst of stale callbacks (each a no-op, but each holding a
    // closure alive). Verify add/remove balance via a tracked
    // signal that counts both calls.
    //
    // Five asks, all resolved by operator (hotkey '1'). After
    // resolution, the signal should have ZERO net listeners
    // attached — five adds matched by five removes.
    const s = make();
    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const trackedSignal = new Proxy(ac.signal, {
      get(target, prop) {
        if (prop === 'addEventListener') {
          return (
            type: string,
            listener: EventListener,
            options?: AddEventListenerOptions | boolean,
          ): void => {
            if (type === 'abort') addCount += 1;
            target.addEventListener(type, listener, options);
          };
        }
        if (prop === 'removeEventListener') {
          return (
            type: string,
            listener: EventListener,
            options?: EventListenerOptions | boolean,
          ): void => {
            if (type === 'abort') removeCount += 1;
            target.removeEventListener(type, listener, options);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        s.manager.askPermission(
          { toolName: 'b', command: `c${i}`, cwd: '/' },
          { signal: trackedSignal },
        ),
      );
    }
    expect(addCount).toBe(5);

    // Resolve each in turn via hotkey '1' (yes). Drain queue.
    for (let i = 0; i < 5; i++) {
      s.fs.dispatch(charKey('1'));
      await promises[i];
    }

    // Every ask's listener was detached on resolve. Pre-fix:
    // addCount=5, removeCount=0 → 5 stale listeners would fire
    // when ac.abort() runs. Post-fix: balanced.
    expect(removeCount).toBe(5);
  });

  test('signal listener detaches when modal closes via Esc (cancel path)', async () => {
    // Esc resolves 'cancel' → resolveActive runs → detach fires.
    // Same balance check as the natural-resolve test above.
    const s = make();
    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const trackedSignal = new Proxy(ac.signal, {
      get(target, prop) {
        if (prop === 'addEventListener') {
          return (
            type: string,
            listener: EventListener,
            options?: AddEventListenerOptions | boolean,
          ): void => {
            if (type === 'abort') addCount += 1;
            target.addEventListener(type, listener, options);
          };
        }
        if (prop === 'removeEventListener') {
          return (
            type: string,
            listener: EventListener,
            options?: EventListenerOptions | boolean,
          ): void => {
            if (type === 'abort') removeCount += 1;
            target.removeEventListener(type, listener, options);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

    const p = s.manager.askPermission(
      { toolName: 'b', command: 'a', cwd: '/' },
      { signal: trackedSignal },
    );
    expect(addCount).toBe(1);
    s.fs.dispatch(key('escape'));
    await expect(p).resolves.toBe('cancel');
    expect(removeCount).toBe(1);
  });

  test('signal cancel of a queued modal also clears its scheduled timeout', async () => {
    // Regression guard. The active branch of cancelPending
    // routes through resolveActive which clears the timeout;
    // the queued branch resolved directly without the
    // clearTimer call, leaving live timers behind for every
    // signal-cancelled queued modal. No functional break (the
    // timer's later fire is a no-op on settled promises) but
    // the timer keeps the event loop alive longer than needed
    // and accrues callback churn under repeated cancels.
    const s = make();
    const ac = new AbortController();

    // First ask is the active one — no timer needed.
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    // Second ask is queued behind p1 with both a signal AND a
    // timeout. Aborting the signal must clear the timer so
    // s.timer.pending() reports empty.
    const p2 = s.manager.askPermission(
      { toolName: 'b', command: 'b', cwd: '/' },
      { signal: ac.signal, timeoutMs: 9999 },
    );
    // The queued timer is registered.
    expect(s.timer.pending()).toHaveLength(1);

    // Abort the signal. Queued path of cancelPending fires.
    ac.abort();
    await expect(p2).resolves.toBe('cancel');

    // Pre-fix: timer still queued (length 1, would fire later).
    // Post-fix: clearTimer ran inside cancelPending; no timer.
    expect(s.timer.pending()).toHaveLength(0);

    // Tear down p1.
    s.fs.dispatch(key('enter'));
    await p1;
  });

  test('timeout while still queued: emits modal:queue-depth so the suffix corrects down', async () => {
    // Regression guard. Earlier the queued-timeout branch removed
    // the entry and resolved the promise but never emitted a
    // `modal:queue-depth` event — the active modal's `(+N
    // waiting)` suffix would keep showing the stale higher count
    // until the operator answered the active and drain popped
    // the next. With three asks (one active + two queued, both
    // with timers), firing one queued timer must drop the
    // displayed depth from 2 to 1 immediately.
    const s = make();
    const p1 = s.manager.askPermission({ toolName: 'b', command: 'a', cwd: '/' });
    const firstAsk = s.events.find((e) => e.type === 'permission:ask');
    const activeId = firstAsk?.type === 'permission:ask' ? firstAsk.promptId : '';
    expect(activeId).not.toBe('');

    const p2 = s.manager.askPermission(
      { toolName: 'b', command: 'b', cwd: '/' },
      { timeoutMs: 50 },
    );
    const p3 = s.manager.askPermission(
      { toolName: 'b', command: 'c', cwd: '/' },
      { timeoutMs: 50 },
    );

    // Two depth events so far: depth=1 (after p2 enqueue), depth=2
    // (after p3 enqueue), both keyed to p1 (the active one).
    let depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(2);
    if (depthEvents[1]?.type === 'modal:queue-depth') {
      expect(depthEvents[1].depth).toBe(2);
      expect(depthEvents[1].promptId).toBe(activeId);
    }

    // Fire p2's timer. It's in the queue (p1 is active).
    const timers = s.timer.pending();
    expect(timers).toHaveLength(2);
    const handleP2 = timers[0];
    s.timer.fire(handleP2);
    await expect(p2).resolves.toBe('cancel');

    // The third depth event should fire AFTER p2 dropped — depth=1
    // (only p3 left in queue), still keyed to the active p1.
    depthEvents = s.events.filter((e) => e.type === 'modal:queue-depth');
    expect(depthEvents).toHaveLength(3);
    if (depthEvents[2]?.type === 'modal:queue-depth') {
      expect(depthEvents[2].depth).toBe(1);
      expect(depthEvents[2].promptId).toBe(activeId);
    }

    // Tear down: fire p3's timer (now the only queued one), then
    // resolve the active so the test exits cleanly.
    const remaining = s.timer.pending();
    expect(remaining).toHaveLength(1);
    s.timer.fire(remaining[0]);
    await expect(p3).resolves.toBe('cancel');
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

describe('askMemoryUserScope (memory:user-scope:ask producer, spec §7.2.5)', () => {
  test('emits memory:user-scope:ask and pushes focus handler', () => {
    const s = make();
    s.manager.askMemoryUserScope({ name: 'pref', body: 'b' });
    expect(s.fs.size()).toBe(1);
    const ask = s.events.find((e) => e.type === 'memory:user-scope:ask');
    expect(ask).toBeDefined();
    if (ask?.type !== 'memory:user-scope:ask') throw new Error('wrong type');
    expect(ask.name).toBe('pref');
    expect(ask.body).toBe('b');
  });

  test('default selectedIndex = last (No); plain Enter resolves "no"', async () => {
    const s = make();
    const promise = s.manager.askMemoryUserScope({ name: 'p', body: 'b' });
    s.fs.dispatch(key('enter'));
    await expect(promise).resolves.toBe('no');
  });

  test('hotkey "1" resolves "yes"', async () => {
    const s = make();
    const promise = s.manager.askMemoryUserScope({ name: 'p', body: 'b' });
    s.fs.dispatch(charKey('1'));
    await expect(promise).resolves.toBe('yes');
  });

  test('Esc resolves "cancel"', async () => {
    const s = make();
    const promise = s.manager.askMemoryUserScope({ name: 'p', body: 'b' });
    s.fs.dispatch(key('escape'));
    await expect(promise).resolves.toBe('cancel');
  });
});
