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

const ACTIVE_GLYPH = { unicode: '▸', ascii: '>' } as const;

// Cap on the inline progress / goal text. Frame width drives the
// real line budget; this is a defensive ceiling that prevents a
// chatty child from blowing out the row before the renderer's
// width pass clamps. Same magnitude as tool-card's preview cap.
const MAX_DETAIL = 80;

const truncate = (s: string, max: number): string => {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
};

export interface SubagentRowState {
  subagentId: string;
  name: string;
  goal: string;
  progress: string;
  startedAt: number;
  // Cumulative live cost from `cost_update` IPC events. 0 when
  // no cost has been reported yet (or the child runs on a
  // zero-cost provider, typical in tests). The renderer
  // suppresses the `$` chip when 0 so test fixtures and
  // free-tier runs stay visually clean.
  liveCostUsd: number;
}

export const renderSubagentRows = (
  subagents: ReadonlyMap<string, SubagentRowState>,
  caps: Capabilities,
  now: number,
): string[] => {
  if (subagents.size === 0) return [];

  const glyph = caps.unicode ? ACTIVE_GLYPH.unicode : ACTIVE_GLYPH.ascii;
  const out: string[] = [];
  // Header line: bare label, no glyph. Mirrors `renderTodoList`'s
  // `Tasks` header — section title in primary color, rows beneath
  // in `secondary` for the chrome and `primary` for the active
  // text.
  out.push('Subagents');
  for (const sub of subagents.values()) {
    // Detail picks progress when present; falls back to a "seeded
    // with goal" line so a subagent that hasn't pulsed yet still
    // tells the operator what it's about to do.
    const detail =
      sub.progress.length > 0
        ? truncate(sub.progress, MAX_DETAIL)
        : truncate(`booting · ${sub.goal}`, MAX_DETAIL);
    const elapsed = formatDuration(Math.max(0, now - sub.startedAt));
    // Cost chip: a 6-cent precision dollar amount when the
    // child has reported any spend. Suppressed at 0 so test
    // fixtures (zero-cost mock providers) and free-tier runs
    // don't render an always-zero ornament.
    const costChip = sub.liveCostUsd > 0 ? ` · $${sub.liveCostUsd.toFixed(4)}` : '';
    // `▸ task <name>` is the title; `· <detail> · <elapsed>
    // [· $X.XXXX]` is the secondary chrome. Color split keeps
    // the operator's eye on the live verb (`running echo`)
    // rather than the header word.
    // No paint() on the head: the `paint` palette is alert-class
    // (error/warn/success/secondary/etc.) — primary content is
    // plain text. Secondary tail keeps the chrome dimmer than the
    // verb so the operator scans the row's "name + activity".
    const head = `  ${glyph} task ${sub.name}`;
    const tail = paint(caps, 'secondary', ` · ${detail} · ${elapsed}${costChip}`);
    out.push(`${head}${tail}`);
  }
  return out;
};
