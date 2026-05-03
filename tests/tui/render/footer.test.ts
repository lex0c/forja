import { describe, expect, test } from 'bun:test';
import { renderFooter } from '../../../src/tui/render/footer.ts';
import { visualWidth } from '../../../src/tui/render/width.ts';
import { type ActiveTool, type LiveState, createInitialState } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};

const startedSession = (overrides: Partial<LiveState['status']> = {}): LiveState => {
  const s = createInitialState();
  return {
    ...s,
    status: {
      ...s.status,
      sessionId: 's1',
      profile: 'autonomous',
      project: 'forja',
      model: 'sonnet-4.6',
      maxSteps: 50,
      steps: 3,
      costUsd: 0.012,
      ...overrides,
    },
  };
};

describe('renderFooter', () => {
  test('idle state: help hint left, model + steps + cost right', () => {
    const out = renderFooter(startedSession(), caps);
    expect(out).not.toBeNull();
    expect(out).toContain('? for help');
    expect(out).toContain('• sonnet-4.6');
    expect(out).toContain('3/50');
    expect(out).toContain('$0.0120');
    // Interrupt cue absent when nothing is running.
    expect(out).not.toContain('esc to interrupt');
  });

  test('running state: adds esc to interrupt to the left column', () => {
    const s = startedSession();
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: null,
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    const out = renderFooter(s, caps);
    expect(out).toContain('? for help · esc to interrupt');
  });

  test('thinking state also triggers interrupt cue', () => {
    const s = startedSession();
    s.thinking = { startedAt: 0 };
    expect(renderFooter(s, caps)).toContain('esc to interrupt');
  });

  test('pendingAssistant (streaming text) also triggers interrupt cue', () => {
    const s = startedSession();
    s.pendingAssistant = {
      messageId: 'm1',
      text: '',
      startedAt: 0,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreation: null,
    };
    expect(renderFooter(s, caps)).toContain('esc to interrupt');
  });

  test('soft-aborted + running swaps cue to "esc again to force"', () => {
    // Spec UI.md §4.10.6: once the operator hit Esc once mid-turn,
    // the footer signals that the loop has acknowledged and is
    // winding down — pressing Esc again will force.
    const s = startedSession();
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: null,
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    s.softInterrupted = true;
    const out = renderFooter(s, caps);
    expect(out).toContain('esc again to force');
    // Original "esc to interrupt" cue is replaced, not duplicated.
    expect(out).not.toContain('esc to interrupt');
  });

  test('soft-aborted + streaming pendingAssistant also swaps the cue', () => {
    // The cue must swap regardless of WHICH operation is keeping
    // isRunning true (tool, thinking, or assistant streaming). Tool
    // path is covered above; this test locks the streaming-only path.
    const s = startedSession();
    s.softInterrupted = true;
    s.pendingAssistant = {
      messageId: 'm1',
      text: '',
      startedAt: 0,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreation: null,
    };
    const out = renderFooter(s, caps);
    expect(out).toContain('esc again to force');
    expect(out).not.toContain('esc to interrupt');
  });

  test('soft-aborted + idle drops the cue entirely (run already done)', () => {
    // softInterrupted should self-clear via session:end, but a guard:
    // if it somehow lingers in the absence of a running operation,
    // the footer doesn't surface either cue. The "esc again to force"
    // signal is meaningless when there's nothing to force against.
    const s = startedSession();
    s.softInterrupted = true;
    const out = renderFooter(s, caps);
    expect(out).not.toContain('esc again to force');
    expect(out).not.toContain('esc to interrupt');
  });

  test('plan mode adds `plan` between model and budget', () => {
    const s = startedSession({ planMode: true });
    const out = renderFooter(s, caps);
    expect(out).toContain('• sonnet-4.6 · plan · 3/50');
  });

  test('bg processes show as `bg N` after cost (spec UI.md §4.4 line 245)', () => {
    const s = startedSession();
    s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
    s.bgProcesses.set('p2', { processId: 'p2', command: 'pytest' });
    const out = renderFooter(s, caps);
    // Order: model · steps/max · cost · bg N.
    expect(out).toContain('• sonnet-4.6 · 3/50 · $0.0120 · bg 2');
  });

  test('bg counter only surfaces when size > 0 (zero processes drops the token)', () => {
    const s = startedSession();
    expect(s.bgProcesses.size).toBe(0);
    const out = renderFooter(s, caps);
    expect(out).not.toContain('bg ');
    expect(out).toContain('• sonnet-4.6 · 3/50');
  });

  test('bg + plan mode coexist in correct order (model · plan · steps · cost · bg)', () => {
    const s = startedSession({ planMode: true });
    s.bgProcesses.set('p1', { processId: 'p1', command: 'x' });
    const out = renderFooter(s, caps);
    expect(out).toContain('• sonnet-4.6 · plan · 3/50 · $0.0120 · bg 1');
  });

  test('null when modal is up', () => {
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      title: 'm',
      subject: null,
      preview: [],
      question: null,
      options: [{ key: '1', label: 'OK', value: 'yes' }],
      selectedIndex: 0,
      hints: [],
    };
    expect(renderFooter(s, caps)).toBeNull();
  });

  test('pre-session (no model) shows only the help hint, no right column', () => {
    const out = renderFooter(createInitialState(), caps);
    expect(out).toContain('? for help');
    expect(out).not.toContain('•');
  });

  test('right column anchors to caps.cols (full-width pad)', () => {
    const out = renderFooter(startedSession(), caps);
    expect(visualWidth(out ?? '')).toBe(caps.cols);
  });

  test('renders dim SGR when color enabled', () => {
    const colored: Capabilities = { ...caps, color: 'basic' };
    const out = renderFooter(startedSession(), colored);
    expect(out).toContain(`${CSI}90m`);
  });

  test('cost format degrades with magnitude (under $1 = 4 decimals)', () => {
    expect(renderFooter(startedSession({ costUsd: 0.0008 }), caps)).toContain('$0.0008');
    expect(renderFooter(startedSession({ costUsd: 1.234 }), caps)).toContain('$1.234');
    expect(renderFooter(startedSession({ costUsd: 100.5 }), caps)).toContain('$100.50');
  });

  test('overflow: long content collapses padding to 0 (truncation kicks in upstream)', () => {
    // Stuff the model name to push the right column past caps.cols.
    // visualWidth(left) + visualWidth(right) > caps.cols → padding=0.
    // The renderer's truncateToWidth handles the actual clip; the
    // footer just delivers a longer-than-cols line without crashing.
    const wide = startedSession({ model: 'a'.repeat(200) });
    const out = renderFooter(wide, caps);
    expect(out).not.toBeNull();
    // No padding spaces between left and right means they touch.
    // visualWidth strips ANSI; result will exceed caps.cols.
    expect(visualWidth(out ?? '')).toBeGreaterThanOrEqual(caps.cols);
  });

  test('right column gated by sessionId (single proxy, all-or-nothing)', () => {
    // Status with model set but sessionId still null → still pre-
    // session for footer purposes. Avoids the half-state bug where
    // model rendered but cost/budget didn't.
    const half = createInitialState();
    half.status = { ...half.status, model: 'sonnet-4.6', maxSteps: 50 };
    const out = renderFooter(half, caps);
    expect(out).not.toContain('•');
    expect(out).not.toContain('sonnet-4.6');
  });

  describe('idle exit-armed cue (UI.md §5.4 + §4.10.6)', () => {
    test('exitArmed swaps left column to "Press Ctrl-C again to exit"', () => {
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      const out = renderFooter(s, caps);
      expect(out).toContain('Press Ctrl-C again to exit');
      // Help hint and any interrupt cue are suppressed — the gate
      // is the only thing the operator should be reading.
      expect(out).not.toContain('? for help');
      expect(out).not.toContain('esc to interrupt');
    });

    test('exit cue takes precedence over running interrupt cue (operator priority)', () => {
      // Edge case: gate armed AND a tool is running. Producer
      // shouldn't normally arm during a run (handleIdleInterrupt
      // gates on `running`), but defense in depth — if both flags
      // are true, the exit cue wins because it's a 1-tap-to-exit
      // hazard and the operator's next keystroke is the most
      // load-bearing.
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      const tool: ActiveTool = {
        toolId: 't1',
        name: 'bash',
        activeVerb: 'Executing',
        finalVerb: 'Executed',
        subject: null,
        startedAt: 0,
        preview: [],
      };
      s.activeTools.set('t1', tool);
      const out = renderFooter(s, caps);
      expect(out).toContain('Press Ctrl-C again to exit');
      expect(out).not.toContain('esc to interrupt');
      expect(out).not.toContain('esc again to force');
    });

    test('exit cue is painted in warn palette when color enabled', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      const out = renderFooter(s, colored);
      // SGR 33 (yellow / warn) per term.ts SGR.warn.
      expect(out).toContain(`${CSI}33m`);
      expect(out).toContain('Press Ctrl-C again to exit');
    });

    test('exitArmed null restores the help hint (no leftover cue)', () => {
      const s = startedSession();
      s.exitArmed = null;
      const out = renderFooter(s, caps);
      expect(out).toContain('? for help');
      expect(out).not.toContain('Press Ctrl-C again to exit');
    });

    test('right column unchanged when exitArmed is set (status surface stays honest)', () => {
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      const out = renderFooter(s, caps);
      // The model/steps/cost remain in the right column — the gate
      // only takes over the left.
      expect(out).toContain('• sonnet-4.6');
      expect(out).toContain('3/50');
      expect(out).toContain('$0.0120');
    });
  });
});
