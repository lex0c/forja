// Permanent (scrollback) item formatter. Spec: UI.md §3, §4.1, §6.
//
// Sister of the live-region renderers in this directory. Where
// `status.ts` / `input.ts` / `tool-card.ts` produce lines that live
// in the redrawing bottom region, this one produces lines the
// renderer prints once and forgets — they become terminal scrollback.
//
// Single switch on `PermanentItem.kind`. Caps-aware: glyph (Unicode
// vs ASCII) and color (paint() no-ops when caps.color === 'none').
// The reducer in `state.ts` builds the `PermanentItem` records and
// never sees `caps`.

import type { PermanentItem } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';

// Glyph tables for `tool-end`. Two paths because the spec (UI.md §6.2)
// caps Forja's palette to Unicode when locale supports it, ASCII
// otherwise. 'denied' MUST differ from 'error' so users can tell
// "policy blocked me" from "tool crashed" at a glance.
const TOOL_END_GLYPHS = {
  unicode: { done: '✓', error: '✗', denied: '⚠' },
  ascii: { done: '*', error: 'x', denied: '!' },
} as const;

export const formatPermanent = (item: PermanentItem, caps: Capabilities): string[] => {
  switch (item.kind) {
    case 'session-header':
      return [`── session ${item.sessionId} · ${item.profile} · ${item.model} ──`];
    case 'session-footer':
      return [`── session end · ${item.reason} ──`];
    case 'session-banner': {
      // UI.md §4.10.9. Title bold, model/cwd/env dim. Empty env →
      // skip the line (producer signal of "nothing to summarize",
      // not "render empty bar").
      const sep = caps.unicode ? '·' : '-';
      const lines: string[] = [
        paint(caps, 'bold', `${item.app} ${item.version}`),
        paint(
          caps,
          'dim',
          `${item.model} ${sep} ${item.contextWindow.toLocaleString()} ctx ${sep} max ${item.maxOutputTokens} out`,
        ),
        paint(caps, 'dim', item.cwd),
      ];
      if (item.env.length > 0) {
        lines.push(
          paint(caps, 'dim', item.env.map((e) => `${e.key}: ${e.value}`).join(` ${sep} `)),
        );
      }
      return lines;
    }
    case 'user-submit': {
      // Echo the prompt with `> ` prefix on first line and 2-space
      // continuation indent on subsequent ones.
      return item.text.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
    }
    case 'assistant':
      return item.text.length > 0 ? item.text.split('\n') : [];
    case 'tool-end': {
      const glyph = TOOL_END_GLYPHS[caps.unicode ? 'unicode' : 'ascii'][item.status];
      const sep = caps.unicode ? '·' : '-';
      const ms =
        item.durationMs >= 1000
          ? `${(item.durationMs / 1000).toFixed(1)}s`
          : `${item.durationMs}ms`;
      const head = `${glyph} ${item.name} ${sep} ${item.args}    ${ms}`;
      return item.summary !== undefined ? [head, `  ${item.summary}`] : [head];
    }
    case 'error':
      return [paint(caps, 'error', `error: ${item.message}`)];
    case 'warn':
      return [paint(caps, 'warn', `warn: ${item.message}`)];
  }
};
