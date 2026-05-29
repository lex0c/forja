// Modal box render. Spec: UI.md §4.10.13 / §5.5; redesign in
// design/permission-modal-redesign.md.
//
// Layout — single top rule, then content stacked with whitespace
// (no intermediate rules). Reference designs read structure from
// breathing room, not from horizontal dividers — earlier 3-rule
// layout had the boxes-in-boxes feel that the redesign explicitly
// avoids.
//
//   ─────────────────────────────────────────  ← `accent` color
//     <title>           ← bold
//     <subject>         ← dim (or secondary), optional
//
//     <preview[0]>      ← producer-formatted; default dim,
//     ...                  per-line `secondary` for source
//                          attribution and similar fast-triage rows
//
//     <question>        ← optional, plain
//       1. <label>      ← cursor `>` on selectedIndex
//       2. <label> (shortcut)
//     > 3. <label>      ← default = last (D5/D65)
//
//     <hints>           ← `secondary`, ' · ' joined; padded by a
//                          blank line so it doesn't fuse into the
//                          last option
//
// Status line + tool cards still render above this; the modal owns
// the bottom of the live region while it's up. composeLive handles
// the substitution; the bottom-rule + footer don't render alongside
// (modal carries its own structure).

import type { ConfirmState, PreviewLine } from '../state.ts';
import { type Capabilities, paint, paintMulti } from '../term.ts';

// Modal rule width adapts to the live region: full caps.cols so the
// modal feels structural. truncateToWidth in the renderer will clip
// if cols changes mid-render but normal redraw handles resize.
const rule = (caps: Capabilities): string =>
  (caps.unicode ? '─' : '-').repeat(Math.max(8, caps.cols));

const optionLine = (modal: ConfirmState, optIdx: number, caps: Capabilities): string => {
  const opt = modal.options[optIdx];
  if (opt === undefined) return '';
  const selected = optIdx === modal.selectedIndex;
  // Cursor `>` marks the active row (ASCII universal — no Unicode
  // pretty variant). On the selected row the cursor + label are
  // painted `accent` (blue) to highlight the active choice, while the
  // key digit keeps the `secondary` tone it has on every row so the
  // hotkey reminder isn't swept into the highlight. Adjacent paint
  // runs (each self-closes) — not nested — so no inner reset some
  // terminals re-process as a flash.
  const cursor = selected ? '>' : ' ';
  if (selected) {
    const shortcut = opt.shortcut !== undefined ? ` (${opt.shortcut})` : '';
    const cursorTok = paint(caps, 'accent', cursor);
    const keyTok = paint(caps, 'secondary', `${opt.key}.`);
    const labelTok = paint(caps, 'accent', `${opt.label}${shortcut}`);
    return `  ${cursorTok} ${keyTok} ${labelTok}`;
  }
  // Unselected rows: number + period painted `secondary` so the
  // eye-attractor is the option label, not the digit. Operator's
  // mental scan goes label-first ("Yes", "No", "Approve"); the
  // number is the hotkey reminder, useful but subordinate.
  const shortcut = opt.shortcut !== undefined ? paint(caps, 'dim', ` (${opt.shortcut})`) : '';
  const keyToken = paint(caps, 'secondary', `${opt.key}.`);
  return `  ${cursor} ${keyToken} ${opt.label}${shortcut}`;
};

// Paint one preview line. Plain strings get the dim default
// (matches every existing producer); the `{ text, tone }` shape
// lets a producer override on a per-line basis (today: source
// attribution in `secondary`).
const previewRow = (line: PreviewLine, caps: Capabilities): string => {
  if (typeof line === 'string') {
    return line === '' ? '' : `  ${paint(caps, 'dim', line)}`;
  }
  return line.text === '' ? '' : `  ${paint(caps, line.tone, line.text)}`;
};

// Strip blank entries from the START and END of a preview array.
// renderModal owns the inter-section spacing (one blank line above the
// preview block and above the decision block); producers that still
// emit their own edge blanks (the permission flavor wraps its action in
// leading/trailing blanks) would otherwise double the gap. Internal
// blanks are preserved — they separate sub-blocks a producer
// deliberately spaced (e.g. plan-review's steps vs. the cost estimate,
// memory-user-scope's warning vs. the body).
const isBlankLine = (line: PreviewLine | undefined): boolean =>
  line === undefined ? false : typeof line === 'string' ? line === '' : line.text === '';

const trimBlankEnds = (preview: readonly PreviewLine[]): readonly PreviewLine[] => {
  let start = 0;
  let end = preview.length;
  while (start < end && isBlankLine(preview[start])) start++;
  while (end > start && isBlankLine(preview[end - 1])) end--;
  return preview.slice(start, end);
};

export const renderModal = (modal: ConfirmState, caps: Capabilities): string[] => {
  const lines: string[] = [];
  // Top rule — only structural divider in the modal. Painted with
  // `accent` so the modal anchor stands out from surrounding dim
  // chat / tool-card text.
  lines.push(paint(caps, 'accent', rule(caps)));
  // Queue suffix is the visible signal that more asks are waiting
  // behind the active one. Without it the operator answering a
  // modal would see another pop immediately afterward with no
  // warning — particularly confusing when the same subagent name
  // queues multiple asks (looks like a regression / loop). Modal-
  // manager keeps `queueDepth` live via `modal:queue-depth`
  // events; renderer only formats.
  const queueSuffix = modal.queueDepth > 0 ? ` (+${modal.queueDepth} waiting)` : '';
  // Title takes the same `accent` color as the top rule so the two
  // structural anchors read as a single visual unit. `bold` adds
  // weight on top. paintMulti emits a single trailing reset
  // (\x1b[94m\x1b[1m{title}\x1b[0m) — nested paint() would emit a
  // redundant inner reset that some terminals re-process as a flash.
  lines.push(`  ${paintMulti(caps, ['accent', 'bold'], `${modal.title}${queueSuffix}`)}`);
  if (modal.subject !== null)
    lines.push(`  ${paint(caps, modal.subjectTone ?? 'dim', modal.subject)}`);
  // Preview block — one blank line of breathing room above it so the
  // action/body detaches from the title block. Every flavor gets the
  // same gap (the spacing is structural, owned here, not per-producer).
  // Edge blanks are trimmed so producers that still emit their own
  // don't double it; internal blanks survive.
  const preview = trimBlankEnds(modal.preview);
  if (preview.length > 0) {
    lines.push('');
    for (const p of preview) {
      lines.push(previewRow(p, caps));
    }
  }
  // Question + options — same breathing room above the decision block,
  // so the prompt + numbered choices read as a distinct section rather
  // than fusing with the preview above.
  if (modal.question !== null || modal.options.length > 0) {
    lines.push('');
    if (modal.question !== null) lines.push(`  ${modal.question}`);
    for (let i = 0; i < modal.options.length; i++) {
      lines.push(optionLine(modal, i, caps));
    }
  }
  // Footer hint — padded by one blank line so it visually detaches
  // from the last option (without padding the operator's eye reads
  // the hint as a fourth menu item). Painted `secondary` so it
  // breaks out of `dim` but stays subordinate to the options
  // above.
  if (modal.hints.length > 0) {
    lines.push('');
    lines.push(`  ${paint(caps, 'secondary', modal.hints.join(' · '))}`);
  }
  return lines;
};
