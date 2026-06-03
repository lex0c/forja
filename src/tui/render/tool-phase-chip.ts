// Live tool-orchestration chip. Fills the pinned turn-phase slot
// (the bottom of the live region, just above the input — see the
// chip-slot in compose.ts) during the phase where the model has
// emitted tool calls and the harness is executing them: the
// window where `thinking`, `pendingAssistant` and
// `awaitingProvider` are all null (the model has gone idle; the
// harness is running tools). Before this chip, that window left
// the slot blank, so the rotating verb the operator had been
// watching during thinking / generating vanished mid-turn. This
// keeps a live verb pinned for the whole interaction while the
// tool cards stack above it.
//
// Format:
//   ▸ Orchestrating…
//
// No elapsed timer and no token counter — by design. Each tool
// card stacked above this chip carries its own `[Xs]`, so a
// turn-level timer here would either duplicate them or, if
// anchored to the earliest active tool, jump backwards as tools
// complete. This chip is a single turn-level "the harness is
// coordinating tools" banner, not a per-call indicator; the verb
// alone carries it.
//
// Verb is picked from the TOOL (agent-infrastructure) pool by
// `pickToolVerb`, hashed off the current turn id. Stable for the
// duration of the turn — including across individual tool
// start/end churn, since the seed is the turn id, not any tool id
// — and varies across turns. When no turn id is set (defensive:
// tools running with no prior `assistant:start` / `thinking:start`
// in this session) the picker falls back to a constant seed, so
// the verb is stable rather than absent.
//
// Mutual exclusion: the compose layer's pinned chip-slot picks
// this chip only when `thinking` and `pendingAssistant` are both
// null and at least one tool is active, so it never overlaps the
// cognitive / output chips.

import { type Capabilities, paint } from '../term.ts';
import { renderShimmer } from './shimmer.ts';
import { pickToolVerb } from './spinner-verbs.ts';
import { spinnerGlyph } from './tool-card.ts';

export const renderToolPhaseChip = (
  turnId: string | null,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = paint(caps, 'secondary', `${spinnerGlyph(caps, now)} `);
  const verb = renderShimmer(`${pickToolVerb(turnId ?? 'tools')}…`, caps, now, 'secondary');
  return [`${spinner}${verb}`];
};
