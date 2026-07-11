import { describe, expect, test } from 'bun:test';
import { TOOL_VERB_POOL } from '../../../src/tui/render/spinner-verbs.ts';
import { renderToolPhaseChip } from '../../../src/tui/render/tool-phase-chip.ts';
import type { Capabilities } from '../../../src/tui/term.ts';

const caps: Capabilities = {
  isTTY: true,
  cols: 80,
  rows: 24,
  color: 'none',
  unicode: true,
};
const ascii: Capabilities = { ...caps, unicode: false };

// The chip is `<spinner> <verb>…` with NO trailing bracket — the
// verb is the last token on the line. Match a word immediately
// before the ellipsis at end of string.
const verbPattern = /(\w+)…\s*$/;

describe('renderToolPhaseChip', () => {
  test('renders a tool verb from the pool', () => {
    const out = renderToolPhaseChip('msg_01ABC', caps, 1000);
    expect(out).toHaveLength(1);
    const verb = out[0]?.match(verbPattern)?.[1];
    expect(TOOL_VERB_POOL).toContain(verb ?? '');
  });

  test('verb is stable across consecutive renders (no flicker as tools churn)', () => {
    // Seeded off the turn id, so the verb must hold steady while
    // the spinner ticks and individual tool cards come and go.
    const a = renderToolPhaseChip('msg_01ABC', caps, 1000);
    const b = renderToolPhaseChip('msg_01ABC', caps, 9000);
    const verbA = a[0]?.match(verbPattern)?.[1];
    const verbB = b[0]?.match(verbPattern)?.[1];
    expect(verbA).toBe(verbB ?? '');
  });

  test('null turn id falls back to a stable verb (defensive)', () => {
    // Tools running with no prior assistant:start/thinking:start in
    // the session: the chip still shows a verb rather than blank.
    const out = renderToolPhaseChip(null, caps, 1000);
    const verb = out[0]?.match(verbPattern)?.[1];
    expect(TOOL_VERB_POOL).toContain(verb ?? '');
  });

  test('carries no timer and no token counter (per-tool cards own those)', () => {
    const out = renderToolPhaseChip('msg_01ABC', caps, 8200);
    expect(out[0]).not.toContain('[');
    expect(out[0]).not.toContain('tokens');
    expect(out[0]).not.toContain('↑');
  });

  test('ASCII fallback renders a verb cleanly', () => {
    const out = renderToolPhaseChip('msg_01ABC', ascii, 1200);
    const verb = out[0]?.match(verbPattern)?.[1];
    expect(TOOL_VERB_POOL).toContain(verb ?? '');
  });
});
