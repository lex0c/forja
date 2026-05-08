// End-to-end test for the modal pattern: manager → bus → reducer →
// rendered output. Covers the spec-shape modal (UI.md §4.10.13):
// 3-option list, hotkey activation, Esc=cancel, navigation preserves
// content.

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

const charKey = (char: string): KeyEvent => ({
  kind: 'char',
  char,
  ctrl: false,
  alt: false,
  raw: char,
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

describe('modal navigation preserves contents', () => {
  test('initial ask renders title, subject, preview, options', () => {
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'rm -rf ./build',
      cwd: '/home/lex/forja',
      rule: 'bash.rm.rf',
    });
    const out = s.rendered();
    expect(out).not.toBeNull();
    // Title block.
    expect(out).toContain('Run command');
    expect(out).toContain('rm -rf ./build');
    // Preview block.
    expect(out).toContain('$ rm -rf ./build');
    expect(out).toContain('cwd: /home/lex/forja');
    expect(out).toContain('matched rule: bash.rm.rf');
    // Options.
    expect(out).toContain('1. Yes');
    expect(out).toContain('2. Yes, allow all bash during this session');
    expect(out).toContain('3. No');
    s.fs.dispatch(key('escape'));
  });

  test('Up navigation does NOT wipe title/preview/options', () => {
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'rm -rf ./build',
      cwd: '/home/lex/forja',
    });
    const before = s.rendered() ?? '';
    s.fs.dispatch(key('up'));
    const after = s.rendered() ?? '';
    // All four blocks survive the navigation.
    expect(after).toContain('Run command');
    expect(after).toContain('$ rm -rf ./build');
    expect(after).toContain('1. Yes');
    expect(after).toContain('3. No');
    // Cursor moved from option 3 (No) to option 2 (session-allow).
    expect(before).toMatch(/> 3\. No/);
    expect(after).toMatch(/> 2\. Yes, allow all bash during this session/);
    s.fs.dispatch(key('escape'));
  });

  test('multiple navigations preserve contents through the full cycle', () => {
    const s = make();
    void s.manager.askPermission({
      toolName: 'edit_file',
      command: 'src/foo.ts',
      cwd: '/r',
    });
    s.fs.dispatch(key('up')); // 2 → 1
    s.fs.dispatch(key('up')); // 1 → 0
    s.fs.dispatch(key('down')); // 0 → 1
    const out = s.rendered() ?? '';
    expect(out).toContain('Run command');
    expect(out).toContain('src/foo.ts');
    expect(out).toMatch(/> 2\. Yes, allow all edit_file during this session/);
    s.fs.dispatch(key('escape'));
  });

  test('hotkey "1" resolves "yes"; modal cleared from state', async () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'echo',
      cwd: '/',
    });
    s.fs.dispatch(charKey('1'));
    const answer = await promise;
    expect(answer).toBe('yes');
    expect(s.getState().modal).toBeNull();
  });

  test('Esc resolves "cancel" even after navigating; modal cleared', async () => {
    const s = make();
    const promise = s.manager.askPermission({
      toolName: 'bash',
      command: 'echo',
      cwd: '/',
    });
    s.fs.dispatch(key('up'));
    s.fs.dispatch(key('escape'));
    const answer = await promise;
    expect(answer).toBe('cancel');
    expect(s.getState().modal).toBeNull();
  });

  test('rule + layer renders "matched rule: X (project policy)"', () => {
    // Operator's win: instead of a generic "matched rule: rm *",
    // they see WHICH YAML to edit. layer label disambiguates
    // enterprise vs user vs project vs session.
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'rm -rf /tmp',
      cwd: '/r',
      rule: 'rm -rf *',
      layer: 'project',
    });
    const out = s.rendered() ?? '';
    expect(out).toContain('matched rule: rm -rf * (project policy)');
    s.fs.dispatch(key('escape'));
  });

  test('rule with layer="default" renders "(built-in default)"', () => {
    // No layer wrote the section; rule fired from a synthesized
    // path. Distinct label so operator doesn't go looking for a
    // YAML that doesn't exist.
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'echo',
      cwd: '/r',
      rule: 'echo *',
      layer: 'default',
    });
    const out = s.rendered() ?? '';
    expect(out).toContain('matched rule: echo * (built-in default)');
    s.fs.dispatch(key('escape'));
  });

  test('rule without layer renders the bare matched-rule line (back-compat)', () => {
    // Synthesized events / pre-source consumers keep working —
    // the layer suffix simply doesn't render.
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'echo',
      cwd: '/r',
      rule: 'echo *',
    });
    const out = s.rendered() ?? '';
    expect(out).toContain('matched rule: echo *');
    expect(out).not.toContain('policy)');
    expect(out).not.toContain('built-in');
    s.fs.dispatch(key('escape'));
  });

  test('layer alone (no rule) renders "no rule matched in <layer> policy"', () => {
    // Default-deny path: section consulted but no rule matched.
    // The layer alone tells the operator where to add an allow
    // rule so the default-deny goes away. Sentence form
    // ("no rule matched in user policy") reads cleanly; the
    // earlier "policy section: user" wording confused 'user'
    // (a layer) with section names like 'bash'.
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'whoami',
      cwd: '/r',
      layer: 'user',
    });
    const out = s.rendered() ?? '';
    expect(out).toContain('no rule matched in user policy');
    expect(out).not.toContain('matched rule:');
    s.fs.dispatch(key('escape'));
  });

  test('layer="default" alone (no rule) renders no extra line — no actionable info', () => {
    // No layer wrote the section AND no rule matched. The modal's
    // question text already conveys "denied" — adding a "no rule
    // matched in default policy" line would mislead operators
    // into looking for a YAML named "default".
    const s = make();
    void s.manager.askPermission({
      toolName: 'bash',
      command: 'whoami',
      cwd: '/r',
      layer: 'default',
    });
    const out = s.rendered() ?? '';
    expect(out).not.toContain('no rule matched');
    expect(out).not.toContain('matched rule');
    s.fs.dispatch(key('escape'));
  });

  test('queued modal: first resolves, second renders fresh contents', async () => {
    const s = make();
    const p1 = s.manager.askPermission({
      toolName: 'bash',
      command: 'first',
      cwd: '/a',
    });
    const p2 = s.manager.askPermission({
      toolName: 'edit_file',
      command: 'second',
      cwd: '/b',
    });
    // First modal is up.
    expect(s.rendered()).toContain('first');
    s.fs.dispatch(key('enter')); // resolves p1 'no' (default)
    await p1;
    // Second modal drained.
    const second = s.rendered() ?? '';
    expect(second).toContain('second');
    expect(second).toContain('cwd: /b');
    expect(second).not.toContain('first'); // contents replaced cleanly
    s.fs.dispatch(key('escape'));
    await p2;
  });
});

