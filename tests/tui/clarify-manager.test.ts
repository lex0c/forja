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

  test('the generated hotkey (not the id) resolves the option', async () => {
    // Hotkeys are generated single chars by index (a → 0, b → 1), NOT
    // the model id — so even descriptive multi-char ids get a usable
    // hotkey, and the char resolves the id that rode through as value.
    const { fs, manager } = make();
    const p = manager.askClarify({
      question: 'q',
      why: null,
      options: [
        { id: 'orders', label: 'orders.ts' },
        { id: 'checkout', label: 'checkout.ts' },
      ],
    });
    fs.dispatch({ kind: 'char', char: 'b', ctrl: false, alt: false, raw: 'b' });
    expect(await p).toEqual({ outcome: 'resolved', chosen_option_id: 'checkout' });
  });

  test('an option whose id is a reserved key name does not hijack navigation', async () => {
    // Regression: an id like 'down' must NOT become the ↓ hotkey, or
    // pressing ↓ to move the cursor would instantly select it. Generated
    // hotkeys (a, b) are kind:'char', so ↓ (kind:'key') falls through to
    // the nav handler.
    const { fs, manager } = make();
    const p = manager.askClarify({
      question: 'q',
      why: null,
      options: [
        { id: 'down', label: 'Scale down' },
        { id: 'up', label: 'Scale up' },
      ],
    });
    fs.dispatch(key('down')); // navigates to option 1 — does NOT select 'down'
    fs.dispatch(key('enter'));
    expect(await p).toEqual({ outcome: 'resolved', chosen_option_id: 'up' });
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

  test('emits a clarify:ask event carrying the question + generated-hotkey options', async () => {
    const { fs, manager, events } = make();
    const p = manager.askClarify({ question: 'which?', why: 'stakes', options: OPTS });
    const ask = events.find((e) => e.type === 'clarify:ask');
    expect(ask).toBeDefined();
    if (ask?.type === 'clarify:ask') {
      expect(ask.question).toBe('which?');
      expect(ask.why).toBe('stakes');
      expect(ask.options).toHaveLength(2);
      // The event carries the generated hotkeys (so the reducer renders
      // the same key that resolves), with the model id preserved.
      expect(ask.options[0]).toEqual({ id: 'a', label: 'orders.ts', key: 'a' });
      expect(ask.options[1]).toEqual({ id: 'b', label: 'checkout.ts', key: 'b' });
    }
    fs.dispatch(key('escape'));
    await p;
  });
});
