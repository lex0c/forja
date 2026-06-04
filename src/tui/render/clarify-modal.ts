// Clarify form-modal render. A NEW modal type, deliberately separate
// from ConfirmState / renderModal (modal.ts): the clarify gate
// (STATE_MACHINE §12) asks the operator UP TO 3 questions at once,
// each with its own options — a 2D form, not the single-question
// confirm. Kept isolated so the five confirm flavors
// (permission / trust / memory / ...) stay untouched.
//
// Layout mirrors renderModal's visual language (single top rule,
// breathing room over horizontal dividers, cursor `>` on the active
// choice, accent anchor) so the two modals read as one design family:
//
//   ───────────────────────────────────────────
//     Clarify (+1 waiting)
//
//     > 1. which validateOrder is the target?
//         blast differs; (a) 3 files, (b) 8
//       > a. src/orders.ts:142
//         b. src/checkout.ts:89
//         c. both
//
//       2. apply to tests too?
//       * a. yes
//         b. no
//
//     ↑/↓ choose · Tab next · Enter confirm · Esc skip
//
// The ACTIVE question (activeQuestion) is painted in accent with a
// marker (▸ / >) and a live `>` cursor on its selectedIndex; the
// others dim, their current pick flagged with a faint glyph (· / *).
// Navigation (↑/↓ within a question, Tab between questions, Enter /
// Esc) is the focus handler's job — this is pure render.

import type { ClarifyModalOption, ClarifyModalQuestion, ClarifyModalState } from '../state.ts';
import { type Capabilities, paint, paintMulti } from '../term.ts';
import { queueSuffix, rule } from './modal-chrome.ts';

// The form types live in state.ts (next to ConfirmState) so the reducer
// can build a ClarifyModalState; re-exported here so render-side
// consumers keep importing them from one place.
export type { ClarifyModalOption, ClarifyModalQuestion, ClarifyModalState };

const activeMarker = (caps: Capabilities): string => (caps.unicode ? '▸' : '>');
const pickMarker = (caps: Capabilities): string => (caps.unicode ? '·' : '*');

// One question's heading: numbered, the active one marked + accented,
// the rest dim. The active heading sits one space shallower than the
// dim ones so the marker column lines up with the option cursors.
const questionLine = (
  q: ClarifyModalQuestion,
  index: number,
  active: boolean,
  caps: Capabilities,
): string => {
  const num = paint(caps, 'secondary', `${index + 1}.`);
  if (active) {
    return `  ${paint(caps, 'accent', activeMarker(caps))} ${num} ${paint(caps, 'accent', q.question)}`;
  }
  return `    ${num} ${paint(caps, 'dim', q.question)}`;
};

// One option row. On the ACTIVE question the selected row gets the `>`
// cursor + accent (matching renderModal's optionLine); on a non-active
// question the selected row gets a faint pick glyph so the operator
// still sees the standing choice without the accent pulling focus.
const optionLine = (
  opt: ClarifyModalOption,
  selected: boolean,
  active: boolean,
  caps: Capabilities,
): string => {
  const key = paint(caps, 'secondary', `${opt.id}.`);
  if (active) {
    const cursor = selected ? paint(caps, 'accent', '>') : ' ';
    const label = selected ? paint(caps, 'accent', opt.label) : opt.label;
    return `    ${cursor} ${key} ${label}`;
  }
  const lead = selected ? paint(caps, 'dim', pickMarker(caps)) : ' ';
  return `    ${lead} ${key} ${paint(caps, 'dim', opt.label)}`;
};

export const renderClarifyModal = (modal: ClarifyModalState, caps: Capabilities): string[] => {
  const lines: string[] = [];
  // Top rule + title in accent — same anchor language as renderModal.
  lines.push(paint(caps, 'accent', rule(caps)));
  lines.push(
    `  ${paintMulti(caps, ['accent', 'bold'], `Clarify${queueSuffix(modal.queueDepth)}`)}`,
  );

  modal.questions.forEach((q, qi) => {
    const active = qi === modal.activeQuestion;
    // Blank line above each question block — breathing room, not a
    // divider (matches renderModal's section spacing).
    lines.push('');
    lines.push(questionLine(q, qi, active, caps));
    if (q.why !== null && q.why.length > 0) {
      lines.push(`      ${paint(caps, 'dim', q.why)}`);
    }
    for (let oi = 0; oi < q.options.length; oi++) {
      const opt = q.options[oi];
      if (opt === undefined) continue;
      lines.push(optionLine(opt, oi === q.selectedIndex, active, caps));
    }
  });

  if (modal.hints.length > 0) {
    lines.push('');
    lines.push(`  ${paint(caps, 'secondary', modal.hints.join(' · '))}`);
  }
  return lines;
};
