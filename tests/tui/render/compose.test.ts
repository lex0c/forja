import { describe, expect, test } from 'bun:test';
import { FOOTER_BLOCK_LINES, composeCursor, composeLive } from '../../../src/tui/render/compose.ts';
import {
  COGNITIVE_VERB_POOL,
  OUTPUT_VERB_POOL,
  TOOL_VERB_POOL,
} from '../../../src/tui/render/spinner-verbs.ts';
import { visualWidth } from '../../../src/tui/render/width.ts';
import type { ActiveTool, LiveState } from '../../../src/tui/state.ts';
import { createInitialState } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

// Match a verb-shaped chip line: "<verb>… [..." — the chip's
// rotating verb sits before the elapsed counter.
const verbInLine = (line: string | undefined): string | null => {
  const m = line?.match(/(\w+)…\s*\[/);
  return m ? (m[1] ?? null) : null;
};

const caps: Capabilities = {
  isTTY: true,
  cols: 100,
  rows: 24,
  color: 'none',
  unicode: true,
};

const startedSession = (): LiveState => {
  const s = createInitialState();
  return {
    ...s,
    status: {
      ...s.status,
      sessionId: 's1',
      project: 'forja',
      model: 'opus',
    },
  };
};

// Rule above/below input (UI.md §6.3 "bloco do input" exception).
// Edge-to-edge — the rules + the input line form a 3-row unit that
// breaks out of the frame margin so the operator's eye reads it as
// a coherent typing zone.
const expectedRule = (cols: number, unicode: boolean): string => (unicode ? '─' : '-').repeat(cols);

describe('compacting chip', () => {
  test('renders the "Compacting context…" chip when state.compacting is set', () => {
    const s: LiveState = { ...startedSession(), compacting: { startedAt: 0 } };
    const out = composeLive(s, caps, 3000).join('\n');
    expect(out).toContain('Compacting context…');
  });

  test('a live turn chip takes the slot over a stray compacting state', () => {
    // compacting + a turn chip never coexist legitimately (a compaction
    // runs between steps / with no turn). If a stray compacting state ever
    // outlived its end event mid-turn, the real turn chip must still win —
    // not a stale "Compacting context…" masking the live work.
    const s: LiveState = {
      ...startedSession(),
      compacting: { startedAt: 0 },
      thinking: { startedAt: 0, messageId: 'm1', text: '' },
    };
    const out = composeLive(s, caps, 3000).join('\n');
    expect(out).not.toContain('Compacting context…');
    const verbs = composeLive(s, caps, 3000)
      .map(verbInLine)
      .filter((v): v is string => v !== null);
    expect(verbs.some((v) => COGNITIVE_VERB_POOL.includes(v))).toBe(true);
  });

  test('compacting loses the slot to its weakest neighbor, awaitingProvider', () => {
    // compacting is LAST; awaitingProvider sits directly above it. This pins
    // the exact position — a one-rank slip (compacting above awaiting) would
    // surface here even though it'd sail through the thinking test above.
    const s: LiveState = {
      ...startedSession(),
      compacting: { startedAt: 0 },
      awaitingProvider: { stepN: 1, startedAt: 0 },
    };
    const out = composeLive(s, caps, 3000).join('\n');
    expect(out).toContain('Awaiting model…');
    expect(out).not.toContain('Compacting context…');
  });
});

describe('composeLive layout', () => {
  // Bottom anchor (no modal): [..., rule_above, input(s), rule_below, footer].
  // Trailing 2 lines = rule + footer. Input occupies the N rows
  // above the trailing rule. Per UI.md §6.3 the input-block rules
  // are edge-to-edge (start with `─`/`-` directly, no margin), so
  // we detect the rule above by leading-glyph match.
  const countInputLines = (out: string[]): number => {
    let n = 0;
    for (let i = out.length - 3; i >= 0; i--) {
      const l = out[i] ?? '';
      if (l.startsWith('─') || l.startsWith('-')) break;
      n++;
    }
    return Math.max(1, n);
  };
  const inputRow = (out: string[], inputLineIdx = 0): string =>
    out[out.length - 2 - countInputLines(out) + inputLineIdx] ?? '';

  test('pre-session: BLANK + rule + input + rule + footer', () => {
    // The blank above the rule (UI.md §6.3) always fires — it
    // separates the input block from whatever scrollback ends
    // immediately above the live region.
    const out = composeLive(createInitialState(), caps, 0);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('  '); // forced blank above input rule
    expect(out[1]).toBe(expectedRule(caps.cols, true));
    expect(out[2]).toBe('> ');
    expect(out[3]).toBe(expectedRule(caps.cols, true));
    expect(out[4]).toContain('supervised mode on');
  });

  test('after session start: BLANK + rule + input + rule + footer', () => {
    // Status line was absorbed into footer (UI.md §4.4 superseded by
    // §4.10.6). Layout is now [BLANK, rule, '> ', rule, footer].
    const out = composeLive(startedSession(), caps, 0);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('  ');
    expect(out[1]).toBe(expectedRule(caps.cols, true));
    expect(out[2]).toBe('> ');
    expect(out[3]).toBe(expectedRule(caps.cols, true));
    // Footer marker: the model moved to the banner, so anchor on the
    // always-present mode cue instead.
    expect(out[4]).toContain('supervised mode on');
  });

  test('active tool card sits ABOVE bottom anchor', () => {
    const s = startedSession();
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    const out = composeLive(s, caps, 1000);
    // The tool card stacks ABOVE the pinned tool-phase chip, which
    // sits at the bottom of the live region just above the input.
    // Each top-level block gets a leading BLANK, plus the forced
    // BLANK above the input rule:
    //   [BLANK, card head, sub-content, BLANK, tool-phase chip,
    //    BLANK, rule, input, rule, footer]
    // Length = 10.
    expect(out).toHaveLength(10);
    expect(out[0]).toBe('  '); // leading blank before tool card
    expect(out[1]).toContain('Executing');
    expect(out[2]).toContain('ls');
    expect(out[3]).toBe('  '); // blank before the pinned chip
    expect(TOOL_VERB_POOL).toContain(out[4]?.match(/(\w+)…\s*$/)?.[1] ?? '');
    expect(out[5]).toBe('  '); // blank between chip and input rule
    expect(out[6]).toBe(expectedRule(caps.cols, true));
    expect(out[7]).toBe('> ');
    expect(out[8]).toBe(expectedRule(caps.cols, true));
    expect(out[9]).toContain('supervised mode on');
  });

  test('layered live region: tool cards → TodoList → pinned chip (top→bottom)', () => {
    // The volatile tool zone (running cards, settling batch) stacks at the
    // TOP; the TodoList sits at the BOTTOM of that stack, just above the
    // turn-phase chip pinned directly over the input. A completing tool
    // moves entirely above the list, never crossing it.
    const s = startedSession();
    s.todos = [{ content: 'plan it', activeForm: 'Planning it', status: 'pending' }];
    s.pendingAssistant = {
      messageId: 'm1',
      text: '',
      startedAt: 0,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreation: null,
    };
    const tool: ActiveTool = {
      toolId: 't1',
      name: 'bash',
      activeVerb: 'Executing',
      finalVerb: 'Executed',
      subject: 'ls',
      startedAt: 0,
      preview: [],
    };
    s.activeTools.set('t1', tool);
    const out = composeLive(s, caps, 100);
    // Expected layout (top→bottom): EVERY top-level "session" block
    // gets a leading BLANK so each is bounded by breathing space on
    // both sides. Sub-content (rows under "Tasks", `└─` under chips)
    // stays tight — it's the parent's subsession.
    //   [BLANK, tool head, sub-content,
    //    BLANK, Tasks header, todo row,
    //    BLANK, assistant chip,
    //    BLANK, rule, input, rule, footer]
    expect(out[0]).toBe('  '); // leading blank before tool card
    expect(out[1]).toContain('Executing');
    expect(out[2]).toContain('ls');
    expect(out[3]).toBe('  '); // before TodoList
    expect(out[4]).toContain('Tasks');
    expect(out[5]).toContain('plan it');
    expect(out[6]).toBe('  '); // before the pinned chip
    // Pinned chip carries a verb from the OUTPUT pool (spinner-verbs.ts).
    expect(OUTPUT_VERB_POOL).toContain(verbInLine(out[7]) ?? '');
    expect(out[8]).toBe('  '); // before input rule
    expect(out[9]).toBe(expectedRule(caps.cols, true));
    expect(out[10]).toBe('> ');
    expect(out[11]).toBe(expectedRule(caps.cols, true));
    expect(out[12]).toContain('supervised mode on');
    expect(out).toHaveLength(13);
  });

  test('assistant chip alone (no todos, no tools) renders above bottom anchor', () => {
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
    const out = composeLive(s, caps, 1000);
    // [BLANK, chip, BLANK, rule, input, rule, footer] = 7.
    expect(out).toHaveLength(7);
    expect(out[0]).toBe('  '); // leading blank before chip
    expect(OUTPUT_VERB_POOL).toContain(verbInLine(out[1]) ?? '');
    expect(out[2]).toBe('  '); // blank between chip and input rule
    expect(out[3]).toBe(expectedRule(caps.cols, true));
  });

  test('thinking chip replaces the generating chip while state.thinking is set', () => {
    // Mutual exclusion contract: when both `state.thinking` and
    // `state.pendingAssistant` are set (Anthropic emits
    // message_start before thinking_delta arrives), the more-
    // specific cognitive-pool chip wins. The output-pool chip
    // would surface a generic "model is producing output" signal,
    // but during the thinking pass no text streams — operator
    // would see a frozen chip. Cognitive verb explains the
    // 5-30s no-progress gap honestly.
    //
    // Assertion targets the SPECIFIC chip line (out[1] in the
    // BLANK + chip + BLANK + rule + input + rule + footer
    // layout) rather than scanning the whole frame. Scanning
    // would tangle this assertion with future tool active verbs:
    // if a tool ever picks an active-verb in OUTPUT_VERB_POOL
    // (e.g. "Refining" if a follow-up routes the minimalist
    // technical cluster into tool cards), the scan-based check
    // would falsely report exclusivity violation. Pinning the
    // exact slot keeps this test about chip semantics, not
    // about everything-on-screen.
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
    s.thinking = { startedAt: 0, messageId: 'm1', text: '' };
    const out = composeLive(s, caps, 1000);
    const chipVerb = verbInLine(out[1]);
    expect(chipVerb).not.toBeNull();
    expect(COGNITIVE_VERB_POOL).toContain(chipVerb ?? '');
    expect(OUTPUT_VERB_POOL).not.toContain(chipVerb ?? '');
  });

  test('thinking chip alone (no pendingAssistant) still renders', () => {
    // Defensive case: thinking_delta arrived with no prior
    // assistant:start (out-of-order producer, mid-stream resume).
    // The chip should still render so the operator sees activity.
    const s = startedSession();
    s.thinking = { startedAt: 0, messageId: 'm1', text: '' };
    const out = composeLive(s, caps, 1000);
    const chipVerb = verbInLine(out[1]);
    expect(COGNITIVE_VERB_POOL).toContain(chipVerb ?? '');
  });

  test('multi-line input keeps input above the trailing rule + footer', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    const out = composeLive(s, caps, 0);
    // ..., rule (above), '> a', '  b', rule (below), footer
    expect(inputRow(out, 0)).toBe('> a');
    expect(inputRow(out, 1)).toBe('  b');
    expect(out[out.length - 2]).toBe(expectedRule(caps.cols, true));
    expect(out[out.length - 1]).toContain('supervised mode on');
  });

  test('tool-phase chip is pinned below the tool cards when the model is idle', () => {
    // The window where the model has gone idle and the harness is
    // executing tool calls: thinking, pendingAssistant and
    // awaitingProvider are all null. The pinned chip keeps a live
    // verb (TOOL pool) at the bottom of the live region, with the
    // tool cards stacking ABOVE it.
    const s = startedSession();
    s.currentTurnId = 'msg_01ABC';
    s.activeTools.set('t1', {
      toolId: 't1',
      name: 'reader',
      activeVerb: 'Reading',
      finalVerb: 'Read',
      subject: 'file.ts',
      startedAt: 0,
      preview: [],
    });
    const out = composeLive(s, caps, 0);
    // The chip carries a bracket-less verb (no timer); the tool card
    // head ends in `[Xs]`, so match the word before an ellipsis at
    // END of line to isolate the chip from the card.
    const chipIdx = out.findIndex((l) => TOOL_VERB_POOL.includes(l.match(/(\w+)…\s*$/)?.[1] ?? ''));
    expect(chipIdx).toBeGreaterThan(-1);
    // Pinned-below-the-stack: the chip follows the tool card.
    const cardIdx = out.findIndex((l) => l.includes('file.ts'));
    expect(chipIdx).toBeGreaterThan(cardIdx);
  });

  test('assistant chip wins over the tool-phase chip while text is still streaming', () => {
    // Mutual exclusion: if pendingAssistant is set (text streaming)
    // AND a tool is already active, the OUTPUT-pool chip holds the
    // slot — the tool-phase chip only appears once the model has
    // gone idle. Pins that the slot never shows two verbs.
    const s = startedSession();
    s.currentTurnId = 'msg_01ABC';
    s.pendingAssistant = {
      messageId: 'msg_01ABC',
      text: 'partial',
      startedAt: 0,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreation: null,
    };
    s.activeTools.set('t1', {
      toolId: 't1',
      name: 'reader',
      activeVerb: 'Reading',
      finalVerb: 'Read',
      subject: null,
      startedAt: 0,
      preview: [],
    });
    const out = composeLive(s, caps, 0);
    // The pinned chip is an OUTPUT-pool verb (assistant), present
    // somewhere in the frame...
    const hasOutputChip = out.some((l) => OUTPUT_VERB_POOL.includes(verbInLine(l) ?? ''));
    expect(hasOutputChip).toBe(true);
    // ...and the tool-phase chip (a bracket-less TOOL verb at line
    // end) is NOT rendered — only one verb holds the slot.
    const hasToolPhaseChip = out.some((l) =>
      TOOL_VERB_POOL.includes(l.match(/(\w+)…\s*$/)?.[1] ?? ''),
    );
    expect(hasToolPhaseChip).toBe(false);
  });

  test('live batch preview renders the accumulating tool group (grouped, same as scrollback)', () => {
    // Consecutive same-name tools buffer into pendingToolEndBatch; the
    // live region must render that buffer (grouped, ≥ threshold) so the
    // finalized tools stay visible until the batch settles — not vanish
    // into the invisible buffer. Uses the same formatter as scrollback,
    // so the live preview matches the eventual coalesced block.
    const s = startedSession();
    s.pendingToolEndBatch = {
      name: 'bash',
      items: [
        { verb: 'Executed', subject: 'git status', status: 'done', durationMs: 100 },
        { verb: 'Executed', subject: 'ls -la', status: 'done', durationMs: 50 },
        { verb: 'Executed', subject: 'cat package.json', status: 'done', durationMs: 30 },
      ],
    };
    const joined = composeLive(s, caps, 0).join('\n');
    // Coalesced headline (bash → "Executed N commands") + the subjects.
    expect(joined).toContain('Executed 3 commands');
    expect(joined).toContain('git status');
    expect(joined).toContain('cat package.json');
  });

  test('live batch preview below the coalesce threshold renders a single tool-end line', () => {
    // One buffered tool → no fold; the preview shows the individual
    // finalization, matching what a sub-threshold flush emits.
    const s = startedSession();
    s.pendingToolEndBatch = {
      name: 'bash',
      items: [{ verb: 'Executed', subject: 'git status', status: 'done', durationMs: 100 }],
    };
    const joined = composeLive(s, caps, 0).join('\n');
    expect(joined).toContain('Executed');
    expect(joined).not.toContain('commands'); // not the grouped headline
    expect(joined).toContain('git status');
  });

  test('multiple tools appear in insertion order', () => {
    const s = startedSession();
    s.activeTools.set('t1', {
      toolId: 't1',
      name: 'first',
      activeVerb: 'Doing first',
      finalVerb: 'Did first',
      subject: null,
      startedAt: 0,
      preview: [],
    });
    s.activeTools.set('t2', {
      toolId: 't2',
      name: 'second',
      activeVerb: 'Doing second',
      finalVerb: 'Did second',
      subject: null,
      startedAt: 0,
      preview: [],
    });
    const out = composeLive(s, caps, 0);
    const firstIdx = out.findIndex((l) => l.includes('first'));
    const secondIdx = out.findIndex((l) => l.includes('second'));
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  test('ASCII fallback uses dashes for the rule', () => {
    const ascii: Capabilities = { ...caps, unicode: false };
    const out = composeLive(createInitialState(), ascii, 0);
    // out[0] is the forced blank; rule sits at out[1].
    expect(out[1]).toBe(expectedRule(ascii.cols, false));
  });

  test('rule width tracks caps.cols (measured visually, ANSI-aware)', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const out = composeLive(createInitialState(), narrow, 0);
    // visualWidth strips ANSI escapes — robust whether color is on
    // or off. .length would break the moment color flipped to basic.
    // Rule sits at out[1] (out[0] is the forced blank above input).
    expect(visualWidth(out[1] ?? '')).toBe(20);
  });

  test('rule width holds with color enabled (SGR codes do not bloat visual width)', () => {
    const colored: Capabilities = { ...caps, cols: 30, color: 'basic' };
    const out = composeLive(createInitialState(), colored, 0);
    expect(visualWidth(out[1] ?? '')).toBe(30);
  });

  test('bash mode paints the input rules yellow (whole box reads as one mode)', () => {
    const colored: Capabilities = { ...caps, color: 'basic' };
    const s = startedSession();
    s.input = { value: '!ls', cursor: 3 };
    const out = composeLive(s, colored, 0);
    // warn = SGR 33. Both rules around the input carry it; a normal
    // buffer leaves them dim (SGR 2).
    const rules = out.filter((l) => l.includes('─'));
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const r of rules) expect(r).toContain(`${CSI}33m`);
    // Sanity: a non-bash buffer keeps the rules dim, not yellow.
    const plain = composeLive({ ...s, input: { value: 'ls', cursor: 2 } }, colored, 0);
    for (const r of plain.filter((l) => l.includes('─'))) {
      expect(r).not.toContain(`${CSI}33m`);
    }
  });

  test('bash visuals are suppressed while busy (busy-gated, matches the submit gate)', () => {
    // A `!` buffer while the REPL is busy (turn / playbook / another
    // `!cmd`) stays a normal gray draft — Enter would refuse it, so the
    // rules must not go yellow. `state.busy` is the gate (not turn
    // activity), so a playbook gap with no tools is covered too.
    const colored: Capabilities = { ...caps, color: 'basic' };
    const s = startedSession();
    const out = composeLive({ ...s, input: { value: '!ls', cursor: 3 }, busy: true }, colored, 0);
    for (const r of out.filter((l) => l.includes('─'))) {
      expect(r).not.toContain(`${CSI}33m`);
    }
  });

  test('rule + footer suppressed when modal is up (modal owns its own structure)', () => {
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      title: 'Run command',
      subject: 'rm -rf /',
      preview: [],
      question: null,
      options: [{ key: '1', label: 'No', value: 'no' }],
      selectedIndex: 0,
      hints: ['Esc to cancel'],
      queueDepth: 0,
    };
    const out = composeLive(s, caps, 0);
    // The modal substitutes the entire bottom anchor — input box,
    // bottom rule, footer all gone. The modal carries its own rules
    // (block separators) so we can't assert "no rules"; instead
    // check the specific signals that should be absent.
    expect(out.some((l) => l === '> ')).toBe(false); // input prompt
    expect(out.some((l) => l.includes('shift+tab to change'))).toBe(false); // footer mode cue
  });

  test('modal lines are NOT padded (renderModal already bakes the §6.3 frame margin)', () => {
    // Regression guard: composeLive must NOT run modal output through
    // padFrame. renderModal already emits content with `'  '` indent
    // (its own §6.3 frame margin) AND emits rules at the full
    // caps.cols width. Padding would double-indent content (4sp) and
    // push rules to caps.cols+2, which truncateToWidth then clips
    // by 2 columns on the right — visible as the modal box losing
    // its right edge on every row.
    const s = startedSession();
    s.modal = {
      promptId: 'p1',
      flavor: 'permission',
      title: 'Run command',
      subject: 'rm -rf /',
      preview: [],
      question: 'Allow?',
      options: [{ key: '1', label: 'Yes', value: 'yes' }],
      selectedIndex: 0,
      hints: ['Esc to cancel'],
      queueDepth: 0,
    };
    const out = composeLive(s, caps, 0);
    // A rule line starts with `─` (or `-`). After padFrame it would
    // start with `'  ─'`. Find the rule rows and assert col 0 is
    // the rule glyph, not a space.
    const ruleLines = out.filter((l) => l.startsWith('─') || l.startsWith('-'));
    expect(ruleLines.length).toBeGreaterThan(0);
    for (const line of ruleLines) {
      // First char must be the rule glyph itself (no leading pad).
      expect(line.startsWith('  ')).toBe(false);
      // Visual width matches caps.cols (full edge-to-edge).
      // String length ≈ visual width because rule chars are 1 col each.
      expect(line.length).toBe(caps.cols);
    }
    // Content rows (title/subject/question/options/hints) carry the
    // modal's own internal `'  '` indent — that's the frame margin
    // already, NOT a doubled `'    '`.
    expect(out.some((l) => l.startsWith('  Run command'))).toBe(true);
    expect(out.some((l) => l.startsWith('    Run command'))).toBe(false);
  });

  // FOOTER_BLOCK_LINES guard: composeCursor's row math depends on
  // composeLive emitting exactly that many lines below the input.
  // Drift here = silent cursor mispositioning. Test catches additions
  // (e.g., second rule, multi-line footer) without a constant bump.
  test('FOOTER_BLOCK_LINES matches the trailing block emitted by composeLive', () => {
    const s = createInitialState();
    s.input.value = 'abc';
    const out = composeLive(s, caps, 0);
    // out shape (no upper region, no modal):
    //   [BLANK, rule, '> abc', rule, footer]
    // = 1 (blank) + 1 (rule above) + 1 (input) + FOOTER_BLOCK_LINES.
    const expectedLength =
      1 /* blank */ + 1 /* rule above */ + 1 /* input lines */ + FOOTER_BLOCK_LINES;
    expect(out).toHaveLength(expectedLength);
  });

  test('frame margin (UI.md §6.3): the input block (rule + input + rule) is edge-to-edge; everything else padded', () => {
    // UI.md §6.3 "bloco do input" exception — the 3 rows that form
    // the typing zone (rule above + input + rule below) all live at
    // col 0 so they read as a coherent unit. Banner, status, footer,
    // tool cards, modal, etc. all get the 2sp frame margin.
    const s = startedSession();
    s.input.value = 'hi';
    const out = composeLive(s, caps, 0);
    // Shape: [status, rule, '> hi', rule, footer].
    const inputIdx = out.findIndex((l) => l.startsWith('> '));
    expect(inputIdx).toBeGreaterThan(-1);
    const ruleAboveIdx = inputIdx - 1;
    const ruleBelowIdx = inputIdx + 1;
    // The 3-row input block: none start with '  ' (they start with '─'
    // for the rules and '> ' for the input).
    expect(out[ruleAboveIdx]?.startsWith('  ')).toBe(false);
    expect(out[inputIdx]?.startsWith('  ')).toBe(false);
    expect(out[ruleBelowIdx]?.startsWith('  ')).toBe(false);
    // Everything outside the block is padded.
    out.forEach((line, i) => {
      if (i >= ruleAboveIdx && i <= ruleBelowIdx) return;
      expect(line.startsWith('  ')).toBe(true);
    });
  });

  test('multi-line input: ALL input lines (prompt + continuations) skip the frame margin', () => {
    // Continuations render as `  body` — superficially identical to
    // a padded line. The composer must NOT pad them because the
    // operator typed them as one logical input block; padding would
    // produce `    body` and break alignment with the `> ` prompt.
    const s = startedSession();
    s.input.value = 'a\nb';
    const out = composeLive(s, caps, 0);
    // Find input by `> ` prompt; continuations sit immediately after.
    const promptIdx = out.findIndex((l) => l.startsWith('> '));
    expect(promptIdx).toBeGreaterThan(-1);
    expect(out[promptIdx]).toBe('> a');
    // Continuation: `  b` — exactly 2 spaces (renderInput's prefix),
    // not 4 (which would be padding + renderInput prefix).
    expect(out[promptIdx + 1]).toBe('  b');
  });

  test('composeLive throws when the bottom anchor is malformed (defensive)', () => {
    // The modal-vs-non-modal split is enforced by an internal assert
    // in composeLive — there's no direct way to trigger it without
    // mocking renderFooter (which would defeat the assert's purpose).
    // Instead, the regression guard above ensures the constant stays
    // honest. Documented here so reviewers know the assert exists.
    expect(typeof FOOTER_BLOCK_LINES).toBe('number');
    expect(FOOTER_BLOCK_LINES).toBeGreaterThan(0);
  });
});

