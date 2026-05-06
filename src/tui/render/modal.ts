// Modal box render. Spec: UI.md §4.10.13 / §5.5.
//
// Layout (4 blocks, separated by horizontal rules):
//
//   ─────────────────────────────────────────
//     <title>           ← bold
//     <subject>         ← dim, optional
//   ─────────────────────────────────────────
//     <preview[0]>      ← producer-formatted, dim
//     ...
//   ─────────────────────────────────────────
//     <question>        ← optional, plain
//       1. <label>      ← cursor `>` on selectedIndex
//       2. <label> (shortcut)
//     > 3. <label>      ← default = last (D5/D65)
//     <hints>           ← dim, ' · ' joined
//
// Status line + tool cards still render above this; the modal owns
// the bottom of the live region while it's up. composeLive handles
// the substitution; the bottom-rule + footer don't render alongside
// (modal carries its own structure).

import type { ConfirmState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';

// Modal rule width adapts to the live region: full caps.cols so the
// modal feels structural. truncateToWidth in the renderer will clip
// if cols changes mid-render but normal redraw handles resize.
const rule = (caps: Capabilities): string =>
  (caps.unicode ? '─' : '-').repeat(Math.max(8, caps.cols));

const optionLine = (modal: ConfirmState, optIdx: number, caps: Capabilities): string => {
  const opt = modal.options[optIdx];
  if (opt === undefined) return '';
  // Cursor `>` always (ASCII universal — no Unicode pretty variant).
  const cursor = optIdx === modal.selectedIndex ? '>' : ' ';
  const shortcut = opt.shortcut !== undefined ? paint(caps, 'dim', ` (${opt.shortcut})`) : '';
  return `  ${cursor} ${opt.key}. ${opt.label}${shortcut}`;
};

export const renderModal = (modal: ConfirmState, caps: Capabilities): string[] => {
  const lines: string[] = [];
  // Block 1 — title + subject.
  lines.push(rule(caps));
  // Queue suffix is the visible signal that more asks are waiting
  // behind the active one. Without it the operator answering a
  // modal would see another pop immediately afterward with no
  // warning — particularly confusing when the same subagent name
  // queues multiple asks (looks like a regression / loop). Modal-
  // manager keeps `queueDepth` live via `modal:queue-depth`
  // events; renderer only formats.
  const queueSuffix = modal.queueDepth > 0 ? ` (+${modal.queueDepth} waiting)` : '';
  lines.push(`  ${paint(caps, 'bold', `${modal.title}${queueSuffix}`)}`);
  if (modal.subject !== null) lines.push(`  ${paint(caps, 'dim', modal.subject)}`);
  // Block 2 — preview (skipped when empty so we don't render
  // back-to-back rules).
  if (modal.preview.length > 0) {
    lines.push(rule(caps));
    for (const p of modal.preview) {
      lines.push(p === '' ? '' : `  ${paint(caps, 'dim', p)}`);
    }
  }
  // Block 3 — question + options.
  lines.push(rule(caps));
  if (modal.question !== null) lines.push(`  ${modal.question}`);
  for (let i = 0; i < modal.options.length; i++) {
    lines.push(optionLine(modal, i, caps));
  }
  // Block 4 — hint footer (joined dim, no leading rule).
  if (modal.hints.length > 0) {
    lines.push(`  ${paint(caps, 'dim', modal.hints.join(' · '))}`);
  }
  return lines;
};
