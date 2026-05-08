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
import { FRAME_MARGIN, frameWidth, padFrame } from './frame.ts';
import { subContentConnector } from './glyphs.ts';
import { visualWidth } from './width.ts';

// Final-state chip prefix glyph (UI.md §4.10.5). One glyph for all
// statuses; status is communicated by the verb ('Failed' vs the
// per-tool finalVerb) plus color (error / dim).
const CHIP_FINAL_GLYPH = { unicode: '·', ascii: '*' } as const;
// Glyph used in place of CHIP_FINAL_GLYPH when a tool-end has a
// `parentId` — visually marks the chip as nested inside its
// parent (today: a subagent run). `|_` reads as "branch from
// the line above" in both Unicode and ASCII; using a separate
// distinct sequence rather than a fancy box-drawing arrow keeps
// the visual clear under both `caps.unicode === true` (most
// terminals) and the ASCII fallback (CI logs, dumb terminals,
// `--no-unicode`).
const CHIP_NESTED_GLYPH = '|_';
// Indent prefix for nested chips and their sub-content, applied
// AFTER frame padding — keeps the chip glyph aligned with the
// frame's left rail and just shifts the content. Two spaces is
// the minimum visual nesting that survives narrow terminals;
// deeper nesting (subagent inside subagent) is uncommon enough
// that we don't add a per-level multiplier yet.
const CHIP_NESTED_INDENT = '  ';

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
  // Frame margin (UI.md §6.3): every permanent kind emits 2sp-padded
  // lines. The `user-submit` reverse bar handles its own padding
  // internally (the prefix sits OUTSIDE the SGR 7 wrap so the inverse
  // bar starts at col 2 rather than col 0); every other kind builds
  // raw content and lets the bottom switch arm apply `padFrame` to
  // each line. Banner's blank-line separators get padded too — `'  '`
  // still reads as a blank line visually but keeps cursor accounting
  // honest if the renderer ever uses these for column math.
  switch (item.kind) {
    case 'session-footer': {
      // UI.md §3.2 turn-end marker: blank line + the terminal verb.
      // The verb shape depends on `reason`:
      //
      //   done       → `Cogitated for 1m23s`     (or `Cogitated for 450ms` short turns)
      //   aborted    → `Aborted (soft) after 12s` / `Aborted (hard) after 12s`
      //                or `Aborted after 12s` if cause unknown
      //   error      → `Failed after 12s`        (operator-speak)
      //   maxSteps   → `Stopped (max steps) after 1m23s`
      //   maxCostUsd → `Stopped (max cost) after 1m23s`
      //   unknown    → `Capitalized after Xs`
      //
      // Duration is plumbed from `HarnessResult.durationMs` via the
      // session:end event. When it's missing (legacy / replay), we
      // fall back to the bare verb (`Cogitated.`, `Aborted.` etc)
      // so the marker stays grammatical.
      //
      // §4.10.11 anti-vocabulario: `Done!` (with !) is banido. The
      // `Cogitated for X` shape avoids the static "Done." while
      // surfacing useful info — wall-clock time the model spent on
      // the turn — which the operator likely wants to see anyway.
      const dur = item.durationMs;
      const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        const totalSec = Math.round(ms / 1000);
        if (totalSec < 60) return `${totalSec}s`;
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return s === 0 ? `${m}m` : `${m}m${s}s`;
      };
      const tail = dur !== undefined ? ` ${formatDuration(dur)}` : '';
      const verb = (() => {
        switch (item.reason) {
          case 'done':
            return dur !== undefined ? `Cogitated for ${formatDuration(dur)}` : 'Cogitated.';
          case 'aborted': {
            const cause = item.abortCause !== undefined ? ` (${item.abortCause})` : '';
            return dur !== undefined ? `Aborted${cause} after${tail}` : `Aborted${cause}.`;
          }
          case 'error':
            return dur !== undefined ? `Failed after${tail}` : 'Failed.';
          case 'maxSteps':
            return dur !== undefined ? `Stopped (max steps) after${tail}` : 'Stopped (max steps).';
          case 'maxCostUsd':
            return dur !== undefined ? `Stopped (max cost) after${tail}` : 'Stopped (max cost).';
          default: {
            // Unknown reason — capitalize first letter; append
            // duration if known, period otherwise.
            const cap = `${item.reason.charAt(0).toUpperCase()}${item.reason.slice(1)}`;
            return dur !== undefined ? `${cap} after${tail}` : `${cap}.`;
          }
        }
      })();
      // Marker rendered in `secondary` (UI.md §6.1) — visible grey,
      // distinct from primary content but not a content-class color.
      // Using `dim` (SGR 2) here was invisible on many xterm
      // configs, defeating the point.
      return ['', paint(caps, 'secondary', verb)].map(padFrame);
    }
    case 'session-banner': {
      // UI.md §4.10.9. Three blocks separated by blank lines:
      //   1. title (bold) — `forja v0.0.0`
      //   2. identity (dim) — model+limits, cwd
      //   3. env — mixed: `✓ name` (success) for flags, `key: value` (dim)
      //      for meta, joined by ` · ` (dim). Omitted when env is empty.
      // Version is prefixed with `v` (semver convention) regardless of
      // what the producer sent — operators read `v0.0.0` as a version
      // string at a glance, `0.0.0` as ambiguous.
      const sep = caps.unicode ? '·' : '-';
      const checkGlyph = caps.unicode ? '✓' : '*';
      const versionDisplay = item.version.startsWith('v') ? item.version : `v${item.version}`;
      const lines: string[] = [
        paint(caps, 'bold', `${item.app} ${versionDisplay}`),
        '',
        paint(
          caps,
          'dim',
          `${item.model} ${sep} ${item.contextWindow.toLocaleString()} ctx ${sep} max ${item.maxOutputTokens} out`,
        ),
        paint(caps, 'dim', item.cwd),
      ];
      if (item.env.length > 0) {
        const dimSep = paint(caps, 'dim', ` ${sep} `);
        const parts = item.env.map((e) => {
          if (e.kind === 'flag') {
            const tail = e.count !== undefined ? ` (${e.count})` : '';
            return paint(caps, 'success', `${checkGlyph} ${e.name}${tail}`);
          }
          return paint(caps, 'dim', `${e.key}: ${e.value}`);
        });
        lines.push('');
        lines.push(parts.join(dimSep));
      }
      return lines.map(padFrame);
    }
    case 'user-submit': {
      // UI.md §4.10.8 — inverse bar acts as a structural divider in
      // scrollback (rolling back, the bars locate turns without
      // inventing headings). The frame margin (§6.3) sits OUTSIDE the
      // SGR 7 wrap: 2sp of normal-bg space, then the inverse bar
      // from col 2 to col cols-1. The bar is padded internally to
      // `cols - 2` so the inverse extends to the right edge.
      //
      // Leading blank line per UI.md §6.3 ("1 blank line entre blocos
      // permanentes") — separates the new turn from whatever came
      // before (previous turn's `Done.`, the welcome banner, an
      // error). Combined with session-footer's leading blank, the
      // turn rhythm becomes `Done. → blank → > prompt → content`,
      // which scans cleanly when the operator scrolls.
      const prefixed = item.text.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
      const innerWidth = frameWidth(caps);
      const bars = prefixed.map((line) => {
        // padEnd pads code units; for plain ASCII text that matches
        // visual columns. CJK / emoji content would over-pad —
        // accept the small inconsistency until visualWidth-aware
        // padding lands (no producer emits multi-col text today).
        const padded = line + ' '.repeat(Math.max(0, innerWidth - visualWidth(line)));
        return `${FRAME_MARGIN}${reverse(padded)}`;
      });
      return [padFrame(''), ...bars];
    }
    case 'assistant': {
      // The assistant block is just the AI's prose, prepended with a
      // blank line (UI.md §6.3) so it visually separates from the
      // user-submit bar / tool blocks above. The legacy
      // `· Generated N tokens in Xs` chip header was removed —
      // duration is in the turn-end marker (`Cogitated for Xs`) and
      // token count lives in the footer's right column. A per-turn
      // chip header just duplicates info the operator already sees
      // and clutters scrollback.
      //
      // Empty text → emit nothing. Tool-only turns (model produced
      // tool_use blocks but no prose) used to surface a header-only
      // chip for cost visibility; the footer cost counter and the
      // tool-end chips already cover that signal.
      if (item.text.length === 0) return [];
      return ['', ...item.text.split('\n')].map(padFrame);
    }
    case 'tool-end': {
      // UI.md §4.10.5 — chip glyph + verb (status-aware) + duration.
      // `· <verb> in <duration>` for top-level chips,
      // `  |_ <verb> in <duration>` for nested chips
      // (`item.parentId` set, today: tool fired inside a subagent).
      // Color: dim for done, error palette for failed, warn palette
      // for denied — applied identically regardless of nesting.
      const nested = item.parentId !== undefined;
      const glyph = nested
        ? CHIP_NESTED_GLYPH
        : caps.unicode
          ? CHIP_FINAL_GLYPH.unicode
          : CHIP_FINAL_GLYPH.ascii;
      // Indent prefix only on nested chips. Applied BEFORE the
      // glyph so the visual hierarchy reads "[indent][nest-glyph]
      // verb" — the indent IS the attribution signal.
      const indent = nested ? CHIP_NESTED_INDENT : '';
      const verb = finalVerbFor(item.status, item.verb);
      const ms =
        item.durationMs >= 1000
          ? `${(item.durationMs / 1000).toFixed(1)}s`
          : `${item.durationMs}ms`;
      const headRaw = `${indent}${glyph} ${verb} in ${ms}`;
      const head =
        item.status === 'error'
          ? paint(caps, 'error', headRaw)
          : item.status === 'denied'
            ? paint(caps, 'warn', headRaw)
            : paint(caps, 'dim', headRaw);
      // Leading blank (UI.md §6.3) — each tool finalization is its
      // own "session" block; the operator scrolls and sees each tool
      // (chip + sub-content) as a self-contained unit instead of a
      // wall of contiguous chips. Sub-content stays tight under the
      // chip (it's the chip's "subsession"). Nested chips skip the
      // leading blank so a burst of subagent-owned chips reads as a
      // visually contiguous block under their owner instead of a
      // gap-separated list — matches the "child of the line above"
      // affordance that `|_` already signals.
      const lines = nested ? [head] : ['', head];
      // Sub-content (subject) under the connector. Skipped when no
      // subject (some tools have no obvious one — todo_write etc.).
      // For denied, the subject is replaced by the policy reason if
      // surfaced via summary; absent that, drop the connector.
      // For error, the subject (path / command) is preserved AND
      // the summary (failure reason) is appended as `subject:
      // summary` on the same line — operators get both the target
      // and the cause without scrolling. When only one of subject /
      // summary is present, the line falls back to that single
      // value so a tool with no vocab subject (todo_write) still
      // surfaces its error reason.
      // Treat empty-string subject as absent so a misbehaving producer
      // doesn't render a bare `└─ ` line.
      const sub = subContentConnector(caps);
      const hasSubject = item.subject !== null && item.subject !== '';
      const subText =
        item.status === 'denied' && item.summary !== undefined
          ? item.summary
          : item.status === 'error' && item.summary !== undefined
            ? hasSubject
              ? `${item.subject}: ${item.summary}`
              : item.summary
            : hasSubject
              ? item.subject
              : (item.summary ?? null);
      // Sub-content uses `secondary` (SGR 90 bright-black, visibly
      // grey) rather than `dim` (SGR 2 faint, frequently invisible
      // in default xterm/i3 setups) so the operator can actually
      // read the subject — same rationale as the session-footer
      // `Cogitated for X` marker (UI.md §6.1). Nested chips indent
      // the sub-content too so the connector lines under the nest
      // glyph stay visually tied to the nested chip head.
      if (subText !== null) {
        lines.push(paint(caps, 'secondary', `${indent}${sub}${subText}`));
      }
      return lines.map(padFrame);
    }
    case 'tool-end-batch': {
      // Coalesced summary of N consecutive same-tool tool-end items
      // (slice 3). Same chip-shape contract as `tool-end`: status
      // palette (dim / error / warn), nested glyph + indent when
      // `parentId` is set. The continuation here lists EACH
      // child's subject under `|_` instead of the single `└─ subject`
      // that a non-batched chip emits.
      const nested = item.parentId !== undefined;
      const glyph = nested
        ? CHIP_NESTED_GLYPH
        : caps.unicode
          ? CHIP_FINAL_GLYPH.unicode
          : CHIP_FINAL_GLYPH.ascii;
      const indent = nested ? CHIP_NESTED_INDENT : '';
      const verb = finalVerbFor(item.status, item.verb);
      const ms =
        item.totalDurationMs >= 1000
          ? `${(item.totalDurationMs / 1000).toFixed(1)}s`
          : `${item.totalDurationMs}ms`;
      const headRaw = `${indent}${glyph} ${verb} in ${ms}`;
      const head =
        item.status === 'error'
          ? paint(caps, 'error', headRaw)
          : item.status === 'denied'
            ? paint(caps, 'warn', headRaw)
            : paint(caps, 'dim', headRaw);
      // Same leading-blank rule as tool-end: top-level chips get a
      // separator, nested ones stay tight under their owner.
      const lines = nested ? [head] : ['', head];
      // Each child's subject as a `|_` continuation. Reuse the
      // nest glyph for the per-child connector — visually consistent
      // with slice 2's nested chip glyph and explicitly different
      // from the `└─ ` subject connector (which marks "this is the
      // chip's subject", not "this is a sibling child of the chip
      // above"). Empty subjects are filtered upstream in
      // flushPendingToolEndBatch — we don't need to skip here.
      for (const subj of item.subjects) {
        // Continuation lines indent ONE deeper than the head when
        // the chip itself is already nested under a subagent —
        // visual hierarchy reads "subagent > batch summary >
        // child detail".
        const childIndent = nested ? `${CHIP_NESTED_INDENT}${CHIP_NESTED_INDENT}` : '  ';
        lines.push(paint(caps, 'secondary', `${childIndent}${CHIP_NESTED_GLYPH} ${subj}`));
      }
      return lines.map(padFrame);
    }
    case 'error':
      // Leading blank — alerts are top-level "session" blocks and
      // deserve emphasis; whatever printed above shouldn't bleed
      // into the alert visually.
      return ['', paint(caps, 'error', `error: ${item.message}`)].map(padFrame);
    case 'warn':
      return ['', paint(caps, 'warn', `warn: ${item.message}`)].map(padFrame);
    case 'info':
      // Plain — no SGR. Info isn't an alert; coloring it would
      // collide with the warn channel's "actually pay attention"
      // signal (lock conflicts, compaction notices, etc.). Same
      // leading blank as error/warn so consecutive info lines from
      // different sources don't blob together.
      return ['', item.message].map(padFrame);
    case 'subagent_summary': {
      // One-line scrollback summary for a subagent run. Mirrors
      // tool-end's compact shape: `· task <name> Done <summary> in 1m2s`
      // for success, `· task <name> <Verb> <summary> in 1m2s` for
      // non-success — Verb is chosen from status + reason so the
      // operator can read the cause at a glance instead of a flat
      // "Failed" that hides whether the cap blew, the user
      // pressed Esc, or the provider crashed.
      //
      // Verb mapping:
      //   done                                       → Done
      //   exhausted + reason=maxCostUsd              → Exhausted (cost cap, $X)
      //   exhausted + reason=maxSteps                → Exhausted (step cap)
      //   exhausted + reason=maxToolErrors           → Exhausted (tool errors)
      //   interrupted + reason=aborted               → Aborted
      //   interrupted + reason=maxWallClockMs        → Timed out
      //   interrupted (other)                        → Interrupted
      //   error + reason=degenerate_loop             → Error (loop)
      //   error + reason=providerError               → Error (provider)
      //   error (other)                              → Error
      //   anything unrecognized                      → Failed (last-resort)
      const glyph = caps.unicode ? CHIP_FINAL_GLYPH.unicode : CHIP_FINAL_GLYPH.ascii;
      // Half-up rounding to two decimals. `(0.585).toFixed(2)`
      // returns "0.58" in V8 / JavaScriptCore because 0.585 has
      // an inexact IEEE-754 representation that rounds DOWN under
      // toFixed's banker-style behavior. Operator sees an
      // off-by-cent that doesn't match the reason ("hit $0.59
      // cap, displayed $0.58"). Math.round + scale + toFixed is
      // deterministic and rounds half-up like the operator
      // expects.
      const formatDollars = (usd: number): string => (Math.round(usd * 100) / 100).toFixed(2);
      const verbFor = (
        status: typeof item.status,
        reason: string | undefined,
        costUsd: number,
      ): string => {
        if (status === 'done') return 'Done';
        if (status === 'exhausted') {
          if (reason === 'maxCostUsd') return `Exhausted (cost cap, $${formatDollars(costUsd)})`;
          if (reason === 'maxSteps') return 'Exhausted (step cap)';
          if (reason === 'maxToolErrors') return 'Exhausted (tool errors)';
          return 'Exhausted';
        }
        if (status === 'interrupted') {
          if (reason === 'aborted') return 'Aborted';
          if (reason === 'maxWallClockMs') return 'Timed out';
          return 'Interrupted';
        }
        if (status === 'error') {
          if (reason === 'degenerate_loop') return 'Error (loop)';
          if (reason === 'providerError') return 'Error (provider)';
          if (reason === 'stepStalled') return 'Error (no progress)';
          return 'Error';
        }
        return 'Failed';
      };
      const verb = verbFor(item.status, item.reason, item.costUsd);
      const formatDuration = (ms: number): string => {
        if (ms < 1000) return `${ms}ms`;
        const totalSec = Math.round(ms / 1000);
        if (totalSec < 60) return `${totalSec}s`;
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return s === 0 ? `${m}m` : `${m}m${s}s`;
      };
      // Truncate the summary so a verbose child doesn't blow out
      // the line — the renderer's frame width is the operator's
      // budget, not the producer's.
      const maxSummary = 80;
      const trimmedSummary = item.summary.replace(/\s+/g, ' ').trim();
      const summary =
        trimmedSummary.length > maxSummary
          ? `${trimmedSummary.slice(0, maxSummary - 1)}…`
          : trimmedSummary;
      const head = `${glyph} task ${item.name} ${verb}`;
      const tail = ` in ${formatDuration(item.durationMs)}`;
      const body = summary.length > 0 ? ` ${summary}` : '';
      const line =
        item.status === 'done'
          ? paint(caps, 'secondary', `${head}${body}${tail}`)
          : paint(caps, 'error', `${head}${body}${tail}`);
      return [padFrame(line)];
    }
  }
};
