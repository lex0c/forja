import { sanitizeOneLineForDisplay } from '../../sanitize/ansi.ts';
import type { WorkingState } from '../../working-state/index.ts';

// Compact TUI render of the working-state panel, emitted as a scrollback
// `info` block on `working_state_updated` (the per-call tool chip is silent —
// see TOOL_VOCAB). Shows the operational thread — focus, next steps, open
// hypotheses — as a SNAPSHOT of the current state (not a diff), but NOT the
// log: the log is history and would bloat scrollback on every update (the
// operator reads the full panel in the model's context, not here).
//
// Returns null when there is nothing operational to show (focus + next +
// hypotheses all empty) so a log-only or cleared update renders nothing rather
// than a bare header. Every string is model-authored (untrusted), so each is
// one-line-sanitized — no ANSI / control injection into the operator's
// terminal, and newlines in a field can't fake extra panel rows.
export const WORKING_STATE_PANEL_HEADER = 'Updated working state';

// Split header from body so the renderer can tone them differently: the header
// labels the update and stays in the DEFAULT tone (visible); the body is the
// secondary/grey meta channel (operational scaffolding that recedes). The
// info item's `header` field carries the split.
export interface WorkingStatePanel {
  header: string;
  body: string;
}

export const formatWorkingStatePanel = (state: WorkingState): WorkingStatePanel | null => {
  const focus = state.focus?.text ?? '';
  if (focus.length === 0 && state.next.length === 0 && state.hypotheses.length === 0) {
    return null;
  }
  const lines: string[] = [];
  if (focus.length > 0) {
    lines.push(`  focus: ${sanitizeOneLineForDisplay(focus)}`);
  }
  if (state.next.length > 0) {
    lines.push(`  next: ${state.next.map((n) => sanitizeOneLineForDisplay(n)).join(' · ')}`);
  }
  for (const h of state.hypotheses) {
    lines.push(`  ${h.id}: ${sanitizeOneLineForDisplay(h.text)}`);
  }
  return { header: WORKING_STATE_PANEL_HEADER, body: lines.join('\n') };
};
