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
  test('bash mode replaces the footer with the shell-mode indicator', () => {
    const s = startedSession();
    const out = renderFooter({ ...s, input: { value: '!ls', cursor: 3 } }, caps);
    expect(out).not.toBeNull();
    expect(out).toContain('! for shell mode');
    // Normal cues are hidden while composing a shell command.
    expect(out).not.toContain('supervised mode on');
    expect(out).not.toContain('sonnet-4.6');
  });

  test('bash-mode footer is suppressed WHILE A TURN RUNS — interrupt cue stays', () => {
    // A `!` typed mid-turn is refused on submit, so flipping to the
    // shell indicator would advertise a dead mode AND hide the
    // load-bearing interrupt cue. isBashMode is busy-gated.
    const s = startedSession();
    const out = renderFooter(
      {
        ...s,
        input: { value: '!ls', cursor: 3 },
        busy: true,
        awaitingProvider: { stepN: 1, startedAt: 0 },
      },
      caps,
    );
    expect(out).not.toContain('! for shell mode');
    expect(out).toContain('esc to interrupt');
  });

  test('bash-mode footer is suppressed while busy with NO turn activity (playbook / another `!cmd`)', () => {
    // The case isTurnRunning misses: `state.busy` is true but no
    // activeTools/thinking/pending/awaiting (a playbook gap, or another
    // operator `!cmd` running). Typing `!` must still NOT show shell
    // mode, since Enter would refuse it.
    const s = startedSession();
    const out = renderFooter({ ...s, input: { value: '!ls', cursor: 3 }, busy: true }, caps);
    expect(out).not.toContain('! for shell mode');
  });

  test('bash-mode footer is suppressed under reverse-search (dim owns the box)', () => {
    const s = startedSession();
    const out = renderFooter(
      {
        ...s,
        input: { value: '!ls', cursor: 3 },
        reverseSearch: { query: '', results: [], selectedIdx: -1 },
      },
      caps,
    );
    // Reverse-search active → normal footer, not the shell indicator.
    expect(out).not.toContain('! for shell mode');
    expect(out).toContain('supervised mode on');
  });

  test('idle state: operation-mode cue left, model right (cost/steps chips removed)', () => {
    const out = renderFooter(startedSession(), caps);
    expect(out).not.toBeNull();
    // The operation-mode cue replaced the old `? for help` hint
    // (UI.md §4.10.6). Default posture is supervised.
    expect(out).toContain('supervised mode on (shift+tab to change)');
    expect(out).not.toContain('? for help');
    // Newline hint pairs with the input editor's backslash
    // continuation (UI.md §5.4).
    expect(out).toContain('\\+Enter newline');
    expect(out).toContain('sonnet-4.6');
    // Cost + step counter were removed from the footer — too
    // low-signal next to the tokens / context-used chips.
    expect(out).not.toContain('$0.');
    expect(out).not.toContain('3/50');
    // Interrupt cue absent when nothing is running.
    expect(out).not.toContain('esc to interrupt');
  });

  test('renders the selected effort chip on the right when set', () => {
    const out = renderFooter(startedSession({ effort: 'high' }), caps);
    expect(out).toContain('effort: high');
    // Both effort and model live in the right cluster.
    expect(out).toContain('sonnet-4.6');
  });

  test('omits the effort chip when effort is null (pre-banner)', () => {
    const out = renderFooter(startedSession(), caps);
    expect(out).not.toContain('effort:');
  });

  test('autonomous posture renders the autonomous mode-on label', () => {
    const out = renderFooter(startedSession({ operationMode: 'autonomous' }), caps);
    expect(out).toContain('autonomous mode on (shift+tab to change)');
    expect(out).not.toContain('supervised mode on');
  });

  test('mode cue: supervised mode on painted accent (blue), autonomous mode on painted warn (yellow)', () => {
    const colored: Capabilities = { ...caps, color: 'basic' };
    // supervised mode on → accent = CSI 94 m (blue).
    const sup = renderFooter(startedSession(), colored);
    expect(sup).toContain(`${CSI}94msupervised mode on${CSI}0m`);
    // autonomous mode on → warn = CSI 33 m (yellow) — a deliberate "heads up".
    const auto = renderFooter(startedSession({ operationMode: 'autonomous' }), colored);
    expect(auto).toContain(`${CSI}33mautonomous mode on${CSI}0m`);
    // The "(shift+tab to change)" affordance is secondary (90m) in both.
    expect(sup).toContain(`${CSI}90m (shift+tab to change)${CSI}0m`);
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
    s.busy = true; // a running turn mirrors the REPL as busy
    const out = renderFooter(s, caps);
    // During a turn the operator isn't composing, so the newline hint
    // is dropped and the interrupt cue takes its slot — keeps the
    // load-bearing cue on screen at 80 cols.
    expect(out).toContain('supervised mode on (shift+tab to change) · esc to interrupt');
    expect(out).not.toContain('\\+Enter newline');
  });

  test('thinking state also triggers interrupt cue', () => {
    const s = startedSession();
    s.thinking = { startedAt: 0, messageId: 'm1' };
    s.busy = true;
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
    s.busy = true;
    expect(renderFooter(s, caps)).toContain('esc to interrupt');
  });

  test('busy with NO turn activity (a running `!cmd`) still shows the interrupt cue', () => {
    // A `!sleep 5` mirrors the REPL as busy but sets no turn fields
    // (activeTools/thinking/pending/awaiting). Ctrl+C/Esc kill it, so the
    // cue must show — keying off `state.busy`, not turn-local activity.
    const s = startedSession();
    s.busy = true;
    const out = renderFooter(s, caps);
    expect(out).toContain('esc to interrupt');
    expect(out).not.toContain('\\+Enter newline');
  });

  test('awaiting-provider (model deliberating) keeps the interrupt cue, not the newline hint', () => {
    // Regression: the model can deliberate for seconds before the first
    // token — the longest phase of a turn. The footer must hold the
    // interrupt cue instead of flipping to the idle newline hint (the
    // reported "fica apenas \+Enter newline, pisca pra esc" bug).
    const s = startedSession();
    s.awaitingProvider = { stepN: 1, startedAt: 0 };
    s.busy = true; // busy spans the awaiting-provider phase (set at startTurn)
    const out = renderFooter(s, caps);
    expect(out).toContain('esc to interrupt');
    expect(out).not.toContain('\\+Enter newline');
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
    s.busy = true;
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
    s.busy = true;
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

  test('cost does NOT surface in the footer (chip removed)', () => {
    const out = renderFooter(startedSession({ costUsd: 12.34 }), caps) ?? '';
    expect(out).not.toContain('$');
  });

  test('bg processes do NOT surface in the footer (chip removed)', () => {
    const s = startedSession();
    s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
    s.bgProcesses.set('p2', { processId: 'p2', command: 'pytest' });
    const out = renderFooter(s, caps) ?? '';
    expect(out).not.toContain('bg ');
  });

  test('memoryCount does NOT surface in the footer (chip removed)', () => {
    const out = renderFooter(startedSession({ memoryCount: 7 }), caps) ?? '';
    expect(out).not.toContain('mem ');
  });

  describe('session-total tokens chip', () => {
    test('renders compact `Nk tokens` right after the model chip', () => {
      const out =
        renderFooter(
          startedSession({
            sessionTotalTokens: 12_400,
            lastTurnContextTokens: 90_000,
            contextWindow: 200_000,
          }),
          caps,
        ) ?? '';
      expect(out).toContain('12k tokens');
      // Order: model · tokens · context%. Tokens come right after
      // model so the operator's load cluster reads
      // identity → weight → saturation.
      expect(out.indexOf('sonnet-4.6')).toBeLessThan(out.indexOf('12k tokens'));
      expect(out.indexOf('12k tokens')).toBeLessThan(out.indexOf('45% context used'));
    });

    test('zero tokens drops the chip entirely', () => {
      const out = renderFooter(startedSession({ sessionTotalTokens: 0 }), caps) ?? '';
      expect(out).not.toContain('tokens');
    });

    test('format degrades with magnitude', () => {
      expect(renderFooter(startedSession({ sessionTotalTokens: 850 }), caps) ?? '').toContain(
        '850 tokens',
      );
      // Sub-10k: one decimal where it adds info, integer otherwise.
      expect(renderFooter(startedSession({ sessionTotalTokens: 1234 }), caps) ?? '').toContain(
        '1.2k tokens',
      );
      expect(renderFooter(startedSession({ sessionTotalTokens: 2000 }), caps) ?? '').toContain(
        '2k tokens',
      );
      // 10k+ rounds to whole thousands.
      expect(renderFooter(startedSession({ sessionTotalTokens: 45_678 }), caps) ?? '').toContain(
        '46k tokens',
      );
      // Million-scale degrades again.
      expect(renderFooter(startedSession({ sessionTotalTokens: 1_200_000 }), caps) ?? '').toContain(
        '1.2M tokens',
      );
    });
  });

  describe('% context used chip', () => {
    test('renders `X% context used` when contextWindow and lastTurnContextTokens are set', () => {
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 90_000 }),
          caps,
        ) ?? '';
      expect(out).toContain('45% context used');
    });

    test('suppressed when contextWindow is 0 (banner not seen yet)', () => {
      const out =
        renderFooter(startedSession({ contextWindow: 0, lastTurnContextTokens: 90_000 }), caps) ??
        '';
      expect(out).not.toContain('context used');
    });

    test('suppressed when no turn has landed yet', () => {
      const out =
        renderFooter(startedSession({ contextWindow: 200_000, lastTurnContextTokens: 0 }), caps) ??
        '';
      expect(out).not.toContain('context used');
    });

    test('paints `warn` (yellow, SGR 33) when ratio crosses the 80% threshold', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 170_000 }),
          colored,
        ) ?? '';
      // 170k / 200k = 85% → past the 80% gate, painted warn.
      expect(out).toContain('85% context used');
      expect(out).toContain(`${CSI}33m85% context used${CSI}0m`);
    });

    test('stays `secondary` (grey, SGR 90) below the 80% threshold', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 100_000 }),
          colored,
        ) ?? '';
      expect(out).toContain('50% context used');
      expect(out).toContain(`${CSI}90m50% context used${CSI}0m`);
    });

    test('clamps to 100% when usage exceeds the window (provider edge case)', () => {
      const out =
        renderFooter(
          startedSession({ contextWindow: 100_000, lastTurnContextTokens: 250_000 }),
          caps,
        ) ?? '';
      expect(out).toContain('100% context used');
    });
  });

  describe('"always visible" lead chips before session:start', () => {
    test('model + tokens + ctx render even with sessionId null', () => {
      // Simulates the boot window: banner landed (model + window
      // stamped), tokens accumulated via assistant:end, but the
      // user hasn't submitted yet so sessionId is still null.
      const s = createInitialState();
      s.status = {
        ...s.status,
        model: 'anthropic/claude-opus-4-7',
        contextWindow: 200_000,
        sessionTotalTokens: 12_400,
        lastTurnContextTokens: 90_000,
      };
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('anthropic/claude-opus-4-7');
      expect(out).toContain('12k tokens');
      expect(out).toContain('45% context used');
    });
  });

  test('subagents counter does NOT surface in the footer (chip removed)', () => {
    const s = startedSession();
    s.subagents.set('child-1', {
      subagentId: 'child-1',
      name: 'explore',
      goal: 'find auth',
      progress: '',
      startedAt: 0,
      liveCostUsd: 0,
    });
    const out = renderFooter(s, caps) ?? '';
    expect(out).not.toContain('subagents ');
  });

  test('parallelStatus does NOT surface subagents/tools chips (chips removed)', () => {
    const s = startedSession();
    s.parallelStatus = {
      subagentsRunning: 2,
      subagentsQueued: 3,
      subagentsCap: 3,
      toolsRunning: 3,
      toolsCap: 3,
    };
    const out = renderFooter(s, caps) ?? '';
    expect(out).not.toContain('subagents ');
    expect(out).not.toContain('tools ');
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
      queueDepth: 0,
    };
    expect(renderFooter(s, caps)).toBeNull();
  });

  test('pre-session (no model) shows only the mode cue, no right column', () => {
    const out = renderFooter(createInitialState(), caps);
    expect(out).toContain('supervised mode on (shift+tab to change)');
    expect(out).not.toContain('•');
  });

  test('right column anchors to caps.cols (full-width pad)', () => {
    const out = renderFooter(startedSession(), caps);
    expect(visualWidth(out ?? '')).toBe(caps.cols);
  });

  test('renders secondary SGR (bright-black grey) when color enabled', () => {
    // Footer uses `secondary` (SGR 90) instead of `dim` (SGR 2) so
    // the hint stays visible on terminals that render faint as
    // default (xterm, screen, urxvt). Spec UI.md §6.1.
    const colored: Capabilities = { ...caps, color: 'basic' };
    const out = renderFooter(startedSession(), colored);
    expect(out).toContain(`${CSI}90m`);
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

  test('pre-session: model visible before sessionId is set', () => {
    // Model chip is "always visible" — surfaces as soon as
    // session:banner lands (before sessionId is set on
    // session:start), and stays across idle gaps between turns.
    const half = createInitialState();
    half.status = { ...half.status, model: 'sonnet-4.6' };
    const out = renderFooter(half, caps);
    expect(out).toContain('sonnet-4.6');
  });

  describe('slash popover open suppresses help hints', () => {
    // When the slash popover is open directly below the input, the
    // footer drops `? for help` and `\+Enter newline` so the operator
    // isn't reading two competing UI surfaces at once.
    test('hides both help hints when state.slash is non-null', () => {
      const s = startedSession();
      s.slash = {
        suggestions: [{ name: 'help', description: 'show help' }],
        selectedIdx: 0,
      };
      const out = renderFooter(s, caps);
      expect(out).not.toContain('shift+tab to change');
      expect(out).not.toContain('\\+Enter newline');
    });

    test('right column stays intact (model still visible)', () => {
      const s = startedSession();
      s.slash = { suggestions: [], selectedIdx: -1 };
      const out = renderFooter(s, caps);
      expect(out).toContain('sonnet-4.6');
    });

    test('interrupt cue still surfaces if a run is in flight', () => {
      const s = startedSession();
      s.slash = { suggestions: [{ name: 'a', description: '' }], selectedIdx: 0 };
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
      s.busy = true;
      const out = renderFooter(s, caps);
      expect(out).toContain('esc to interrupt');
      expect(out).not.toContain('shift+tab to change');
    });

    test('exitArmed beats slash (gate cue still wins)', () => {
      // Defense in depth: if the operator somehow has the popover
      // open AND the exit gate armed (unlikely — typing during slash
      // resets the gate), the lethal cue still owns the column.
      const s = startedSession();
      s.slash = { suggestions: [{ name: 'a', description: '' }], selectedIdx: 0 };
      s.exitArmed = { at: 1000 };
      const out = renderFooter(s, caps);
      expect(out).toContain('Press Ctrl-C again to exit');
    });
  });

  describe('idle exit-armed cue (UI.md §5.4 + §4.10.6)', () => {
    test('exitArmed swaps left column to "Press Ctrl-C again to exit"', () => {
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      const out = renderFooter(s, caps);
      expect(out).toContain('Press Ctrl-C again to exit');
      // Help hint and any interrupt cue are suppressed — the gate
      // is the only thing the operator should be reading.
      expect(out).not.toContain('shift+tab to change');
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

    test('exitArmed null restores the mode cue (no leftover cue)', () => {
      const s = startedSession();
      s.exitArmed = null;
      const out = renderFooter(s, caps);
      expect(out).toContain('supervised mode on (shift+tab to change)');
      expect(out).not.toContain('Press Ctrl-C again to exit');
    });

    test('right column unchanged when exitArmed is set (status surface stays honest)', () => {
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      const out = renderFooter(s, caps);
      // The model remains in the right column — the gate only
      // takes over the left.
      expect(out).toContain('sonnet-4.6');
    });
  });
});
