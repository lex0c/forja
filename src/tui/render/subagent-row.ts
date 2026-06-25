// Live subagent group block. Spec: UI.md §4.2.
//
// Renders one row per active subagent, keyed by subagentId in
// `state.subagents`. Empty map returns [] — composer drops the
// section entirely (no header, no spacer).
//
// Layout (single subagent):
//
//   Subagents · 1 running · 2.4s
//     ⠋ explore: find the README in docs/      2.4s
//       └ read engine.ts
//
// Line 1 carries the identity: spinner + name + a truncated slice of the
// seed `goal` (the raw prompt the model passed), so the operator reads WHAT
// each child was asked to do — not just its name. The goal persists for the
// child's whole life; line 2 carries the in-flight tool (or `starting…`
// before the first tool arrives). Multiple subagents render one such pair
// each under the shared header.
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

// Cap on the inline line-1 goal / line-2 detail. Frame width drives the real
// budget; this is a defensive ceiling so a chatty prompt or tool subject can't
// blow out the row on a very wide terminal.
const MAX_DETAIL = 80;

// Floor for the line-1 goal slice on narrow terminals: even when the frame is
// tight, show at least this many characters of the prompt rather than dropping
// it entirely.
const GOAL_MIN = 16;

const truncate = (s: string, max: number): string => {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
};

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
    const meta = `  ${elapsed}${cost}`;
    // Line 1: spinner (accent live-cue) + name + a truncated slice of the seed
    // goal/prompt (`explore: find the README…`), so the operator reads WHAT the
    // child is doing, not just its name. The goal is budgeted against the frame
    // width so the trailing elapsed/cost never wraps; MAX_DETAIL is the ceiling
    // on a wide terminal, GOAL_MIN the floor on a narrow one. Name stays in the
    // default foreground (primary); the goal + meta are secondary chrome.
    //
    // Fixed chrome around the goal, all of which eats into the available width:
    // the composer's frame margin (2, added by padFrame downstream) + this row's
    // own indent (2) + spinner (1) + space (1) + the `: ` separator (2) = 8,
    // plus the trailing elapsed/cost (meta). Subtract both so the painted line
    // lands within caps.cols and never soft-wraps the live region.
    const LINE1_FIXED = 8;
    const goalBudget = Math.max(
      GOAL_MIN,
      Math.min(MAX_DETAIL, caps.cols - LINE1_FIXED - sub.name.length - meta.length),
    );
    const goalText = sub.goal.length > 0 ? `: ${truncate(sub.goal, goalBudget)}` : '';
    const head = `  ${paint(caps, 'accent', frame)} ${sub.name}${paint(caps, 'secondary', goalText)}`;
    out.push(`${head}${paint(caps, 'secondary', meta)}`);
    // Line 2: the in-flight tool (`└ read engine.ts`); before the first tool a
    // bare `starting…` — the goal already rides line 1, so we don't repeat it.
    const detail = sub.currentTool.length > 0 ? truncate(sub.currentTool, MAX_DETAIL) : 'starting…';
    out.push(paint(caps, 'secondary', `      ${tree} ${detail}`));
  }
  return out;
};
