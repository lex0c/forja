// Live cognitive-pass chip. Spec: TOKEN_TUNING.md §4.3 promised
// "thinking... (Xs, $Y) na status line durante reasoning ativo"
// — the state existed (`state.thinking`) and the events fired
// (`thinking:start` / `thinking:delta` / `thinking:end`) but no
// render-side surface ever painted it. Operators using extended
// thinking (Anthropic Opus / OpenAI o-series) saw a frozen
// generating chip with no progress for 5-30s and had no way to
// tell whether the model was reasoning or the run was hung.
//
// This chip closes that gap. It mirrors the structure of
// `assistant-chip.ts` (same spinner, same elapsed formatting) so
// the operator's eye reads them as the same family of indicator.
//
// Verb is picked from the COGNITIVE pool by `pickCognitiveVerb`,
// hashed off the assistant message id. Stable for the duration
// of the turn (no flicker between consecutive frames), varies
// across turns (same hash strategy as the assistant chip's
// output pool — see `spinner-verbs.ts` for the full rationale).
//
// Format:
//   ▸ Synthesizing…  [8s]
//
// No token counter. Anthropic's extended thinking emits
// `thinking_delta` events without a usable per-token signal at
// our adapter layer; the cumulative `usage` event arrives once at
// message_stop with the total. Showing a fake count during the
// thinking pass would mislead the operator about progress.
// Cost is shown in the footer's right column (status.costUsd) and
// updates per step:budget — not duplicated here.
//
// Mutual exclusion with the assistant chip: harness-adapter.ts
// closes `thinking:end` when text starts streaming
// (`text_delta` → endThinking), so within a single assistant turn
// the two states alternate but never overlap. The compose layer
// picks one chip per turn based on which state is set.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { formatChipDuration } from './duration.ts';
import { renderShimmer } from './shimmer.ts';
import { pickCognitiveVerb } from './spinner-verbs.ts';
import { spinnerGlyph } from './tool-card.ts';

export const renderThinkingChip = (
  thinking: NonNullable<LiveState['thinking']>,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatChipDuration(now - thinking.startedAt);
  const verb = renderShimmer(`${pickCognitiveVerb(thinking.messageId)}…`, caps, now, 'secondary');
  const head = paint(caps, 'secondary', `${spinner} `);
  return [`${head}${verb}${paint(caps, 'secondary', `  [${elapsed}]`)}`];
};
