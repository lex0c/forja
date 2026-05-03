// Live "Generating…" chip. Spec: UI.md §4.10.5 (operation chip,
// active state) — the assistant turn shows up as an operation chip
// alongside tool cards while text streams in.
//
// Format:
//   ▸ Generating… (8s · ↑ 234 tokens)        ← usage event arrived
//   ▸ Generating… (8s)                       ← no usage yet
//
// The token counter only appears once an `assistant:usage` UIEvent
// has merged onto pendingAssistant. Estimating from char count
// would mislead the operator (chars/4 drifts hard on code-heavy
// turns), and the project's measure-twice-cut-once stance is to
// show no number when we don't have one. The final scrollback chip
// (formatPermanent's `assistant` branch) does carry the real count
// once `usage` lands at message_stop.

import type { PendingAssistant } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { spinnerGlyph } from './tool-card.ts';

const formatElapsed = (ms: number): string => {
  // Negative clock skew (producer's startedAt > now) clamps to 0 in
  // ms units, not seconds — keeps the unit consistent with the
  // sub-second positive branch so a clock-skew tick doesn't visually
  // jump from "350ms" to "(0s)".
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const renderAssistantChip = (
  pending: PendingAssistant,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatElapsed(now - pending.startedAt);
  // ↑ glyph is intentionally Unicode-only with an ASCII fallback to
  // `^` (uplink direction). Spec §4.10.5 calls out `↑` literal as
  // "engineer recognizes as uplink/output direction"; ASCII users
  // get a plain marker rather than dropping the count entirely.
  const upArrow = caps.unicode ? '↑' : '^';
  const counter =
    pending.outputTokens === null
      ? `(${elapsed})`
      : `(${elapsed} · ${upArrow} ${pending.outputTokens} tokens)`;
  return [paint(caps, 'warn', `${spinner} Generating… ${counter}`)];
};