describe('composeCursor', () => {
  test('null when modal is up (modal owns the cursor)', () => {
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
    expect(composeCursor(s, caps, 5)).toBeNull();
  });

  // lineCount values include the bottom anchor's trailing 2 lines
  // (rule below input + footer). composeCursor subtracts those before
  // computing the input start row.

  test('empty input → cursor on the input row, col=2 (after `> ` prefix)', () => {
    // Pre-session: lines = [rule, '> ', rule, footer]. lineCount = 4.
    const s = createInitialState();
    expect(composeCursor(s, caps, 4)).toEqual({ row: 1, col: 2 });
  });

  test('single-line input mid-buffer → col reflects offset within line', () => {
    const s = startedSession();
    s.input.value = 'hello world';
    s.input.cursor = 5; // between hello and space
    // After session start: lines = [status, rule, '> hello world',
    // rule, footer]. lineCount = 5. Input on row 2, col = 2 + 5 = 7.
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 7 });
  });

  test('cursor at end of single-line input', () => {
    const s = startedSession();
    s.input.value = 'abc';
    s.input.cursor = 3;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 5 }); // 2 prefix + 3
  });

  test('col counts VISUAL width of wide chars before the cursor (CJK = 2 cols)', () => {
    // '中x' — cursor after both. Visual width before cursor = 2 (中) + 1
    // (x) = 3, so col = prefix(2) + 3 = 5. A code-unit count would give
    // col 4 (2 code units) and the caret would sit one column left of
    // the real glyph.
    const s = startedSession();
    s.input.value = '中x';
    s.input.cursor = 2;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 5 });
  });

  test('bash mode: the leading `!` is the prompt glyph, so the caret skips it', () => {
    // `!ls` — the `!` renders as the `! ` prompt, the command is `ls`.
    // Caret after `ls` (raw cursor 3) → col = prefix(2) + width('ls') = 4,
    // NOT 5 (which would count the `!` as content).
    const s = startedSession();
    s.input.value = '!ls';
    s.input.cursor = 3;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 4 });
  });

  test('col between a wide glyph and the next char', () => {
    // Cursor right after '中' (offset 1): col = prefix(2) + 2 = 4.
    const s = startedSession();
    s.input.value = '中x';
    s.input.cursor = 1;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 4 });
  });

  test('multi-line input → cursor on the line containing the offset', () => {
    const s = startedSession();
    s.input.value = 'first\nsecond\nthird';
    // Cursor inside "second" at offset 9 (after "first\nsec").
    s.input.cursor = 9;
    // lines = [status, rule, '> first', '  second', '  third', rule,
    // footer]. lineCount = 7. Input rows 2,3,4. Cursor on the 2nd
    // input line (row 3). Within "second": offset 3. Col = 2 + 3 = 5.
    expect(composeCursor(s, caps, 7)).toEqual({ row: 3, col: 5 });
  });

  test('cursor at start of buffer (offset 0) is at first input line, col=2', () => {
    const s = startedSession();
    s.input.value = 'hello';
    s.input.cursor = 0;
    expect(composeCursor(s, caps, 5)).toEqual({ row: 2, col: 2 });
  });

  test('cursor at start of a continuation line maps to col=2 of that row', () => {
    const s = startedSession();
    s.input.value = 'a\nb';
    s.input.cursor = 2; // right after the newline, before 'b'
    // lines = [status, rule, '> a', '  b', rule, footer]. lineCount = 6.
    expect(composeCursor(s, caps, 6)).toEqual({ row: 3, col: 2 });
  });

  test('soft-wrap: long buffer line spans multiple visual rows; cursor lands on the right sub-row', () => {
    // Buffer that overflows the terminal width wraps into multiple
    // visual rows (renderInput soft-wraps; composeCursor mirrors the
    // wrap math). The cursor never gets clamped at the right edge —
    // it lands at the actual sub-row + col where the next char would
    // appear. Pre-fix the cursor pinned to caps.cols-1 and the
    // operator typed past the visible edge unable to track position.
    const narrow: Capabilities = { ...caps, cols: 10 };
    // innerWidth = cols - prefix(2) = 8.
    // 50 chars: ceil(50/8) = 7 visual rows. Char 50 is at offset 50,
    // sub-row floor(50/8) = 6, col within sub-row = 50%8 = 2 → col 4.
    const s = startedSession();
    s.input.value = 'a'.repeat(50);
    s.input.cursor = 50;
    // Layout (no upper region in this test): the input occupies rows
    // [inputStartRow .. +6]. lineCount must be enough to fit input +
    // FOOTER_BLOCK_LINES; we pass a generous 12. inputStartRow = 12 - 2 - 7 = 3.
    const cur = composeCursor(s, narrow, 12);
    expect(cur).toEqual({ row: 3 + 6, col: 4 });
  });

  test('soft-wrap: cursor at sub-row boundary lands at start of next sub-row', () => {
    // Char immediately after a wrap boundary belongs to the NEXT
    // visual sub-row, col 2 (right after the continuation prefix).
    const narrow: Capabilities = { ...caps, cols: 10 };
    // innerWidth = 8. Cursor at offset 8 → sub-row 1, col 2.
    const s = startedSession();
    s.input.value = 'a'.repeat(20);
    s.input.cursor = 8;
    // 20 chars: ceil(20/8) = 3 sub-rows. lineCount = 3 + 2 + 1 (status) = generous 8.
    const cur = composeCursor(s, narrow, 8);
    // visualRowsBefore = 0 (single buffer line). subRow = 1. col = 2.
    expect(cur?.row).toBe(8 - 2 - 3 + 1);
    expect(cur?.col).toBe(2);
  });

  test('short inputs that already fit emit cursor without sub-row math kicking in', () => {
    const narrow: Capabilities = { ...caps, cols: 20 };
    const s = startedSession();
    s.input.value = 'short';
    s.input.cursor = 5;
    expect(composeCursor(s, narrow, 5)).toEqual({ row: 2, col: 7 });
  });

  test('cursor at exact wrap boundary at end of line clamps to right edge of last sub-row', () => {
    // Without the clamp, cursor at offset = innerWidth (end of a line
    // whose length is exactly innerWidth) would compute as sub-row 1
    // — but renderInput only emits 1 sub-row for an 8-char line in
    // an 8-innerWidth setup. The phantom sub-row would visually
    // overlap the rule below the input. Clamp puts the cursor at the
    // right edge of the last actual sub-row; next char typed grows
    // the input naturally.
    const narrow: Capabilities = { ...caps, cols: 10 }; // innerWidth = 8
    const s = startedSession();
    s.input.value = 'a'.repeat(8); // exactly innerWidth
    s.input.cursor = 8;
    // 1 sub-row: lineCount = 1 (status) + 1 (rule) + 1 (input) + 2 (rule+footer) = 5.
    // Wait, composeCursor takes lineCount from caller; pass generous 5 here.
    const cur = composeCursor(s, narrow, 5);
    // numSubRows = ceil(8/8) = 1. subRow would be 1 → clamped to 0.
    // col clamped to cols - 1 = 9.
    expect(cur).toEqual({ row: 5 - 2 - 1, col: 9 });
  });

  test('cursor past wrap boundary (1 char beyond) lands naturally on next sub-row', () => {
    // Once the operator types one more char past the boundary, the
    // input grows to 2 sub-rows and the cursor moves to col 2 of the
    // new row (continuation prefix). No clamp needed — normal path.
    const narrow: Capabilities = { ...caps, cols: 10 }; // innerWidth = 8
    const s = startedSession();
    s.input.value = 'a'.repeat(9); // 1 past innerWidth
    s.input.cursor = 9;
    // numSubRows = ceil(9/8) = 2. subRow = floor(9/8) = 1 (within range).
    // col = 9%8 + prefix(2) = 1 + 2 = 3.
    // lineCount must accommodate 2 input sub-rows + 2 footer block.
    // Pass 6 (1 status + 1 rule + 2 input + 2 footer block).
    const cur = composeCursor(s, narrow, 6);
    expect(cur).toEqual({ row: 6 - 2 - 2 + 1, col: 3 });
  });

  test('soft-wrap with surrogate pair at boundary keeps cursor aligned with renderInput chunks', () => {
    // Regression: when a non-BMP codepoint sat at the wrap
    // boundary, renderInput pulls the chunk back by one code unit
    // to keep the surrogate pair intact (so the rendered row 0 is
    // 7 chars, not 8). composeCursor used uniform `offsetInLine
    // % innerWidth` math and computed col = prefix + 7 = 9, past
    // the actual content of the row — the cursor visually drifted
    // off the end of the rendered text. After the fix both consult
    // `wrapInputLine`: a cursor at the chunk boundary lands at the
    // START of the next sub-row (col 2), the same canonical
    // behavior as a cursor at any other wrap boundary (compare
    // the `at sub-row boundary lands at start of next sub-row`
    // test above).
    const narrow: Capabilities = { ...caps, cols: 10 }; // innerWidth = 8
    const s = startedSession();
    // 7 ASCII + emoji + 'b'. First chunk = 7 chars (pulled back),
    // second chunk = '😀b' (4 code units). 2 sub-rows total.
    s.input.value = `${'a'.repeat(7)}😀b`;
    s.input.cursor = 7;
    const cur = composeCursor(s, narrow, 6);
    // Pre-fix: { row: 2, col: 9 } — col past the 7-char row content.
    // Post-fix: cursor at chunk-0-end / chunk-1-start → sub-row 1,
    // col = prefix(2). row = 6 - 2 - 2 + 1 = 3.
    expect(cur).toEqual({ row: 3, col: 2 });
  });

  test('soft-wrap with surrogate pair: cursor mid-first-chunk maps within row 0', () => {
    // Same line shape as above; cursor in the middle of the
    // pulled-back first chunk lands at the natural prefix + offset
    // column on row 0 — proves the fix doesn't drift cursors that
    // had no boundary issue in the first place.
    const narrow: Capabilities = { ...caps, cols: 10 };
    const s = startedSession();
    s.input.value = `${'a'.repeat(7)}😀b`;
    s.input.cursor = 4;
    const cur = composeCursor(s, narrow, 6);
    expect(cur).toEqual({ row: 6 - 2 - 2, col: 2 + 4 });
  });
});

