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
    { id: 'a', label: 'orders.ts' },
    { id: 'b', label: 'checkout.ts' },
  ],
});

describe('reducer: clarify modal', () => {
  test('clarify:ask raises clarifyModal in its own slot, modal stays null', () => {
    const r = applyEvent(createInitialState(), ask());
    expect(r.state.modal).toBeNull();
    expect(r.state.clarifyModal?.promptId).toBe('c1');
    expect(r.state.clarifyModal?.questions).toHaveLength(1);
    expect(r.state.clarifyModal?.questions[0]?.question).toBe('which validateOrder?');
    expect(r.state.clarifyModal?.questions[0]?.why).toBe('blast differs');
    expect(r.state.clarifyModal?.questions[0]?.options).toHaveLength(2);
    expect(r.state.clarifyModal?.questions[0]?.selectedIndex).toBe(0);
  });

  test('modal:select moves the active question cursor, clamped to its options', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:select', ts: 2, promptId: 'c1', selectedIndex: 1 }).state;
    expect(s.clarifyModal?.questions[0]?.selectedIndex).toBe(1);
    s = applyEvent(s, { type: 'modal:select', ts: 3, promptId: 'c1', selectedIndex: 9 }).state;
    expect(s.clarifyModal?.questions[0]?.selectedIndex).toBe(1); // clamped to max
  });

  test('modal:select with a mismatched promptId is ignored', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:select', ts: 2, promptId: 'other', selectedIndex: 1 }).state;
    expect(s.clarifyModal?.questions[0]?.selectedIndex).toBe(0);
  });

  test('modal:queue-depth updates the clarify modal queue depth', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:queue-depth', ts: 2, promptId: 'c1', depth: 2 }).state;
    expect(s.clarifyModal?.queueDepth).toBe(2);
  });

  test('modal:answer clears the clarify modal on a matching promptId', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:answer', ts: 2, promptId: 'c1', decision: 'a' }).state;
    expect(s.clarifyModal).toBeNull();
  });

  test('modal:answer for a different promptId leaves the clarify modal up', () => {
    let s = applyEvent(createInitialState(), ask()).state;
    s = applyEvent(s, { type: 'modal:answer', ts: 2, promptId: 'nope', decision: 'a' }).state;
    expect(s.clarifyModal).not.toBeNull();
  });
});
