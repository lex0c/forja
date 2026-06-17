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

import wrapAnsi from 'wrap-ansi';
import type { DiffLine } from '../../diff/line-diff.ts';
import { SAFE_ONE_LINE_MAX, sanitizeOneLineForDisplay } from '../../sanitize/ansi.ts';
import type { PermanentItem } from '../state.ts';
import { type Capabilities, paint, paintMulti, reverse } from '../term.ts';
import { shortToolName, toolNoun } from '../tool-vocab.ts';
import { shortenCwd } from './cwd.ts';
import { formatChipDuration, formatCoarseDuration } from './duration.ts';
import { frameWidth, padFrame } from './frame.ts';
import { ellipsisGlyph, subContentConnector, treeBranchConnector } from './glyphs.ts';
import { renderMarkdown } from './markdown.ts';
import { visualWidth } from './width.ts';

// Card-head glyph (UI.md §4.10.5). One glyph for all statuses;
// status is communicated by the verb ('Failed' vs the per-tool
// finalVerb) plus color (error / denied / dim). The filled `●`
// landed with the slice-1 card restyle — it gives the head a
// visible anchor so a stack of cards reads as discrete blocks.
// ASCII keeps `*`; `●` has no reliable dumb-terminal equivalent.
const CHIP_FINAL_GLYPH = { unicode: '●', ascii: '*' } as const;
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

// Cap on subject rows under a `tool-end-batch` head. Above it the
// body shows MAX-1 subjects and folds the rest into a `… +N more`
// tail — a large batch must not bury the scrollback. The body
// therefore never exceeds MAX_BATCH_SUBJECTS rows.
const MAX_BATCH_SUBJECTS = 5;

// Cap on output rows under an operator `!cmd` card before folding the
// rest into a `… +N more lines` tail — keeps a `!cat hugefile` from
// burying scrollback. Generous (it's the operator's own command, they
// asked for the output) but bounded.
const MAX_OPERATOR_BASH_LINES = 200;

