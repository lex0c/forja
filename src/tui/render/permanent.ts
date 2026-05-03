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
import { type Capabilities, paint, reverse } from '../term.ts';
import { subContentConnector } from './glyphs.ts';
import { visualWidth } from './width.ts';

// Final-state chip prefix glyph (UI.md §4.10.5). One glyph for all
// statuses; status is communicated by the verb ('Failed' vs the
// per-tool finalVerb) plus color (error / dim).
const CHIP_FINAL_GLYPH = { unicode: '·', ascii: '*' } as const;

// Override the per-tool finalVerb when the tool didn't succeed.
// Spec UI.md §4.10.5: error → `Exited 1 in 2.1s`, denied → `Denied`.
// We use generic verbs because the harness doesn't surface exit
// codes / failure detail through HarnessEvent today; adapter ships
// the framework, the rich detail lands when tool results expose it.
const finalVerbFor = (status: 'done' | 'error' | 'denied', vocabVerb: string): string => {
  if (status === 'denied') return 'Denied';
  if (status === 'error') return 'Failed';
  return vocabVerb;
};

export const formatPermanent = (item: PermanentItem, caps: Capabilities): string[] => {
  switch (item.kind) {
    case 'session-header':
      return [`── session ${item.sessionId} · ${item.profile} · ${item.model} ──`];
    case 'session-footer': {
      // 1.g.3 closes D171: when the run aborted, append the cause
      // discriminator so the operator sees `aborted (soft)` vs
      // `aborted (hard)` in scrollback. The producer guarantees
      // abortCause is only set when reason === 'aborted', but the
      // render branches defensively on both — a stray abortCause on
      // a non-abort reason shouldn't render misleading text.
      const cause =
        item.reason === 'aborted' && item.abortCause !== undefined ? ` (${item.abortCause})` : '';
      return [`── session end · ${item.reason}${cause} ──`];
    }
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
      // UI.md §4.10.8 — full-width inverse bar acts as a structural
      // divider in scrollback (rolling back, the bars locate turns
      // without inventing headings). Each line is padded to the
      // terminal width then wrapped in SGR 7 so the inversion
      // extends edge-to-edge regardless of text length.
      const prefixed = item.text.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
      return prefixed.map((line) => {
        // padEnd pads code units; for plain ASCII text that matches
        // visual columns. CJK / emoji content would over-pad —
        // accept the small inconsistency until visualWidth-aware
        // padding lands (no producer emits multi-col text today).
        const padded = line + ' '.repeat(Math.max(0, caps.cols - visualWidth(line)));
        return reverse(padded);
      });
    }
    case 'assistant': {
      // Spec UI.md §4.10.5: final scrollback line is
      // `· Generated 234 tokens in 8.2s` above the assistant text.
      // Three modes:
      //   1. text + chip metadata → header line + text lines (standard turn).
      //   2. text + no metadata    → text only (headless replay / synthetic).
      //   3. empty text + metadata → header only (tool-only turn — model
      //      spent tokens generating tool_use blocks but no prose; the
      //      operator should still see the cost signal as a chip line).
      //   4. empty text + no metadata → nothing (degenerate; reducer
      //      should never emit this combo, but guard anyway).
      const hasMetadata = item.durationMs !== null || item.outputTokens !== null;
      if (item.text.length === 0 && !hasMetadata) return [];
      const textLines = item.text.length === 0 ? [] : item.text.split('\n');
      if (!hasMetadata) return textLines;
      const glyph = caps.unicode ? CHIP_FINAL_GLYPH.unicode : CHIP_FINAL_GLYPH.ascii;
      const ms =
        item.durationMs === null
          ? null
          : item.durationMs >= 1000
            ? `${(item.durationMs / 1000).toFixed(1)}s`
            : `${item.durationMs}ms`;
      // "Generated N tokens in Xs" / "Generated in Xs" / "Generated".
      // The bare "Generated" form should be unreachable today
      // (assistant:end always knows event.ts) but the conditional
      // structure stays explicit so a future producer that drops
      // duration on purpose doesn't render a syntax-broken header.
      const tokenClause = item.outputTokens === null ? '' : `${item.outputTokens} tokens`;
      const inClause = ms === null ? '' : `in ${ms}`;
      const tail = [tokenClause, inClause].filter((s) => s.length > 0).join(' ');
      const header = paint(caps, 'dim', `${glyph} Generated${tail.length > 0 ? ` ${tail}` : ''}`);
      return [header, ...textLines];
    }
    case 'tool-end': {
      // UI.md §4.10.5 — chip glyph + verb (status-aware) + duration.
      // `· <verb> in <duration>` for Unicode; '* <verb> in <duration>'
      // for ASCII. Color: dim for done, error palette for failed,
      // warn palette for denied.
      const glyph = caps.unicode ? CHIP_FINAL_GLYPH.unicode : CHIP_FINAL_GLYPH.ascii;
      const verb = finalVerbFor(item.status, item.verb);
      const ms =
        item.durationMs >= 1000
          ? `${(item.durationMs / 1000).toFixed(1)}s`
          : `${item.durationMs}ms`;
      const headRaw = `${glyph} ${verb} in ${ms}`;
      const head =
        item.status === 'error'
          ? paint(caps, 'error', headRaw)
          : item.status === 'denied'
            ? paint(caps, 'warn', headRaw)
            : paint(caps, 'dim', headRaw);
      const lines = [head];
      // Sub-content (subject) under the connector. Skipped when no
      // subject (some tools have no obvious one — todo_write etc.).
      // For denied, the subject is replaced by the policy reason if
      // surfaced via summary; absent that, drop the connector.
      // Treat empty-string subject as absent so a misbehaving producer
      // doesn't render a bare `└─ ` line.
      const sub = subContentConnector(caps);
      const subText =
        item.status === 'denied' && item.summary !== undefined
          ? item.summary
          : item.subject !== null && item.subject !== ''
            ? item.subject
            : (item.summary ?? null);
      if (subText !== null) lines.push(paint(caps, 'dim', `${sub}${subText}`));
      return lines;
    }
    case 'error':
      return [paint(caps, 'error', `error: ${item.message}`)];
    case 'warn':
      return [paint(caps, 'warn', `warn: ${item.message}`)];
    case 'info':
      // Plain — no SGR. Info isn't an alert; coloring it would
      // collide with the warn channel's "actually pay attention"
      // signal (lock conflicts, compaction notices, etc.).
      return [item.message];
  }
};