describe('per-flavor reducer option lists', () => {
  test('trust:ask builds 2 options (yes / no), default = last (no)', () => {
    const state = applyEvent(createInitialState(), {
      type: 'trust:ask',
      ts: 1,
      promptId: 'p1',
      path: '/some/repo',
      agentsMd: true,
    }).state;
    expect(state.modal).not.toBeNull();
    if (state.modal === null) return;
    expect(state.modal.flavor).toBe('trust');
    expect(state.modal.title).toBe('Accessing workspace:');
    // Path moved out of `subject` and into the preview so a long
    // cwd doesn't crowd the bold title.
    expect(state.modal.subject).toBeNull();
    expect(state.modal.preview[0]).toBe('/some/repo');
    expect(state.modal.options.map((o) => o.value)).toEqual(['yes', 'no']);
    // D65 (UI.md §6.5): last option is the conservative default.
    expect(state.modal.selectedIndex).toBe(1);
    // AGENTS.md note appears in preview when present.
    expect(state.modal.preview.some((l) => l.includes('AGENTS.md'))).toBe(true);
  });

  test('memory:write:ask builds 2 options (yes / no), default = last; body is the preview', () => {
    const state = applyEvent(createInitialState(), {
      type: 'memory:write:ask',
      ts: 1,
      promptId: 'p1',
      scope: 'project_local',
      name: 'config-rule',
      body: 'line 1\nline 2',
    }).state;
    if (state.modal === null) throw new Error('modal not set');
    expect(state.modal.flavor).toBe('memory-write');
    expect(state.modal.title).toBe('Write memory');
    expect(state.modal.subject).toBe('project_local/config-rule');
    expect(state.modal.preview).toEqual(['line 1', 'line 2']);
    expect(state.modal.options.map((o) => o.value)).toEqual(['yes', 'no']);
    expect(state.modal.selectedIndex).toBe(1);
  });

  test('memory:user-scope:ask builds 2 options + scope warning preview', () => {
    const state = applyEvent(createInitialState(), {
      type: 'memory:user-scope:ask',
      ts: 1,
      promptId: 'p1',
      name: 'global-pref',
      body: 'body line',
    }).state;
    if (state.modal === null) throw new Error('modal not set');
    expect(state.modal.flavor).toBe('memory-user-scope');
    expect(state.modal.title).toBe('Confirm user-scope memory');
    expect(state.modal.subject).toBe('global-pref');
    // Warning text comes BEFORE the body content so the operator
    // reads the blast-radius reminder first. Preview is sentences,
    // not column-wrapped — renderer handles wrap-to-width.
    expect(state.modal.preview[0]).toContain('EVERY session');
    expect(state.modal.preview[0]).toContain('regardless of project');
    expect(state.modal.preview).toContain('body line');
    expect(state.modal.options.map((o) => o.value)).toEqual(['yes', 'no']);
    // Default = last (No), per D5 conservative-default convention.
    expect(state.modal.selectedIndex).toBe(1);
  });

  test('plan:review builds 3 options (approve / edit / reject), default = last (reject)', () => {
    const state = applyEvent(createInitialState(), {
      type: 'plan:review',
      ts: 1,
      promptId: 'p1',
      steps: ['read foo', 'edit bar', 'run tests'],
      estimatedCalls: 5,
      estimatedCostUsd: 0.034,
    }).state;
    if (state.modal === null) throw new Error('modal not set');
    expect(state.modal.flavor).toBe('plan-review');
    expect(state.modal.options.map((o) => o.value)).toEqual(['yes', 'edit', 'no']);
    expect(state.modal.selectedIndex).toBe(2);
    // Preview: numbered steps + estimate footer.
    expect(state.modal.preview[0]).toBe('1. read foo');
    expect(state.modal.preview.some((l) => l.includes('5 tool calls'))).toBe(true);
    expect(state.modal.preview.some((l) => l.includes('$0.03'))).toBe(true);
  });

  test('critique:ask builds 3 options (ignore/redo/abort), default = last; issues are the preview', () => {
    const state = applyEvent(createInitialState(), {
      type: 'critique:ask',
      ts: 1,
      promptId: 'p1',
      issues: [
        { severity: 'high', confidence: 0.9, message: 'security risk' },
        { severity: 'low', confidence: 0.5, message: 'style' },
      ],
    }).state;
    if (state.modal === null) throw new Error('modal not set');
    expect(state.modal.flavor).toBe('critique');
    expect(state.modal.options.map((o) => o.value)).toEqual(['ignore', 'redo', 'abort']);
    // Default selection is `abort` (last) — the most conservative
    // answer when a proposal got flagged. Proceeding blind
    // (ignore) and re-running (redo) both keep the run going;
    // abort is the only outcome that stops without making
    // forward progress on possibly-broken output.
    expect(state.modal.selectedIndex).toBe(2);
    expect(state.modal.preview).toHaveLength(2);
    expect(state.modal.preview[0]).toContain('high');
    expect(state.modal.preview[0]).toContain('security risk');
    // Default headline (no writes-intent flagged).
    expect(state.modal.title).toBe('Critique');
  });

  test('critique:ask with toolPlanWrites=true uses the stronger headline', () => {
    const state = applyEvent(createInitialState(), {
      type: 'critique:ask',
      ts: 1,
      promptId: 'p1',
      issues: [{ severity: 'high', confidence: 0.9, message: 'unsafe rm' }],
      toolPlanWrites: true,
    }).state;
    if (state.modal === null) throw new Error('modal not set');
    expect(state.modal.title).toBe('Critique — about to mutate');
    // Question copy reflects the writes framing too.
    expect(state.modal.question).toContain('Proceed');
  });
});

