import { describe, expect, test } from 'bun:test';
import { renderStatusLine } from '../../../src/tui/render/status.ts';
import { type LiveState, createInitialState } from '../../../src/tui/state.ts';
import { CSI, type Capabilities } from '../../../src/tui/term.ts';

const ascii: Capabilities = {
  isTTY: true,
  cols: 100,
  rows: 24,
  color: 'none',
  unicode: false,
};
const unicode: Capabilities = { ...ascii, unicode: true };
const colored: Capabilities = { ...unicode, color: 'basic' };

const withSession = (overrides: Partial<LiveState['status']> = {}): LiveState => {
  const s = createInitialState();
  return {
    ...s,
    status: {
      ...s.status,
      sessionId: 's1',
      profile: 'autonomous',
      project: 'forja',
      model: 'opus',
      ...overrides,
    },
  };
};

describe('renderStatusLine', () => {
  test('returns null before session has started', () => {
    expect(renderStatusLine(createInitialState(), unicode, { now: 1 })).toBeNull();
  });

  test('renders profile, project, model with Unicode separators', () => {
    const out = renderStatusLine(withSession(), unicode, { now: 1 });
    expect(out).toBe('[autonomous] · forja · opus · $0.0000');
  });

  test('renders ASCII separators when unicode disabled', () => {
    const out = renderStatusLine(withSession(), ascii, { now: 1 });
    expect(out).toBe('[autonomous] - forja - opus - $0.0000');
  });

  test('includes steps fraction when maxSteps > 0', () => {
    const out = renderStatusLine(withSession({ steps: 12, maxSteps: 50 }), ascii, { now: 1 });
    expect(out).toContain('12/50');
  });

  test('omits steps fraction when maxSteps is 0', () => {
    const out = renderStatusLine(withSession({ steps: 0, maxSteps: 0 }), ascii, { now: 1 });
    expect(out).not.toMatch(/\b\d+\/0\b/);
  });

  test('cost formatting scales by magnitude', () => {
    expect(renderStatusLine(withSession({ costUsd: 0.0123 }), ascii, { now: 1 })).toContain(
      '$0.0123',
    );
    expect(renderStatusLine(withSession({ costUsd: 1.234 }), ascii, { now: 1 })).toContain(
      '$1.234',
    );
    expect(renderStatusLine(withSession({ costUsd: 123.45 }), ascii, { now: 1 })).toContain(
      '$123.45',
    );
  });

  test('budget shading: 80% of steps wraps in warn (yellow)', () => {
    const out = renderStatusLine(withSession({ steps: 40, maxSteps: 50 }), colored, { now: 1 });
    expect(out).toContain(`${CSI}33m40/50${CSI}0m`);
  });

  test('budget shading: 90% of steps wraps in error (red)', () => {
    const out = renderStatusLine(withSession({ steps: 45, maxSteps: 50 }), colored, { now: 1 });
    expect(out).toContain(`${CSI}31m45/50${CSI}0m`);
  });

  test('budget shading: cost cap at 90% wraps in error', () => {
    const out = renderStatusLine(withSession({ costUsd: 4.5, maxCostUsd: 5 }), colored, { now: 1 });
    expect(out).toContain(`${CSI}31m`);
  });

  test('no cost cap: no shading even on huge cost', () => {
    const out = renderStatusLine(withSession({ costUsd: 999, maxCostUsd: null }), colored, {
      now: 1,
    });
    expect(out).not.toContain(`${CSI}31m`);
    expect(out).not.toContain(`${CSI}33m`);
  });

  test('thinking indicator appended with elapsed seconds (Unicode ellipsis)', () => {
    const s = { ...withSession(), thinking: { startedAt: 0 } };
    const out = renderStatusLine(s, unicode, { now: 12_500 });
    expect(out).toContain('thinking… 12s');
  });

  test('thinking indicator uses ASCII ellipsis when unicode disabled', () => {
    const s = { ...withSession(), thinking: { startedAt: 0 } };
    const out = renderStatusLine(s, ascii, { now: 5000 });
    expect(out).toContain('thinking... 5s');
  });

  test('thinking elapsed clamps to 0 if now < startedAt (clock skew)', () => {
    const s = { ...withSession(), thinking: { startedAt: 100 } };
    const out = renderStatusLine(s, ascii, { now: 50 });
    expect(out).toContain('thinking... 0s');
  });

  test('skips empty profile / project / model fields', () => {
    const out = renderStatusLine(withSession({ profile: '', project: '', model: 'opus' }), ascii, {
      now: 1,
    });
    expect(out).toBe('opus - $0.0000');
  });
});
