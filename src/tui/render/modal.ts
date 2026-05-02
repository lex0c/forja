// Modal box render. Spec: UI.md §5.5.
//
// Renders the active confirm-style modal as a horizontal-rule-bordered
// block with a headline, optional detail lines, and a YES/NO selector.
// `▶` (Unicode) / `>` (ASCII) marks the current selection. Default is
// always 'no' — the manager constructs the state with selected='no',
// so the renderer just reflects it.
//
// Layout:
//
//   ─────────────────────────────────────────
//     <message>
//
//     <details[0]>
//     <details[1]>
//     ...
//
//     ▶ YES        NO
//   ─────────────────────────────────────────
//
// The status line + tool cards still render above this; only the
// input box is replaced. composeLive handles the swap.

import type { ConfirmState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';

// Default rule width when the terminal is wide enough. Below this we
// adapt to `caps.cols` so the rule never extends past the live region;
// `truncateToWidth` would clip it anyway, but a too-wide rule wraps
// to extra rows on terminals that don't auto-truncate, breaking the
// liveHeight cursor math.
const DEFAULT_RULE_LEN = 41;
// Minimum rule width — below this we still emit the rule, just very
// short. Terminals narrower than this get a degraded but functional
// modal (warned about elsewhere — UI.md §2.4 breakpoint < 60 cols).
const MIN_RULE_LEN = 8;

// Build the top/bottom rule for the modal. Unicode uses `─`; ASCII
// uses `-`. Width adapts to `caps.cols` minus 2 (matches the modal's
// 2-space inner indent).
const rule = (caps: Capabilities): string => {
  const width = Math.max(MIN_RULE_LEN, Math.min(DEFAULT_RULE_LEN, caps.cols - 2));
  return (caps.unicode ? '─' : '-').repeat(width);
};

export const renderModal = (modal: ConfirmState, caps: Capabilities): string[] => {
  const lines: string[] = [];
  lines.push(rule(caps));
  lines.push(`  ${paint(caps, 'bold', modal.message)}`);
  if (modal.details.length > 0) {
    lines.push('');
    for (const d of modal.details) {
      // Empty details turn into blank spacer lines (used by
      // memory-write / plan-review to separate sections); non-empty
      // get the same 2-space indent as the message and dim styling
      // so the headline reads as the primary information.
      lines.push(d === '' ? '' : `  ${paint(caps, 'dim', d)}`);
    }
  }
  lines.push('');
  lines.push(`  ${selectorLine(modal, caps)}`);
  lines.push(rule(caps));
  return lines;
};

// "▶ YES        NO"  /  "  YES      ▶ NO"
// Pointer + label per option, fixed-width spacing so the layout
// doesn't jitter when the user toggles. Color tone is intentionally
// minimal: we don't paint YES green or NO red — that would suggest
// approval is the safe choice. Default = NO is the safety default;
// using color to highlight YES would undermine that.
const selectorLine = (modal: ConfirmState, caps: Capabilities): string => {
  const pointer = caps.unicode ? '▶' : '>';
  const yesPtr = modal.selected === 'yes' ? pointer : ' ';
  const noPtr = modal.selected === 'no' ? pointer : ' ';
  return `${yesPtr} YES        ${noPtr} NO`;
};
