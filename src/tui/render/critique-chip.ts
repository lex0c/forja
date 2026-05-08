// Self-critique pass live chip (AGENTIC_CLI.md §5.4,
// ORCHESTRATION.md §6). Mirrors the structure of `thinking-chip.ts`
// — same spinner, same elapsed format, same family of indicator —
// so the operator's eye reads them as the same kind of "model is
// busy on a behind-the-scenes pass" signal.
//
// Renders during the up-to-`maxOverheadMs` window between the
// executor's `assistant:end` and the modal opening (or the
// engine's soft-skipped fallthrough). Without this chip, the live
// region goes silent for several seconds — operator can't tell a
// healthy critic call from a hang.
//
// Color escalates with `toolPlanWrites`: text-only end-of-step
// reviews get the regular `warn` palette token (same as thinking —
// "model is doing something"); writes-step plan critiques get
// `error` to signal "the agent is about to mutate, the critic is
// the gate before that lands". Fast visual scan: yellow chip =
// soft check, red chip = something with side effects is being
// reviewed.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { spinnerGlyph } from './tool-card.ts';

const formatElapsed = (ms: number): string => {
  // Same clamp as thinking-chip / assistant-chip: clock skew
  // (producer's startedAt > now) clamps to 0 in ms, not seconds,
  // so a single skew tick doesn't visually jump units.
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const renderCritiqueChip = (
  critique: NonNullable<LiveState['critique']>,
  caps: Capabilities,
  now: number,
): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatElapsed(now - critique.startedAt);
  // Verb is fixed (no spinner-verbs pool) — the critic's role is
  // narrow enough that variation would feel cute rather than
  // informative. "Reviewing" reads as "second pair of eyes", which
  // is exactly the spec's framing (§5.4 line 514).
  const label = critique.toolPlanWrites
    ? 'Reviewing tool plan' // about to mutate — emphasis on the plan
    : 'Reviewing output'; //   text-only end-of-step
  const color = critique.toolPlanWrites ? 'error' : 'warn';
  return [paint(caps, color, `${spinner} ${label}… (${elapsed})`)];
};
