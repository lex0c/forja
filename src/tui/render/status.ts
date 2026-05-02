// Status line render. Spec: UI.md §4.4.
//
// One line that lives at the bottom of the live region. Layout:
//   [profile] · project · model · steps · cost · thinking?
//
// Budget shading: steps and cost cross 80% → warn (yellow); 90% →
// error (red). Cost cap is optional (`maxCostUsd === null` means no
// budget bar shading).
//
// Returns null when the session hasn't started yet (status fields
// still null) — caller skips the line entirely instead of rendering
// dashes everywhere.

import type { LiveState } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';

export interface RenderStatusOptions {
  // Current wall-clock ms — used to compute thinking duration. Caller
  // (composeLive) passes `Date.now()` or an injected fake.
  now: number;
}

const formatCost = (usd: number): string => {
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
};

// Returns the SGR token to wrap a budget figure based on usage ratio.
// 80% → warn, 90% → error, otherwise plain.
const budgetTone = (ratio: number): 'warn' | 'error' | null => {
  if (ratio >= 0.9) return 'error';
  if (ratio >= 0.8) return 'warn';
  return null;
};

const tone = (caps: Capabilities, ratio: number, text: string): string => {
  const t = budgetTone(ratio);
  return t === null ? text : paint(caps, t, text);
};

export const renderStatusLine = (
  state: LiveState,
  caps: Capabilities,
  opts: RenderStatusOptions,
): string | null => {
  const s = state.status;
  if (s.sessionId === null) return null;

  const sep = caps.unicode ? ' · ' : ' - ';
  const parts: string[] = [];

  if (s.profile !== null && s.profile !== '') parts.push(`[${s.profile}]`);
  if (s.project !== null && s.project !== '') parts.push(s.project);
  if (s.model !== null && s.model !== '') parts.push(s.model);

  if (s.maxSteps > 0) {
    parts.push(tone(caps, s.steps / s.maxSteps, `${s.steps}/${s.maxSteps}`));
  }

  const costStr = formatCost(s.costUsd);
  parts.push(s.maxCostUsd !== null ? tone(caps, s.costUsd / s.maxCostUsd, costStr) : costStr);

  if (state.thinking !== null) {
    const elapsedSec = Math.max(0, Math.floor((opts.now - state.thinking.startedAt) / 1000));
    const ellipsis = caps.unicode ? '…' : '...';
    parts.push(paint(caps, 'dim', `thinking${ellipsis} ${elapsedSec}s`));
  }

  return parts.join(sep);
};
