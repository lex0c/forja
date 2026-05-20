// Live output-pass chip. Spec: UI.md §4.10.5 (operation chip,
// active state) — the assistant turn shows up as an operation chip
// alongside tool cards while text streams in.
//
// Format:
//   ▸ Forging…  [8s · ↑ 234 tokens]        ← usage event arrived
//   ▸ Tempering…  [8s]                     ← no usage yet
//
// Verb is picked from the OUTPUT pool by `pickOutputVerb`, hashed
// off the assistant message id. Stable for the duration of the
// turn (no flicker between consecutive frames), varies across
// turns — see `spinner-verbs.ts` for the rationale and the cluster
// composition (Forging / Tempering / Hardening / Smelting /
// Shaping). The flat "Generating…" label was the prior baseline;
// rotating verbs match Forja's industrial framing without
// sacrificing per-turn coherence.
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
import { formatChipDuration } from './duration.ts';
import { pickOutputVerb } from './spinner-verbs.ts';
import { spinnerGlyph } from './tool-card.ts';

export const renderAssistantChip = (
  pending: PendingAssistant,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatChipDuration(now - pending.startedAt);
  // ↑ glyph is intentionally Unicode-only with an ASCII fallback to
  // `^` (uplink direction). Spec §4.10.5 calls out `↑` literal as
  // "engineer recognizes as uplink/output direction"; ASCII users
  // get a plain marker rather than dropping the count entirely.
  const upArrow = caps.unicode ? '↑' : '^';
  const counter =
    pending.outputTokens === null
      ? `[${elapsed}]`
      : `[${elapsed} · ${upArrow} ${pending.outputTokens} tokens]`;
  const verb = pickOutputVerb(pending.messageId);
  return [paint(caps, 'warn', `${spinner} ${verb}…  ${counter}`)];
};
