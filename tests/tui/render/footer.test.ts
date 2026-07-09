import { describe, expect, test } from 'bun:test';
import {
  hasFooterPathRow,
  renderFooter,
  renderFooterPath,
} from '../../../src/tui/render/footer.ts';
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
      sessionTotalCostUsd: 0.012,
      ...overrides,
    },
  };
};

describe('renderFooter', () => {
  test('isolation-profile chip shows when a profile is active', () => {
    const out = renderFooter(startedSession({ profile: 'dev' }), caps);
    expect(out).not.toBeNull();
    expect(out).toContain('profile:dev');
  });

  test('no profile chip on the default namespace', () => {
    const out = renderFooter(startedSession({ profile: null }), caps);
    expect(out).not.toBeNull();
    expect(out).not.toContain('profile:');
  });

  test('surfaces a `relay on` chip while serving (live-cluster signal)', () => {
    const out = renderFooter(startedSession({ relayMode: true, relayAlias: 'billing' }), caps);
    expect(out).not.toBeNull();
    expect(out).toContain('relay on');
  });

  test('no relay chip when relay mode is off', () => {
    const out = renderFooter(startedSession({ relayMode: false }), caps);
    expect(out).not.toBeNull();
    expect(out).not.toContain('relay on');
  });

  test('relay-on is painted success (green) like the other live chips', () => {
    const colored: Capabilities = { ...caps, color: 'basic' };
    const out = renderFooter(startedSession({ relayMode: true, relayAlias: 'billing' }), colored);
    expect(out).toContain(`${CSI}32mrelay on${CSI}0m`);
  });

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

  test('idle state: operation-mode cue left, model + cost right (step chip removed)', () => {
    const out = renderFooter(startedSession(), caps);
    expect(out).not.toBeNull();
    // The operation-mode cue replaced the old `? for help` hint
    // (UI.md §4.10.6). Default posture is supervised.
    expect(out).toContain('supervised mode on (shift+tab to change)');
    expect(out).not.toContain('? for help');
    // Newline hint pairs with the input editor's backslash
    // continuation (UI.md §5.4).
    expect(out).toContain('\\+Enter newline');
    // Model id is a footer chip — always-visible identity (the banner
    // scrolls out of view), so the operator can confirm which model answers.
    expect(out).toContain('sonnet-4.6');
    // Current-turn cost surfaces beside the token count (2-decimal).
    expect(out).toContain('$0.01');
    // The step counter stays out of the footer — low-signal next to
    // the tokens / context-used chips.
    expect(out).not.toContain('3/50');
    // Interrupt cue absent when nothing is running.
    expect(out).not.toContain('esc to interrupt');
  });

  test('the effort level is NOT surfaced in the footer (chip removed)', () => {
    const out = renderFooter(startedSession({ effort: 'high' }), caps) ?? '';
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
    s.thinking = { startedAt: 0, messageId: 'm1', text: '' };
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

  describe('REPL-cumulative cost chip', () => {
    test('surfaces as a 2-decimal `$X.XX` chip', () => {
      const out = renderFooter(startedSession({ sessionTotalCostUsd: 12.34 }), caps) ?? '';
      expect(out).toContain('$12.34');
    });

    test('renders right after the token count', () => {
      const out =
        renderFooter(
          startedSession({ sessionTotalTokens: 12_400, sessionTotalCostUsd: 0.5 }),
          caps,
        ) ?? '';
      expect(out.indexOf('12k tokens')).toBeLessThan(out.indexOf('$0.50'));
    });

    test('zero cost drops the chip entirely', () => {
      const out = renderFooter(startedSession({ sessionTotalCostUsd: 0 }), caps) ?? '';
      expect(out).not.toContain('$');
    });

    test('sub-cent total still shows a `$0.00` chip (ran ≠ nothing ran)', () => {
      const out = renderFooter(startedSession({ sessionTotalCostUsd: 0.002 }), caps) ?? '';
      expect(out).toContain('$0.00');
    });
  });

  describe('context-used chip (`N% context used`, >= 90% only)', () => {
    test('surfaces at >= 97% occupancy', () => {
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 195_000 }),
          caps,
        ) ?? '';
      expect(out).toContain('97% context used'); // 195k/200k = 97.5% → floor 97
    });

    test('renders after the cost chip (trailing chip)', () => {
      const out =
        renderFooter(
          startedSession({
            contextWindow: 200_000,
            lastTurnContextTokens: 199_000,
            sessionTotalCostUsd: 0.5,
          }),
          caps,
        ) ?? '';
      expect(out.indexOf('$0.50')).toBeLessThan(out.indexOf('% context used'));
    });

    test('surfaces in the 90%–96% band (early warn stage)', () => {
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 180_000 }),
          caps,
        ) ?? ''; // 90% — the band's lower edge
      expect(out).toContain('90% context used');
    });

    test('suppressed below 90%', () => {
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 178_000 }),
          caps,
        ) ?? ''; // 89%
      expect(out).not.toContain('context used');
    });

    test('suppressed while the context is stale (post-compaction, pre-remeasure)', () => {
      const out =
        renderFooter(
          startedSession({
            contextWindow: 200_000,
            lastTurnContextTokens: 199_000,
            contextStale: true,
          }),
          caps,
        ) ?? '';
      expect(out).not.toContain('context used');
    });

    test('suppressed pre-boot (no context window) and before the first measured turn', () => {
      expect(renderFooter(startedSession({ contextWindow: 0 }), caps) ?? '').not.toContain(
        'context used',
      );
      expect(
        renderFooter(startedSession({ contextWindow: 200_000, lastTurnContextTokens: 0 }), caps) ??
          '',
      ).not.toContain('context used');
    });

    test('display never exceeds 100% even if the turn over-fills the window', () => {
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 210_000 }),
          caps,
        ) ?? '';
      expect(out).toContain('100% context used');
      expect(out).not.toContain('105% context used');
    });

    test('painted error (red) at >= 97% when color is enabled', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 199_000 }),
          colored,
        ) ?? '';
      // error = SGR 31 — near-overflow is the strongest passive footer signal.
      expect(out).toContain(`${CSI}31m99% context used${CSI}0m`);
    });

    test('painted warn (yellow) in the 90%–96% band when color is enabled', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const out =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 192_000 }),
          colored,
        ) ?? ''; // 96%
      // warn = SGR 33 — the early heads-up before the red near-overflow alarm.
      expect(out).toContain(`${CSI}33m96% context used${CSI}0m`);
    });

    test('the 96%→97% boundary escalates warn (yellow) to error (red)', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const at96 =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 193_000 }),
          colored,
        ) ?? ''; // 96.5% → floor 96
      const at97 =
        renderFooter(
          startedSession({ contextWindow: 200_000, lastTurnContextTokens: 194_000 }),
          colored,
        ) ?? ''; // 97%
      expect(at96).toContain(`${CSI}33m96% context used${CSI}0m`);
      expect(at97).toContain(`${CSI}31m97% context used${CSI}0m`);
    });
  });

  describe('in-flight bg processes chip (ORCHESTRATION §3B)', () => {
    test('surfaces a `N bash bg` chip counting running bg processes', () => {
      const s = startedSession();
      s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
      s.bgProcesses.set('p2', { processId: 'p2', command: 'pytest' });
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('2 bash bg');
    });

    test('no bg processes drops the chip entirely', () => {
      const out = renderFooter(startedSession(), caps) ?? '';
      expect(out).not.toContain('bash bg');
    });

    test('leads the right cluster — bg reads before the static model chip', () => {
      const s = startedSession();
      s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
      const out = renderFooter(s, caps) ?? '';
      expect(out.indexOf('1 bash bg')).toBeLessThan(out.indexOf('sonnet-4.6'));
    });

    test('painted success (green) — distinct from the dim cumulative chips', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const s = startedSession();
      s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
      const out = renderFooter(s, colored) ?? '';
      expect(out).toContain(`${CSI}32m1 bash bg${CSI}0m`);
    });
  });

  describe('pending reminders chip (`N reminders`)', () => {
    test('surfaces a `N reminders` chip from the pending count', () => {
      const s = startedSession();
      s.reminderCount = 2;
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('2 reminders');
    });

    test('zero pending drops the chip entirely', () => {
      const out = renderFooter(startedSession(), caps) ?? '';
      expect(out).not.toContain('reminders');
    });

    test('renders BEFORE the bash bg chip', () => {
      const s = startedSession();
      s.reminderCount = 1;
      s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
      const out = renderFooter(s, caps) ?? '';
      expect(out.indexOf('1 reminders')).toBeLessThan(out.indexOf('1 bash bg'));
    });

    test('painted success (green) like the other live chips', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const s = startedSession();
      s.reminderCount = 3;
      const out = renderFooter(s, colored) ?? '';
      expect(out).toContain(`${CSI}32m3 reminders${CSI}0m`);
    });
  });

  describe('awaiting-reply chip (`N awaiting reply`)', () => {
    test('surfaces an `N awaiting reply` chip from the owed count', () => {
      const s = startedSession();
      s.awaitingReplyCount = 2;
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('2 awaiting reply');
    });

    test('zero owed drops the chip entirely', () => {
      const out = renderFooter(startedSession(), caps) ?? '';
      expect(out).not.toContain('awaiting reply');
    });

    test('painted warn (yellow), not the live-cluster green — an action owed', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const s = startedSession();
      s.awaitingReplyCount = 1;
      const out = renderFooter(s, colored) ?? '';
      expect(out).toContain(`${CSI}33m1 awaiting reply${CSI}0m`);
    });

    test('shows even with relay off — you can still owe replies after /relay off', () => {
      const s = startedSession({ relayMode: false });
      s.awaitingReplyCount = 1;
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('1 awaiting reply');
    });
  });

  test('memoryCount does NOT surface in the footer (chip removed)', () => {
    const out = renderFooter(startedSession({ memoryCount: 7 }), caps) ?? '';
    expect(out).not.toContain('mem ');
  });

  describe('session-total tokens chip', () => {
    test('renders compact `Nk tokens` right after the model chip', () => {
      const out = renderFooter(startedSession({ sessionTotalTokens: 12_400 }), caps) ?? '';
      expect(out).toContain('12k tokens');
      // Order: model · tokens. Tokens come right after model so the
      // operator's load cluster reads identity → weight.
      expect(out.indexOf('sonnet-4.6')).toBeLessThan(out.indexOf('12k tokens'));
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

  describe('cache tokens chip', () => {
    test('splits cache out: `N tokens` is non-cache, `N cached` is the cache subset', () => {
      // Grand total 12.4k, of which 4k is cache → non-cache compute 8.4k.
      const out =
        renderFooter(
          startedSession({ sessionTotalTokens: 12_400, sessionCacheTokens: 4000 }),
          caps,
        ) ?? '';
      expect(out).toContain('8.4k tokens');
      expect(out).toContain('4k cached');
      // The two chips are disjoint and sum to the grand total; the
      // grand-total figure itself is never printed.
      expect(out).not.toContain('12k tokens');
      // Cache chip sits right after the token chip.
      expect(out.indexOf('8.4k tokens')).toBeLessThan(out.indexOf('4k cached'));
    });

    test('zero cache drops the cache chip but keeps the token chip', () => {
      const out =
        renderFooter(startedSession({ sessionTotalTokens: 5000, sessionCacheTokens: 0 }), caps) ??
        '';
      expect(out).toContain('5k tokens');
      expect(out).not.toContain('cached');
    });

    test('all-cache turn drops the token chip and keeps only the cache chip', () => {
      // sessionTotalTokens == sessionCacheTokens → non-cache is 0.
      const out =
        renderFooter(
          startedSession({ sessionTotalTokens: 3000, sessionCacheTokens: 3000 }),
          caps,
        ) ?? '';
      expect(out).toContain('3k cached');
      expect(out).not.toContain('3k tokens');
    });
  });

  describe('"always visible" lead chips before session:start', () => {
    test('model + tokens render even with sessionId null', () => {
      // Simulates the boot window: banner landed (model stamped),
      // tokens accumulated via assistant:end, but the user hasn't
      // submitted yet so sessionId is still null.
      const s = createInitialState();
      s.status = {
        ...s.status,
        model: 'anthropic/claude-opus-4-7',
        sessionTotalTokens: 12_400,
      };
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('anthropic/claude-opus-4-7');
      expect(out).toContain('12k tokens');
    });
  });

  describe('in-flight subagents chip (`N subagents`)', () => {
    const addSubagent = (s: LiveState, id: string): void => {
      s.subagents.set(id, {
        subagentId: id,
        name: 'explore',
        goal: 'find auth',
        progress: '',
        startedAt: 0,
        liveCostUsd: 0,
        currentTool: '',
        toolCounts: new Map(),
        toolTotal: 0,
      });
    };

    test('surfaces a `N subagents` chip counting in-flight subagents (distinct from bg)', () => {
      const s = startedSession();
      addSubagent(s, 'child-1');
      addSubagent(s, 'child-2');
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('2 subagents');
    });

    test('no subagents drops the subagents chip', () => {
      const out = renderFooter(startedSession(), caps) ?? '';
      expect(out).not.toContain('subagents');
    });

    test('bg and subagents chips are independent sources (both can show)', () => {
      const s = startedSession();
      s.bgProcesses.set('p1', { processId: 'p1', command: 'npm run dev' });
      addSubagent(s, 'child-1');
      const out = renderFooter(s, caps) ?? '';
      expect(out).toContain('1 bash bg');
      expect(out).toContain('1 subagents');
    });

    test('painted success (green)', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const s = startedSession();
      addSubagent(s, 'child-1');
      const out = renderFooter(s, colored) ?? '';
      expect(out).toContain(`${CSI}32m1 subagents${CSI}0m`);
    });
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

    test('slash + soft-aborted run swaps the cue to "esc again to force"', () => {
      // The slash branch has its own copy of the interrupt-cue logic;
      // this locks that it makes the softInterrupted flip identically
      // to the mode-cue branch (the shared interruptCue helper). No
      // prior test covered slash open AND softInterrupted together.
      const s = startedSession();
      s.slash = { suggestions: [{ name: 'a', description: '' }], selectedIdx: 0 };
      s.busy = true;
      s.softInterrupted = true;
      const out = renderFooter(s, caps);
      expect(out).toContain('esc again to force');
      expect(out).not.toContain('esc to interrupt');
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
      // Edge case: gate armed AND a turn is running. Producer
      // shouldn't normally arm during a run (handleIdleInterrupt
      // gates on `running`), but defense in depth — if both flags
      // are true, the exit cue wins because it's a 1-tap-to-exit
      // hazard and the operator's next keystroke is the most
      // load-bearing. `busy` is what makes this a REAL precedence
      // test: without it isRunning is false and the interrupt cue
      // would never show regardless of exitArmed, so the assertion
      // below would pass vacuously.
      const s = startedSession();
      s.exitArmed = { at: 1000 };
      s.busy = true;
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

  describe('cwd path row (second footer line)', () => {
    test('renders the working directory once cwd is seeded', () => {
      const out = renderFooterPath(startedSession({ cwd: '/home/lex/work/forja', home: '' }), caps);
      expect(out).not.toBeNull();
      expect(out).toContain('/home/lex/work/forja');
      // Frame-margin indented like the rest of the padded live region.
      expect(out?.startsWith('  ')).toBe(true);
    });

    test('collapses $HOME to ~ (same treatment as the banner cwd)', () => {
      const out = renderFooterPath(
        startedSession({ cwd: '/home/lex/work/forja', home: '/home/lex' }),
        caps,
      );
      expect(out).toContain('~/work/forja');
      expect(out).not.toContain('/home/lex/work/forja');
    });

    test('elides the noisy middle of a deep mount path', () => {
      // A removable-drive mount buries the signal (where + repo) under a
      // long uuid; shortenCwd keeps the head + last two components.
      const deep = '/run/media/728c6e4f-56b6-4bf8-903c-838aeaaf2690/Workspaces/forja';
      const out = renderFooterPath(startedSession({ cwd: deep, home: '' }), caps);
      expect(out).toContain('/run/media');
      expect(out).toContain('Workspaces/forja');
      expect(out).toContain('…');
    });

    test('painted secondary (grey) when color enabled — matches the banner cwd', () => {
      const colored: Capabilities = { ...caps, color: 'basic' };
      const out = renderFooterPath(startedSession({ cwd: '/x/forja', home: '' }), colored);
      expect(out).toContain(`${CSI}90m`);
    });

    test('suppressed before the banner seeds cwd (null → no row)', () => {
      expect(renderFooterPath(createInitialState(), caps)).toBeNull();
      expect(hasFooterPathRow(createInitialState())).toBe(false);
    });

    test('suppressed while a modal owns the bottom slot', () => {
      const s = startedSession({ cwd: '/x/forja', home: '' });
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
      expect(renderFooterPath(s, caps)).toBeNull();
      expect(hasFooterPathRow(s)).toBe(false);
    });

    test('suppressed in bash mode (footer collapses to the shell indicator)', () => {
      const s = startedSession({ cwd: '/x/forja', home: '' });
      const bash = { ...s, input: { value: '!ls', cursor: 3 } };
      expect(renderFooterPath(bash, caps)).toBeNull();
      expect(hasFooterPathRow(bash)).toBe(false);
    });

    test('hasFooterPathRow tracks renderFooterPath presence (cursor-math contract)', () => {
      const present = startedSession({ cwd: '/x/forja', home: '' });
      expect(hasFooterPathRow(present)).toBe(true);
      expect(renderFooterPath(present, caps)).not.toBeNull();
    });
  });
});
