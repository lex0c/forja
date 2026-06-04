import { describe, expect, test } from 'bun:test';
import {
  type ClarifyModalState,
  renderClarifyModal,
} from '../../../src/tui/render/clarify-modal.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

// color: 'none' → paint() returns the raw text, so assertions read the
// structure without ANSI noise.
const ascii: Capabilities = { isTTY: true, cols: 60, rows: 24, color: 'none', unicode: false };
const unicode: Capabilities = { ...ascii, unicode: true };

const state = (over: Partial<ClarifyModalState> = {}): ClarifyModalState => ({
  promptId: 'p1',
  flavor: 'clarify',
  activeQuestion: 0,
  queueDepth: 0,
  hints: ['↑/↓ choose', 'Tab next', 'Enter confirm', 'Esc skip'],
  questions: [
    {
      question: 'which validateOrder?',
      why: 'blast differs; (a) 3 files, (b) 8',
      options: [
        { id: 'a', label: 'src/orders.ts:142' },
        { id: 'b', label: 'src/checkout.ts:89' },
      ],
      selectedIndex: 0,
    },
    {
      question: 'apply to tests too?',
      why: null,
      options: [
        { id: 'a', label: 'yes' },
        { id: 'b', label: 'no' },
      ],
      selectedIndex: 1,
    },
    ...(over.questions ?? []),
  ],
  ...over,
});

describe('renderClarifyModal', () => {
  test('renders the title, both questions, and their options', () => {
    const text = renderClarifyModal(state(), ascii).join('\n');
    expect(text).toContain('Clarify');
    expect(text).toContain('1. which validateOrder?');
    expect(text).toContain('2. apply to tests too?');
    expect(text).toContain('a. src/orders.ts:142');
    expect(text).toContain('b. no');
  });

  test('the active question shows the > cursor on its selectedIndex', () => {
    const lines = renderClarifyModal(state(), ascii);
    const cursorLine = lines.find((l) => l.includes('a. src/orders.ts:142'));
    expect(cursorLine?.trimStart().startsWith('>')).toBe(true);
  });

  test('renders the why line when present, skips it when null', () => {
    const lines = renderClarifyModal(state(), ascii);
    expect(lines.join('\n')).toContain('blast differs; (a) 3 files, (b) 8');
    // q2's why is null → the q2 heading is followed directly by its
    // first option, no orphan blank/why row.
    const q2Idx = lines.findIndex((l) => l.includes('2. apply to tests too?'));
    expect(lines[q2Idx + 1]).toContain('a. yes');
  });

  test('marks the active question with > (ascii) / ▸ (unicode)', () => {
    const a = renderClarifyModal(state(), ascii).find((l) => l.includes('1. which validateOrder?'));
    expect(a?.trimStart().startsWith('>')).toBe(true);
    expect(renderClarifyModal(state(), unicode).join('\n')).toContain('▸');
  });

  test('a non-active question flags its pick with * (no > cursor)', () => {
    // q2 is non-active, selectedIndex 1 → "no" carries the pick marker.
    const noLine = renderClarifyModal(state(), ascii).find((l) => l.includes('b. no'));
    expect(noLine?.includes('>')).toBe(false);
    expect(noLine?.trimStart().startsWith('*')).toBe(true);
  });

  test('surfaces queue depth as a (+N waiting) suffix', () => {
    expect(renderClarifyModal(state({ queueDepth: 2 }), ascii).join('\n')).toContain(
      'Clarify (+2 waiting)',
    );
  });

  test('renders the footer hints joined by ·', () => {
    expect(renderClarifyModal(state(), ascii).join('\n')).toContain(
      '↑/↓ choose · Tab next · Enter confirm · Esc skip',
    );
  });
});
