// Tool card live render. Spec: UI.md §4.10.5 (operation chip, active state).
//
// Tool currently executing renders as the spinner + active verb +
// elapsed counter, with the subject under a `└─ ` connector. The
// chip uses the warn palette so it visually pops out of the dim
// baseline while the operation runs.
//
// Final state lives in `formatPermanent` — the chip collapses to
// dim, gets the per-tool past-tense verb, and joins scrollback.
// The streaming output preview (last few bytes of stdout) renders
// indented under the chip, separately from the subject line.

import type { ActiveTool } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';
import { formatChipDuration } from './duration.ts';
import { subContentConnector } from './glyphs.ts';

const SPINNER_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_ASCII = ['|', '/', '-', '\\'] as const;

const SPINNER_INTERVAL_UNICODE_MS = 80;
const SPINNER_INTERVAL_ASCII_MS = 100;

export const spinnerGlyph = (caps: Capabilities, now: number): string => {
  if (caps.unicode) {
    const idx = Math.floor(now / SPINNER_INTERVAL_UNICODE_MS) % SPINNER_UNICODE.length;
    return SPINNER_UNICODE[idx] ?? SPINNER_UNICODE[0];
  }
  const idx = Math.floor(now / SPINNER_INTERVAL_ASCII_MS) % SPINNER_ASCII.length;
  return SPINNER_ASCII[idx] ?? SPINNER_ASCII[0];
};

export const renderToolCardLive = (tool: ActiveTool, caps: Capabilities, now: number): string[] => {
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatChipDuration(now - tool.startedAt);
  const head = paint(caps, 'warn', `${spinner} ${tool.activeVerb}…  [${elapsed}]`);
  const lines: string[] = [head];

  // Sub-content: subject (per-tool extracted) under the shared
  // connector glyph. Skipped when the vocab entry has no subject for
  // this args shape (or a misbehaving producer emitted '').
  // `secondary` (SGR 90) instead of `dim` (SGR 2) so the subject is
  // actually readable in default terminals — see permanent.ts for
  // the matching choice on the finalized chip.
  if (tool.subject !== null && tool.subject !== '') {
    lines.push(paint(caps, 'secondary', `${subContentConnector(caps)}${tool.subject}`));
  }

  // Streaming output preview (separate from the subject line). Tree
  // glyphs distinguish "in-progress output" from the "subject" above.
  if (tool.preview.length > 0) {
    const branchMid = caps.unicode ? '├' : '+';
    const branchEnd = caps.unicode ? '└' : '\\';
    const preview = tool.preview.map((line, i, arr) => {
      const branch = i === arr.length - 1 ? branchEnd : branchMid;
      return paint(caps, 'dim', `  ${branch} ${line}`);
    });
    lines.push(...preview);
  }

  return lines;
};
