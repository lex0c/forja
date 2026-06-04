import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/tui/bus.ts';
import type { UIEvent } from '../../src/tui/events.ts';
import { createFocusStack } from '../../src/tui/focus-stack.ts';
import type { KeyEvent, KeyName } from '../../src/tui/keys.ts';
import { createModalManager } from '../../src/tui/modal-manager.ts';

const key = (name: KeyName, mods: { shift?: boolean } = {}): KeyEvent => ({
  kind: 'key',
  name,
  ctrl: false,
  alt: false,
  shift: mods.shift ?? false,
  raw: '',
});

const make = () => {
  const bus = createBus();
  const fs = createFocusStack();
  const events: UIEvent[] = [];
  bus.onAny((e) => events.push(e));
  let counter = 0;
  const manager = createModalManager({
    bus,
    focusStack: fs,
    now: () => 1000,
    newPromptId: () => `p-${++counter}`,
  });
  return { fs, manager, events };
};

const OPTS = [
  { id: 'a', label: 'orders.ts' },
  { id: 'b', label: 'checkout.ts' },
];

describe('askClarify', () => {
  test('Enter resolves the option under the cursor (starts at 0)', async () => {
    const { fs, manager } = make();
    const p = manager.askClarify({ question: 'q', why: null, options: OPTS });
    fs.dispatch(key('enter'));
    expect(await p).toEqual({ outcome: 'resolved', chosen_option_id: 'a' });
  });

  test('↓ then Enter resolves the next option', async () => {
    const { fs, manager } = make();
    const p = manager.askClarify({ question: 'q', why: null, options: OPTS });
    fs.dispatch(key('down'));
    fs.dispatch(key('enter'));
    expect(await p).toEqual({ outcome: 'resolved', chosen_option_id: 'b' });
  });

  test('a hotkey (the option id char) resolves that option directly', async () => {
    const { fs, manager } = make();
    const p = manager.askClarify({ question: 'q', why: null, options: OPTS });
    fs.dispatch({ kind: 'char', char: 'b', ctrl: false, alt: false, raw: 'b' });
    expect(await p).toEqual({ outcome: 'resolved', chosen_option_id: 'b' });
  });

  test('Esc resolves as skipped (the tool maps the skip to options[0])', async () => {
    const { fs, manager } = make();
    const p = manager.askClarify({ question: 'q', why: null, options: OPTS });
    fs.dispatch(key('escape'));
    expect(await p).toEqual({ outcome: 'skipped' });
  });

  test("an option whose id is literally 'cancel' resolves as a pick, not a skip", async () => {
    // 'cancel' is the machine's skip sentinel; option values are prefixed
    // so a real model-supplied id can't be misread as a skip.
    const { fs, manager } = make();
    const p = manager.askClarify({
      question: 'q',
      why: null,
      options: [
        { id: 'proceed', label: 'Proceed' },
        { id: 'cancel', label: 'Cancel the migration' },
      ],
    });
    fs.dispatch(key('down')); // cursor → the 'cancel'-id option
    fs.dispatch(key('enter'));
    expect(await p).toEqual({ outcome: 'resolved', chosen_option_id: 'cancel' });
  });

  test('emits a clarify:ask event carrying the question + options', async () => {
    const { fs, manager, events } = make();
    const p = manager.askClarify({ question: 'which?', why: 'stakes', options: OPTS });
    const ask = events.find((e) => e.type === 'clarify:ask');
    expect(ask).toBeDefined();
    if (ask?.type === 'clarify:ask') {
      expect(ask.question).toBe('which?');
      expect(ask.why).toBe('stakes');
      expect(ask.options).toHaveLength(2);
    }
    fs.dispatch(key('escape'));
    await p;
  });
});