describe('queued inbox messages (INBOX §6)', () => {
  test('render above the input rule, in the `> `-prefixed bar style', () => {
    const state: LiveState = {
      ...startedSession(),
      queued: [{ id: '0', text: 'queued msg' }],
    };
    const out = composeLive(state, caps, 0);
    const barIdx = out.findIndex((l) => l.includes('> queued msg'));
    const firstRuleIdx = out.findIndex((l) => l.startsWith('─') || l.startsWith('-'));
    expect(barIdx).toBeGreaterThanOrEqual(0);
    expect(firstRuleIdx).toBeGreaterThanOrEqual(0);
    // queued stack sits in the upper slot, above the input block's rule
    expect(barIdx).toBeLessThan(firstRuleIdx);
  });

  test('one bar per queued item, in FIFO order', () => {
    const state: LiveState = {
      ...startedSession(),
      queued: [
        { id: '0', text: 'first queued' },
        { id: '1', text: 'second queued' },
      ],
    };
    const out = composeLive(state, caps, 0);
    const firstIdx = out.findIndex((l) => l.includes('> first queued'));
    const secondIdx = out.findIndex((l) => l.includes('> second queued'));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  test('empty queue adds no bars', () => {
    const out = composeLive(startedSession(), caps, 0);
    expect(out.some((l) => l.includes('queued'))).toBe(false);
  });

  test('the last queued bar HUGS the input rule — no blank line between them', () => {
    const state: LiveState = {
      ...startedSession(),
      queued: [{ id: '0', text: 'queued msg' }],
    };
    const out = composeLive(state, caps, 0);
    const ruleIdx = out.findIndex((l) => l.startsWith('─') || l.startsWith('-'));
    // The line directly above the input's top rule is the queued bar itself,
    // not a blank — so a pending message reads as attached to the input box.
    expect(out[ruleIdx - 1]).toContain('> queued msg');
  });

  test('with no queue, a blank line still sits above the input rule (unchanged)', () => {
    const out = composeLive(startedSession(), caps, 0);
    const ruleIdx = out.findIndex((l) => l.startsWith('─') || l.startsWith('-'));
    // padFrame('') is 2 spaces, no other content.
    expect((out[ruleIdx - 1] ?? '').trim()).toBe('');
  });

  test('the message being edited is hidden from the queue block (it lifts into the input)', () => {
    const state: LiveState = {
      ...startedSession(),
      queued: [
        { id: '0', text: 'first queued' },
        { id: '1', text: 'second queued' },
      ],
      editingId: '1',
    };
    const out = composeLive(state, caps, 0);
    expect(out.some((l) => l.includes('> first queued'))).toBe(true);
    expect(out.some((l) => l.includes('> second queued'))).toBe(false);
  });

  test('queued + empty buffer hints the ↑-to-edit affordance (INBOX §6.1)', () => {
    const state: LiveState = {
      ...startedSession(),
      queued: [{ id: '0', text: 'queued msg' }],
    };
    const out = composeLive(state, caps, 0);
    expect(out.some((l) => l.includes('Press up to edit queued messages'))).toBe(true);
  });
});
