import { describe, expect, test } from 'bun:test';
import { composeCursor, composeLive } from '../../../src/tui/render/compose.ts';
import { type LiveState, createInitialState } from '../../../src/tui/state.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = { isTTY: true, cols: 100, rows: 24, color: 'none', unicode: true };

const withClarify = (): LiveState => {
  const s = createInitialState();
  return {
    ...s,
    status: { ...s.status, sessionId: 's1', project: 'forja', model: 'opus' },
    clarifyModal: {
      promptId: 'c1',
      flavor: 'clarify',
      questions: [
        {
          question: 'which validateOrder?',
          why: 'blast differs',
          options: [
            { id: 'a', label: 'orders.ts' },
            { id: 'b', label: 'checkout.ts' },
          ],
          selectedIndex: 0,
        },
      ],
      activeQuestion: 0,
      hints: ['Enter confirm', 'Esc skip'],
      queueDepth: 0,
    },
  };
};

describe('composeLive: clarify form-modal', () => {
  test('renders the clarify modal (title + question + options) in the bottom slot', () => {
    const text = composeLive(withClarify(), caps, 0).join('\n');
    expect(text).toContain('Clarify');
    expect(text).toContain('which validateOrder?');
    expect(text).toContain('a. orders.ts');
    expect(text).toContain('Enter confirm · Esc skip');
  });

  test('hides the cursor while the clarify modal is up', () => {
    expect(composeCursor(withClarify(), caps, 10)).toBeNull();
  });
});
