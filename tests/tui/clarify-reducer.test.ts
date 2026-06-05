import { describe, expect, test } from 'bun:test';
import type { ClarifyAskEvent } from '../../src/tui/events.ts';
import { applyEvent, createInitialState } from '../../src/tui/state.ts';

const ask = (): ClarifyAskEvent => ({
  type: 'clarify:ask',
  ts: 1,
  promptId: 'c1',
  question: 'which validateOrder?',
  why: 'blast differs',
  options: [
    { id: 'orders', label: 'orders.ts', key: 'a' },
    { id: 'checkout', label: 'checkout.ts', key: 'b' },
  ],
});

// clarify is a confirm flavor — `clarify:ask` raises a ConfirmState in
// the shared `modal` slot, so it reuses the generic modal:* machinery.
describe('reducer: clarify as a confirm flavor', () => {
  test('clarify:ask raises a modal flavor=clarify (question, why→subject, id-keyed options)', () => {
    const r = applyEvent(createInitialState(), ask());
    expect(r.state.modal?.flavor).toBe('clarify');
    expect(r.state.modal?.promptId).toBe('c1');
    expect(r.state.modal?.title).toBe('Clarify');
    expect(r.state.modal?.question).toBe('which validateOrder?');
    expect(r.state.modal?.subject).toBe('blast differs'); // why_it_matters
    expect(r.state.modal?.options).toHaveLength(2);
    expect(r.state.modal?.options[0]?.key).toBe('a'); // generated hotkey from the event
    expect(r.state.modal?.options[0]?.value).toBe('orders'); // model id rides the value
    expect(r.state.modal?.selectedIndex).toBe(0);
  });

  test('modal:select moves the cursor, clamped to the option count', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:select', ts: 2, promptId: 'c1', selectedIndex: 1 }).state;
    expect(s.modal?.selectedIndex).toBe(1);
    s = applyEvent(s, { type: 'modal:select', ts: 3, promptId: 'c1', selectedIndex: 9 }).state;
    expect(s.modal?.selectedIndex).toBe(1); // clamped to max
  });

  test('modal:queue-depth updates the queue depth', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:queue-depth', ts: 2, promptId: 'c1', depth: 2 }).state;
    expect(s.modal?.queueDepth).toBe(2);
  });

  test('modal:answer clears the modal on a matching promptId', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:answer', ts: 2, promptId: 'c1', decision: 'a' }).state;
    expect(s.modal).toBeNull();
  });

  test('a mismatched promptId leaves the modal up', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:answer', ts: 2, promptId: 'nope', decision: 'a' }).state;
    expect(s.modal).not.toBeNull();
  });
});