// `… output truncated` hint line (slice 2). A tool that capped its
// own output gets one secondary line under the card body. The hint
// deliberately does NOT advertise `(ctrl+o to expand)`: that key is
// unwired (UI.md §4.10.5 defers the expansion panel to a later slice),
// and a hint promising an action that no-ops is dishonest — the same
// reasoning that kept the dead-key hint off the args chip (BACKLOG D90).
// Re-add the key cue when the expansion panel lands.
// Indented 3 cols so it lines up under the `└─ ` connector's
// content, reading as a footnote of the card rather than a sibling.
const truncationHint = (caps: Capabilities, indent: string): string =>
  paint(caps, 'secondary', `${indent}   ${ellipsisGlyph(caps)} output truncated`);

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
      const tail = dur !== undefined ? ` ${formatCoarseDuration(dur)}` : '';
      const verb = (() => {
        switch (item.reason) {
          case 'done':
            return dur !== undefined ? `Cogitated for ${formatCoarseDuration(dur)}` : 'Cogitated.';
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
      // Three stacked lines: `<app> <version>`, `<model> · effort <level>`,
      // and `<cwd>`. The model + effort identity sits right under the version
      // (moved here FROM the footer chips, which no longer carry the model) so
      // the operator confirms what's loaded at a glance on boot. The env
      // (flags / meta) block stays dropped — low-signal at boot — but
      // `item.env` still flows into the PermanentItem for NDJSON / audit.
      //
      // The affirmative "✓ sandbox enforcement active" line was dropped
      // from the banner — boot greenlight noise the operator doesn't act
      // on. `item.sandboxActive` still flows into the PermanentItem for
      // NDJSON / audit consumers; the NON-active sandbox states (no-tool /
      // operator-override / degraded passthrough) still surface on the
      // warn/error channels, since those ARE warnings.
      const versionDisplay = item.version.startsWith('v') ? item.version : `v${item.version}`;
      const identity =
        item.effort !== undefined ? `${item.model} · effort ${item.effort}` : item.model;
      const lines = [
        `${paint(caps, 'bold', item.app)} ${paint(caps, 'secondary', versionDisplay)}`,
        paint(caps, 'secondary', identity),
        paint(caps, 'secondary', shortenCwd(item.cwd, item.home ?? '', caps)),
      ];
      // Isolation-profile line — only when active. `warn` (yellow), like the
      // sandbox-warning channel: a standing flag that this run writes to an
      // isolated `forja-<profile>` namespace, not the operator's real state.
      if (item.profile !== undefined && item.profile !== null) {
        lines.push(paint(caps, 'warn', `profile: ${item.profile} (isolated namespace)`));
      }
      return lines.map(padFrame);
    }
    case 'user-submit': {
      // UI.md §4.10.8 — inverse bar acts as a structural divider in
      // scrollback (rolling back, the bars locate turns without
      // inventing headings). Unlike the rest of the frame (§6.3), this
      // bar goes edge-to-edge from col 0: no FRAME_MARGIN outside the
      // SGR 7 wrap, padded internally to the full `cols` so the inverse
      // spans the whole width — like the input box, it's a focal band,
      // not indented content.
      //
      // Leading blank line per UI.md §6.3 ("1 blank line entre blocos
      // permanentes") — separates the new turn from whatever came
      // before (previous turn's `Done.`, the welcome banner, an
      // error). Combined with session-footer's leading blank, the
      // turn rhythm becomes `Done. → blank → > prompt → content`,
      // which scans cleanly when the operator scrolls.
      const prefixed = item.text.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`));
      const innerWidth = caps.cols;
      const bars = prefixed.map((line) => {
        // padEnd pads code units; for plain ASCII text that matches
        // visual columns. CJK / emoji content would over-pad —
        // accept the small inconsistency until visualWidth-aware
        // padding lands (no producer emits multi-col text today).
        const padded = line + ' '.repeat(Math.max(0, innerWidth - visualWidth(line)));
        return reverse(padded);
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
      //
      // The prose is GitHub-flavored Markdown — `renderMarkdown`
      // parses and walks it (`render/markdown.ts`). Streaming still
      // shows plain text; the block settles into Markdown here, at
      // turn end.
      if (item.text.length === 0) return [];
      return ['', ...renderMarkdown(item.text, caps)].map(padFrame);
    }
    case 'tool-end': {
      // UI.md §4.10.5 — card head: glyph + status-aware verb + a
      // trailing `[duration]` metric field. `● <verb>  [<dur>]` for
      // top-level chips, `  |_ <verb>  [<dur>]` for nested chips
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
      const headRaw = `${indent}${glyph} ${verb}`;
      // `denied` takes the `error` tone too — a blocked call didn't
      // run, which reads as a failure; the verb ('Denied' vs 'Failed')
      // is what tells the two apart.
      const headTone = item.status === 'error' || item.status === 'denied' ? 'error' : 'dim';
      // The duration is meta — always `secondary`, never the head's
      // status color (a slow error shouldn't paint its `[Xms]` red).
      const metric = paint(caps, 'secondary', `  [${formatChipDuration(item.durationMs)}]`);
      // A non-zero exit code — the command ran but failed on its own
      // terms. `warn`, not `error`: exit ≠ 0 is also the normal "no
      // match" of grep or a failed `test`, so it flags, not alarms.
      const exitMark =
        item.exitCode !== undefined ? paint(caps, 'warn', `  exit ${item.exitCode}`) : '';
      // Diff counts (write/edit): +added in success tone, -removed in error
      // tone — a GitHub-style summary. ASCII signs so they read on non-unicode
      // terminals too. Rendered on the FILE-PATH (sub-content) line, not the
      // head: it sits right next to the path it describes, and keeps the head a
      // clean `verb [Xms]`. Empty when there's no diff.
      const counts =
        item.diff !== undefined
          ? `  ${paint(caps, 'success', `+${item.diff.added}`)} ${paint(caps, 'error', `-${item.diff.removed}`)}`
          : '';
      const head = `${paint(caps, headTone, headRaw)}${exitMark}${metric}`;
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
      // subject (some tools have no obvious one — todo_create / todo_list).
      // For denied, the subject is replaced by the policy reason if
      // surfaced via summary; absent that, drop the connector.
      // For error, the subject (path / command) is preserved AND
      // the summary (failure reason) is appended as `subject:
      // summary` on the same line — operators get both the target
      // and the cause without scrolling. When only one of subject /
      // summary is present, the line falls back to that single
      // value so a tool with no vocab subject (todo_create) still
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
        // Counts ride here, after the path, in their own green/red — so the
        // subject stays secondary while `+N -M` keeps its semantic color.
        // For write/edit (diff present) the subText IS the changed file path,
        // so bold it as the card's anchor (still secondary-toned); other
        // subjects (bash command, error reason) stay plain secondary. The
        // connector stays non-bold so only the path itself is emphasized.
        const subjectPainted =
          item.diff !== undefined
            ? `${paint(caps, 'secondary', `${indent}${sub}`)}${paintMulti(caps, ['secondary', 'bold'], subText)}`
            : paint(caps, 'secondary', `${indent}${sub}${subText}`);
        lines.push(`${subjectPainted}${counts}`);
      } else if (counts !== '') {
        // Diff but no vocab subject (shouldn't happen for write/edit, which
        // always carry a path) — still surface the counts under the connector.
        lines.push(`${paint(caps, 'secondary', `${indent}${sub}`)}${counts.trimStart()}`);
      }
      // Diff snippet (write/edit): the first changed region under the
      // card — add in success tone, del in error tone, context dim. Each
      // line is sanitized (file content is untrusted: strip ANSI/control
      // and cap width) so it can't hijack the terminal.
      if (item.diff !== undefined) {
        // Line-number gutter: new-file number for surviving/added lines,
        // old-file for deletions (`newLine ?? oldLine`). Right-aligned to the
        // widest number so the `│` rail lines up. The NUMBER takes the line's
        // own tone (add green / del red / ctx dim) so it reads as part of the
        // change; only the `│` rail stays `secondary` (grey) as a neutral
        // divider between gutter and content. Width 0 (no gutter) when no line
        // carries a number — hand-built diffs / older fixtures render as before.
        const displayNo = (dl: DiffLine): number | undefined => dl.newLine ?? dl.oldLine;
        const gutterDigits = item.diff.snippet.reduce((w, dl) => {
          const n = displayNo(dl);
          return n !== undefined ? Math.max(w, String(n).length) : w;
        }, 0);
        const rail = caps.unicode ? '│' : '|';
        // Shrink the content cap by the gutter so a numbered line is never
        // longer than the unnumbered one was (gutter = digits + " │ ").
        const contentMax = Math.max(
          0,
          SAFE_ONE_LINE_MAX - (gutterDigits > 0 ? gutterDigits + 3 : 0),
        );
        for (const dl of item.diff.snippet) {
          const tone = dl.type === 'add' ? 'success' : dl.type === 'del' ? 'error' : 'dim';
          const mark = dl.type === 'add' ? '+' : dl.type === 'del' ? '-' : ' ';
          const n = displayNo(dl);
          // Number in the line's tone; rail in `secondary` (neutral divider).
          const gutter =
            gutterDigits > 0
              ? `${paint(caps, tone, (n !== undefined ? String(n) : '').padStart(gutterDigits))}${paint(caps, 'secondary', ` ${rail} `)}`
              : '';
          const body = paint(
            caps,
            tone,
            `${mark} ${sanitizeOneLineForDisplay(dl.text, contentMax)}`,
          );
          lines.push(`${indent}  ${gutter}${body}`);
        }
        if (item.diff.hiddenChanges > 0) {
          lines.push(
            paint(caps, 'dim', `${indent}  … +${item.diff.hiddenChanges} more changed lines`),
          );
        }
      }
      if (item.outputTruncated === true) lines.push(truncationHint(caps, indent));
      // Top-level chip: only the head hangs in the gutter — the `● ` prefix
      // is exactly the frame-margin width, so dropping the margin on the head
      // lands the verb back at col 2, with the glyph poking out at col 0 as a
      // structural anchor (like the user-submit bar). Sub-content keeps the
      // margin so subjects/diffs stay indented under the verb. Nested chips
      // keep the margin throughout — their indent is the attribution signal.
      // Head is at index 1 (after the leading blank).
      return nested ? lines.map(padFrame) : lines.map((l, i) => (i === 1 ? l : padFrame(l)));
    }
    case 'tool-end-batch': {
      // Coalesced summary of N consecutive same-tool tool-end items.
      // Same card-head contract as `tool-end`: status palette (dim /
      // error / warn), nested glyph + indent when `parentId` is set.
      // The body lists each child's subject as a tree — `├─` for the
      // mid rows, `└─` for the last — capped at MAX_BATCH_SUBJECTS so
      // a large batch can't bury the scrollback.
      const nested = item.parentId !== undefined;
      const glyph = nested
        ? CHIP_NESTED_GLYPH
        : caps.unicode
          ? CHIP_FINAL_GLYPH.unicode
          : CHIP_FINAL_GLYPH.ascii;
      const indent = nested ? CHIP_NESTED_INDENT : '';
      const verb = finalVerbFor(item.status, item.verb);
      // `denied` takes the `error` tone too — a blocked call didn't
      // run, which reads as a failure; the verb ('Denied' vs 'Failed')
      // is what tells the two apart.
      const headTone = item.status === 'error' || item.status === 'denied' ? 'error' : 'dim';
      const metric = paint(caps, 'secondary', `  [${formatChipDuration(item.totalDurationMs)}]`);
      // Bold the count inside the headline verb ("Executed **6**
      // commands", "Read **6** files", …) so the batch size pops out of
      // the dim head — it's the one number that tells the operator how
      // much a fold is hiding. The count stays in the head tone (dim /
      // error), just gains weight, via `paintMulti` so a single reset
      // wraps tone+bold (nested `paint` would double-emit `\x1b[0m`).
      // Only `done`-status headlines carry the count — `finalVerbFor`
      // collapses error/denied to bare 'Failed' / 'Denied' (no number),
      // so `indexOf` misses and the head paints whole, unbolded.
      const countStr = String(item.count);
      const countAt = verb.indexOf(countStr);
      const head =
        countAt < 0
          ? `${paint(caps, headTone, `${indent}${glyph} ${verb}`)}${metric}`
          : paint(caps, headTone, `${indent}${glyph} ${verb.slice(0, countAt)}`) +
            paintMulti(caps, [headTone, 'bold'], countStr) +
            paint(caps, headTone, verb.slice(countAt + countStr.length)) +
            metric;
      // Same leading-blank rule as tool-end: top-level chips get a
      // separator, nested ones stay tight under their owner.
      const lines = nested ? [head] : ['', head];
      // Subject tree under the head. Connectors align at the head's
      // glyph column (`indent`) — `├─` while the tree is open, `└─`
      // on the closing row. Over the cap, the body shows
      // MAX_BATCH_SUBJECTS - 1 subjects and folds the rest into a
      // `└─ … +N more` tail; the body never exceeds MAX rows. Empty
      // `subjects` (every child had a null subject, filtered upstream
      // in flushPendingToolEndBatch) leaves the head standing alone
      // — the count in the verb carries it.
      const branch = treeBranchConnector(caps);
      const last = subContentConnector(caps);
      const ellipsis = ellipsisGlyph(caps);
      const overflow = item.subjects.length > MAX_BATCH_SUBJECTS;
      const visible = item.subjects.slice(
        0,
        overflow ? MAX_BATCH_SUBJECTS - 1 : item.subjects.length,
      );
      const bodyLines = visible.map((subj, i) => {
        const isLastRow = !overflow && i === visible.length - 1;
        return paint(caps, 'secondary', `${indent}${isLastRow ? last : branch}${subj}`);
      });
      lines.push(...bodyLines);
      if (overflow) {
        const moreN = item.subjects.length - visible.length;
        lines.push(paint(caps, 'secondary', `${indent}${last}${ellipsis} +${moreN} more`));
      }
      if (item.outputTruncated === true) lines.push(truncationHint(caps, indent));
      // Same gutter-glyph rule as the single tool-end chip: only the head
      // (index 1, after the leading blank) drops the margin so the glyph hangs
      // at col 0; the subject tree stays indented. See that case for why.
      return nested ? lines.map(padFrame) : lines.map((l, i) => (i === 1 ? l : padFrame(l)));
    }
    case 'error':
      // Leading blank — alerts are top-level "session" blocks and
      // deserve emphasis; whatever printed above shouldn't bleed
      // into the alert visually.
      return ['', paint(caps, 'error', `error: ${item.message}`)].map(padFrame);
    case 'warn':
      return ['', paint(caps, 'warn', `warn: ${item.message}`)].map(padFrame);
    case 'info': {
      // Default (plain — no SGR): info isn't an alert; coloring it
      // would collide with the warn channel's "actually pay
      // attention" signal (lock conflicts, compaction notices,
      // etc.). `tone: 'secondary'` opts a line into the greyscale
      // meta channel (SGR 90) — for visual scaffolding that should
      // recede rather than read as content (the `--resume`
      // history/new-turns anchor). Same leading blank as error/warn
      // so consecutive info lines from different sources don't blob
      // together.
      // Multi-line messages (e.g. the working-state panel) render one framed
      // line per `\n` so every row keeps the frame margin — a single padFrame
      // over an embedded newline would indent only the first line. Single-line
      // is the common case (`split` returns one entry).
      const painted = item.message
        .split('\n')
        .map((l) => (item.tone === 'secondary' ? paint(caps, 'secondary', l) : l));
      // `header` (when present) labels the block in the DEFAULT tone above the
      // toned body — so a secondary-toned block can still carry a visible title
      // (see InfoEvent.header; used by the working-state panel).
      const headerLines = item.header !== undefined ? [item.header] : [];
      return ['', ...headerLines, ...painted].map(padFrame);
    }
    case 'reasoning': {
      // Extended-thinking / reasoning block: the whole thing is the model's
      // scratch work, not the answer, so it sits in the secondary (grey meta)
      // channel and recedes — the `reasoning:` label is grey too, just BOLD to
      // anchor the block (bold + secondary stacked via paintMulti). One framed
      // line per `\n`; body already capped at flush (state.ts capReasoning).
      const header = paintMulti(caps, ['bold', 'secondary'], 'reasoning:');
      // Soft-wrap to the frame's inner width so a single long reasoning line
      // (OpenAI summaries are often one paragraph) can't overflow `cols` and
      // break the 2sp margin. `hard` also breaks an unbroken token. Text is
      // already ANSI-stripped on entry (harness-adapter thinking_delta), so the
      // wrap operates on clean content. Blank lines (part separators) survive.
      const width = frameWidth(caps);
      const body = item.text
        .split('\n')
        .flatMap((l) => (width > 0 ? wrapAnsi(l, width, { hard: true }).split('\n') : [l]))
        .map((l) => paint(caps, 'secondary', l));
      return ['', header, ...body].map(padFrame);
    }
    case 'operator-bash': {
      // Operator `!cmd` result (shell-style escape — ran as the operator's
      // own shell, not the agent). Head: `! <command>` dim, a warn
      // `exit N` when it failed, and a secondary `[dur]` — same metric
      // grammar as a tool-end chip. Output is shown VERBATIM below (the
      // operator's own shell output; we don't recolor it), capped at
      // MAX_OPERATOR_BASH_LINES with a `… +N more lines` tail so a
      // `!cat hugefile` can't bury scrollback. The output arrives
      // ALREADY sanitized at intake (repl's runOperatorBash, per
      // SECURITY_GUIDELINE §3.2): ANSI + control bytes stripped and CR
      // normalized to LF, so rendering it verbatim can't hijack terminal
      // state or overwrite the frame margin — only TAB/LF survive.
      const failed = item.exitCode !== 0;
      // Flatten a multi-line command (the editor accepts `\`+Enter /
      // Shift+Enter newlines) to a single display line: a raw `\n` in
      // the head would spill onto an unprefixed scrollback row and push
      // the `exit N` / `[dur]` metrics below the command text. The
      // command RAN with its real newlines; only the card label
      // collapses them.
      const commandLabel = item.command.replace(/\s*\n\s*/g, ' ');
      const head =
        paint(caps, 'dim', `! ${commandLabel}`) +
        (failed ? paint(caps, 'warn', `  exit ${item.exitCode}`) : '') +
        paint(caps, 'secondary', `  [${formatChipDuration(item.durationMs)}]`);
      const lines = ['', head];
      const trimmed = item.output.replace(/\n+$/, '');
      if (trimmed.length > 0) {
        const outLines = trimmed.split('\n');
        if (outLines.length > MAX_OPERATOR_BASH_LINES) {
          const shown = outLines.slice(0, MAX_OPERATOR_BASH_LINES - 1);
          lines.push(...shown);
          lines.push(
            paint(
              caps,
              'secondary',
              `${ellipsisGlyph(caps)} +${outLines.length - shown.length} more lines`,
            ),
          );
        } else {
          lines.push(...outLines);
        }
      }
      return lines.map(padFrame);
    }
    case 'recap-terse': {
      // RECAP §3.3 auto-display: bold "recap:" prefix + the line
      // body in `secondary` (SGR 90 = bright-grey, the same
      // greyscale meta channel used for the turn-end "Cogitated
      // for X" marker). Bold is layered with secondary via
      // `paintMulti` so a single trailing reset wraps both
      // attributes — nesting `paint(paint(...))` would double-emit
      // resets that some terminals re-process as a flicker.
      const prefix = paintMulti(caps, ['secondary', 'bold'], 'recap:');
      const body = paint(caps, 'secondary', ` ${item.message}`);
      return ['', `${prefix}${body}`].map(padFrame);
    }
    case 'subagent_group_header': {
      // `● Subagents` group title over a burst of finishing subagents.
      // Carries the same `●` chip glyph as a tool/subagent head, but at
      // COL 0 (NOT frame-padded) so it reads as the parent of the `  ● …`
      // blocks below, which keep their 2-space margin and indent under it.
      // Plain (default/white); a leading blank separates the group from
      // prior scrollback.
      const headGlyph = caps.unicode ? CHIP_FINAL_GLYPH.unicode : CHIP_FINAL_GLYPH.ascii;
      return ['', `${headGlyph} Subagents`];
    }
    case 'subagent_summary': {
      // One-line scrollback summary for a subagent run. Mirrors
      // tool-end's compact shape: `● task <name> Done <summary>  [1m2s]`
      // for success, `● task <name> <Verb> <summary>  [1m2s]` for
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
      const color = item.status === 'done' ? 'secondary' : 'error';
      // Header: `● <name> · <verb> · N tools · <dur>[ · $X.XX]`. The child's
      // own `summary` (often a verbose first-person preamble) is NOT shown
      // here — the actual answer is already relayed in the parent's
      // response text, so echoing a truncated preview in the block is just
      // noise. The block is the "what it DID" record (verb + tool trail +
      // cost); the content lives in the parent's reply.
      const segs = [`${glyph} ${item.name}`, verb];
      if (item.toolTotal > 0) segs.push(`${item.toolTotal} tool${item.toolTotal === 1 ? '' : 's'}`);
      segs.push(formatChipDuration(item.durationMs));
      if (item.costUsd > 0) segs.push(`$${formatDollars(item.costUsd)}`);
      const lines = [padFrame(paint(caps, color, segs.join(' · ')))];
      // Aggregated-by-type trail: one line per tool type the child used,
      // sorted desc by count upstream (`├ read 38 files`, `└ git 4 reads`).
      // The child's tools no longer streamed live, so this is the record
      // of what it did.
      const counts = item.toolCounts;
      for (let i = 0; i < counts.length; i++) {
        const entry = counts[i] as readonly [string, number];
        const connector =
          i === counts.length - 1 ? subContentConnector(caps) : treeBranchConnector(caps);
        const trail = `  ${connector}${shortToolName(entry[0])} ${entry[1]} ${toolNoun(entry[0])}`;
        lines.push(padFrame(paint(caps, color, trail)));
      }
      return lines;
    }
  }
};
