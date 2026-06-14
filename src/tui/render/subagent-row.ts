// Live subagent group block. Spec: UI.md §4.2.
//
// Renders one row per active subagent, keyed by subagentId in
// `state.subagents`. Empty map returns [] — composer drops the
// section entirely (no header, no spacer).
//
// Layout (single subagent):
//
//   Subagents
//     ▸ task explore · running echo · 2.4s
//
// Multiple subagents render one row each under the shared header.
// Live row keeps the most recent `progress` one-liner from the
// adapter (which coalesces incoming child HarnessEvents into a
// terse present-tense phrase: `step 2`, `running echo`, etc.).
// When `progress` is empty (no `subagent:update` arrived yet),
// the row shows the seed `goal` truncated — gives the operator
// something to read while the child boots.
//
// On `subagent:end` the row drops out of the live region; the
// reducer emits a `subagent_summary` permanent item so scrollback
// keeps the terminal verdict.

import { type Capabilities, paint } from '../term.ts';
import { formatCoarseDuration } from './duration.ts';
import { renderShimmer } from './shimmer.ts';

// Braille spinner — advances per heartbeat tick (liveRegionActive keeps
// the heartbeat awake while any subagent runs). ASCII fallback rotates too.
const SPINNER = {
  unicode: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  ascii: ['|', '/', '-', '\\'],
} as const;
const SPINNER_PERIOD_MS = 80;

// Line-2 connector for the in-flight tool, under the name.
const TREE_GLYPH = { unicode: '└', ascii: '\\' } as const;

// Padded width for the subagent name on line 1, so the elapsed/cost
// columns align across rows. Longer names truncate with an ellipsis.
const NAME_WIDTH = 16;

// Cap on the inline line-2 detail. Frame width drives the real budget;
// this is a defensive ceiling so a chatty subject can't blow out the row.
const MAX_DETAIL = 80;

const truncate = (s: string, max: number): string => {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
};

const padName = (name: string): string =>
  name.length > NAME_WIDTH ? `${name.slice(0, NAME_WIDTH - 1)}…` : name.padEnd(NAME_WIDTH);

// Renderer's view of a live subagent (structural subset of the reducer's
// inline type in state.ts — only the fields the live row reads).
export interface SubagentRowState {
  subagentId: string;
  name: string;
  goal: string;
  startedAt: number;
  // Cumulative live cost from `cost_update` IPC events. 0 when
  // no cost has been reported yet (or the child runs on a
  // zero-cost provider, typical in tests). The renderer
  // suppresses the `$` chip when 0 so test fixtures and
  // free-tier runs stay visually clean.
  liveCostUsd: number;
  // The child's in-flight tool as a compact `read engine.ts` label
  // (line 2). Empty before the first tool and between tools.
  currentTool: string;
}

export const renderSubagentRows = (
  subagents: ReadonlyMap<string, SubagentRowState>,
  caps: Capabilities,
  now: number,
  // Harness backlog of not-yet-started children (parallel:status). Only a
  // COUNT — queued children have no per-agent identities to render — so it
  // surfaces in the header, not as rows.
  queued = 0,
): string[] => {
  if (subagents.size === 0) return [];

  const frames = caps.unicode ? SPINNER.unicode : SPINNER.ascii;
  const frame = frames[Math.floor(now / SPINNER_PERIOD_MS) % frames.length] as string;
  const tree = caps.unicode ? TREE_GLYPH.unicode : TREE_GLYPH.ascii;

  // Header: `Subagents · N running[ · M queued][ · $T]`. Running = the rows
  // we render; queued is the header-only backlog; total sums live per-row
  // cost (suppressed at 0 so zero-cost test/free-tier runs stay clean).
  let total = 0;
  for (const s of subagents.values()) total += s.liveCostUsd;
  const parts = [`${subagents.size} running`];
  if (queued > 0) parts.push(`${queued} queued`);
  if (total > 0) parts.push(`$${total.toFixed(4)}`);
  // The `Subagents` label shimmers (left-to-right accent slide) while any
  // child runs — the section is only present when active, so it always
  // animates (the heartbeat is kept awake by liveRegionActive's subagents
  // clause). Mirrors the `Tasks` header's live-verb shimmer.
  const header = `${renderShimmer('Subagents', caps, now, 'secondary')} ${paint(caps, 'secondary', `· ${parts.join(' · ')}`)}`;
  const out: string[] = [header];

  for (const sub of subagents.values()) {
    const elapsed = formatCoarseDuration(Math.max(0, now - sub.startedAt));
    const cost = sub.liveCostUsd > 0 ? `  $${sub.liveCostUsd.toFixed(4)}` : '';
    // Line 1: spinner (accent live-cue) + padded name (primary) + elapsed
    // and cost (secondary chrome). padName aligns the columns across rows.
    const head = `  ${paint(caps, 'accent', frame)} ${padName(sub.name)}`;
    out.push(`${head}${paint(caps, 'secondary', `  ${elapsed}${cost}`)}`);
    // Line 2: the in-flight tool (`└ read engine.ts`); before the first
    // tool, the seed goal so a booting child still says what it's for.
    const detail = sub.currentTool.length > 0 ? sub.currentTool : `starting · ${sub.goal}`;
    out.push(paint(caps, 'secondary', `      ${tree} ${truncate(detail, MAX_DETAIL)}`));
  }
  return out;
};