describe('modal:select reducer behavior', () => {
  test('modal:select with matching promptId updates only selectedIndex', () => {
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
      selectedIndex: 0,
    }).state;
    expect(state.modal).not.toBeNull();
    if (state.modal !== null && before !== null) {
      expect(state.modal.selectedIndex).toBe(0);
      // Other fields untouched.
      expect(state.modal.title).toBe(before.title);
      expect(state.modal.options).toEqual(before.options);
      expect(state.modal.preview).toEqual(before.preview);
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
    const beforeIdx = state.modal?.selectedIndex;
    state = applyEvent(state, {
      type: 'modal:select',
      ts: 2,
      promptId: 'OTHER',
      selectedIndex: 0,
    }).state;
    expect(state.modal?.selectedIndex).toBe(beforeIdx); // unchanged
  });

  test('modal:select clamps out-of-range selectedIndex', () => {
    let state = createInitialState();
    state = applyEvent(state, {
      type: 'permission:ask',
      ts: 1,
      promptId: 'p1',
      toolName: 'bash',
      command: 'rm',
      cwd: '/r',
    }).state;
    const optionCount = state.modal?.options.length ?? 0;
    state = applyEvent(state, {
      type: 'modal:select',
      ts: 2,
      promptId: 'p1',
      selectedIndex: 999,
    }).state;
    expect(state.modal?.selectedIndex).toBe(optionCount - 1);
    state = applyEvent(state, {
      type: 'modal:select',
      ts: 3,
      promptId: 'p1',
      selectedIndex: -5,
    }).state;
    expect(state.modal?.selectedIndex).toBe(0);
  });

  test('modal:select with no active modal is a no-op', () => {
    const r = applyEvent(createInitialState(), {
      type: 'modal:select',
      ts: 1,
      promptId: 'p1',
      selectedIndex: 0,
    });
    expect(r.state.modal).toBeNull();
    expect(r.permanent).toEqual([]);
  });
});
