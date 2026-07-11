import { describe, expect, test } from 'bun:test';
import { composeCursor, composeLive } from '../../../src/tui/render/compose.ts';
import { createInitialState, type LiveState } from '../../../src/tui/state.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = { isTTY: true, cols: 100, rows: 24, color: 'none', unicode: true };

// clarify is a confirm flavor: it lives in the shared `modal` slot and
// renders through renderModal, so compose treats it like any modal.
const withClarify = (): LiveState => {
  const s = createInitialState();
  return {
    ...s,
    status: { ...s.status, sessionId: 's1', project: 'forja', model: 'opus' },
    modal: {
      promptId: 'c1',
      flavor: 'clarify',
      title: 'Clarify',
      subject: 'blast differs',
      subjectTone: 'secondary',
      preview: [],
      question: 'which validateOrder?',
      options: [
        { key: 'a', label: 'orders.ts', value: 'a' },
        { key: 'b', label: 'checkout.ts', value: 'b' },
      ],
      selectedIndex: 0,
      hints: ['↑/↓ choose', 'Enter confirm', 'Esc skip'],
      queueDepth: 0,
    },
  };
};

describe('composeLive: clarify modal (confirm flavor)', () => {
  test('renders Clarify + question + why + options in the bottom slot', () => {
    const text = composeLive(withClarify(), caps, 0).join('\n');
    expect(text).toContain('Clarify');
    expect(text).toContain('which validateOrder?');
    expect(text).toContain('blast differs'); // why → subject
    expect(text).toContain('a. orders.ts');
    expect(text).toContain('Enter confirm · Esc skip');
  });

  test('hides the cursor while the modal is up', () => {
    expect(composeCursor(withClarify(), caps, 10)).toBeNull();
  });
});
