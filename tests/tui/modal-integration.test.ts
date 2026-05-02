// End-to-end test for the modal pattern: manager → bus → reducer →
// rendered output. Verifies the fix for the toggle-erases-content
// bug — pressing Right must not wipe message/details.

import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';
import { createFocusStack } from '../../src/tui/focus-stack.ts';
import type { KeyEvent, KeyName } from '../../src/tui/keys.ts';
import { createModalManager } from '../../src/tui/modal-manager.ts';
import { renderModal } from '../../src/tui/render/modal.ts';
import { type LiveState, applyEvent, createInitialState } from '../../src/tui/state.ts';
import type { Capabilities } from '../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 100,
  rows: 24,
  color: 'none',
  unicode: true,
};

const key = (name: KeyName): KeyEvent => ({
  kind: 'key',
  name,
  ctrl: false,
  alt: false,
  shift: false,
  raw: '',
});

let counter = 0;
const make = () => {
  const bus = createBus();
  const fs = createFocusStack();
  let state: LiveState = createInitialState();
  // Mimic the renderer: subscribe to all events and fold via the
  // reducer. State always reflects the latest event after this
  // subscription fires (synchronous via EventEmitter).
  bus.onAny((e: UIEvent) => {
    state = applyEvent(state, e).state;
  });
  const manager = createModalManager({
    bus,
    focusStack: fs,
    now: () => 1000,
    newPromptId: () => {
      counter++;
      return `int-${counter}`;
    },
  });
  return {
    bus,
    fs,
    manager,
    getState: () => state,
    rendered: () => (state.modal !== null ? renderModal(state.modal, caps).join('\n') : null),
  };
};

describe('modal toggle preserves contents (regression: toggle-erases-bug)', () => {
  test('initial ask renders message and details', () => {
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'rm -rf ./build',
      cwd: '/home/lex/forja',
      rule: 'bash.rm.rf',
    });
    const out = s.rendered();
    expect(out).not.toBeNull();
    expect(out).toContain('bash: rm -rf ./build');
    expect(out).toContain('cwd: /home/lex/forja');
    expect(out).toContain('rule: bash.rm.rf');
    s.fs.dispatch(key('escape'));
  });

  test('Right toggle does NOT wipe message or details', () => {
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'rm -rf ./build',
      cwd: '/home/lex/forja',
    });
    const before = s.rendered() ?? '';
    s.fs.dispatch(key('right'));
    const after = s.rendered() ?? '';
    // Both message and details survive the toggle.
    expect(after).toContain('bash: rm -rf ./build');
    expect(after).toContain('cwd: /home/lex/forja');
    // Selector flipped from NO to YES.
    expect(before).toContain('▶ NO');
    expect(after).toContain('▶ YES');
    s.fs.dispatch(key('escape'));
  });

  test('multiple toggles preserve contents through the full cycle', () => {
    const s = make();
    void s.manager.askPermission({
      toolName: 'edit',
      command: 'src/foo.ts',
      cwd: '/r',
    });
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('left'));
    s.fs.dispatch(key('tab'));
    const out = s.rendered() ?? '';
    expect(out).toContain('edit: src/foo.ts');
    expect(out).toContain('cwd: /r');
    expect(out).toContain('▶ YES');
    s.fs.dispatch(key('escape'));
  });

  test('Enter on toggled-yes resolves true; modal cleared from state', async () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'echo',
      cwd: '/',
    });
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('enter'));
    const accepted = await promise;
    expect(accepted).toBe(true);
    expect(s.getState().modal).toBeNull();
  });

  test('Esc resolves false even after toggle to yes; modal cleared', async () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'echo',
      cwd: '/',
    });
    s.fs.dispatch(key('right'));
    s.fs.dispatch(key('escape'));
    const accepted = await promise;
    expect(accepted).toBe(false);
    expect(s.getState().modal).toBeNull();
  });

  test('queued modal: first resolves, second renders fresh contents', async () => {
    const s = make();
    const p1 = s.manager.askPermission({
      toolName: 'bash',
      command: 'first',
      cwd: '/a',
    });
    const p2 = s.manager.askPermission({
      toolName: 'edit',
      command: 'second',
      cwd: '/b',
    });
    // First modal is up.
    expect(s.rendered()).toContain('first');
    s.fs.dispatch(key('enter')); // resolves p1 false
    await p1;
    // Second modal drained.
    const second = s.rendered() ?? '';
    expect(second).toContain('edit: second');
    expect(second).toContain('cwd: /b');
    expect(second).not.toContain('first'); // contents replaced cleanly
    s.fs.dispatch(key('escape'));
    await p2;
  });
});

describe('modal:select reducer behavior', () => {
  test('modal:select with matching promptId updates only `selected`', () => {
    let state = createInitialState();
    state = applyEvent(state, {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm',
      cwd: '/r',
    }).state;
    const before = state.modal;
    state = applyEvent(state, {
      type: 'modal:select',
      ts: 2,
      promptId: 'p1',
      selected: 'yes',
    }).state;
    expect(state.modal).not.toBeNull();
    if (state.modal !== null && before !== null) {
      expect(state.modal.selected).toBe('yes');
      expect(state.modal.message).toBe(before.message);
      expect(state.modal.details).toEqual(before.details);
    }
  });

  test('modal:select with mismatched promptId is dropped', () => {
    let state = createInitialState();
    state = applyEvent(state, {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm',
      cwd: '/r',
    }).state;
    state = applyEvent(state, {
      type: 'modal:select',
      ts: 2,
      promptId: 'OTHER',
      selected: 'yes',
    }).state;
    expect(state.modal?.selected).toBe('no'); // unchanged
  });

  test('modal:select with no active modal is a no-op', () => {
    const r = applyEvent(createInitialState(), {
      type: 'modal:select',
      ts: 1,
      promptId: 'p1',
      selected: 'yes',
    });
    expect(r.state.modal).toBeNull();
    expect(r.permanent).toEqual([]);
  });
});
