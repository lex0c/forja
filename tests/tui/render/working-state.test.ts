import { describe, expect, test } from 'bun:test';
import {
  formatWorkingStatePanel,
  WORKING_STATE_PANEL_HEADER,
} from '../../../src/tui/render/working-state.ts';
import { emptyWorkingState, type WorkingState } from '../../../src/working-state/index.ts';

describe('formatWorkingStatePanel', () => {
  test('renders focus, next, and open hypotheses under the header — but NOT the log', () => {
    const state: WorkingState = {
      focus: { text: 'close the XDG gap', atStep: 3 },
      next: ['run permissions suite', 'commit'],
      // Log is history; it must never appear in the TUI panel.
      log: [{ text: 'LOG-SHOULD-NOT-APPEAR', atStep: 1 }],
      hypotheses: [
        {
          id: 'H1',
          text: 'resolver covers both floors',
          status: 'open',
          source: 'model',
          evidence: [],
          updatedAtStep: 2,
        },
      ],
    };
    const out = formatWorkingStatePanel(state);
    expect(out).not.toBeNull();
    // Header is split out (rendered in the default tone); body carries the
    // toned content and must NOT duplicate the header.
    expect(out?.header).toBe(WORKING_STATE_PANEL_HEADER);
    expect(out?.body).toContain('focus: close the XDG gap');
    expect(out?.body).toContain('next: run permissions suite · commit');
    expect(out?.body).toContain('H1: resolver covers both floors');
    expect(out?.body).not.toContain('LOG-SHOULD-NOT-APPEAR');
    expect(out?.body).not.toContain(WORKING_STATE_PANEL_HEADER);
  });

  test('returns null when nothing operational to show (empty / log-only / cleared)', () => {
    expect(formatWorkingStatePanel(emptyWorkingState())).toBeNull();
    // Log present but no focus/next/hypotheses → still nothing to render.
    const logOnly: WorkingState = {
      next: [],
      log: [{ text: 'milestone', atStep: 1 }],
      hypotheses: [],
    };
    expect(formatWorkingStatePanel(logOnly)).toBeNull();
  });

  test('sanitizes model-authored text — no control bytes, no fabricated rows', () => {
    // Build the ESC byte programmatically; a raw control char doesn't survive
    // being written into source.
    const esc = String.fromCharCode(27);
    const state: WorkingState = {
      focus: { text: `evil${esc}[31m\nrow-injection`, atStep: 1 },
      next: [],
      log: [],
      hypotheses: [],
    };
    const body = formatWorkingStatePanel(state)?.body ?? '';
    // The escape byte is stripped and the embedded newline can't fabricate an
    // extra panel row: focus-only → the body is a single line.
    expect(body).not.toContain(esc);
    expect(body.split('\n')).toHaveLength(1);
  });
});
