// Tool card live render. Spec: UI.md §4.1 (running form).
//
// Single tool currently executing renders as a head line with spinner
// + name + args + elapsed, optionally followed by indented preview
// lines pulled from the last bytes of the tool's stdout/stderr.
//
// Final ("done") form lives in `formatPermanent` — that one writes to
// scrollback once the tool finishes and gets out of the way. The
// running form is the live one: it stays in the bottom region and
// redraws on every frame.

import type { ActiveTool } from '../state.ts';
import { type Capabilities, paint } from '../term.ts';

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

const formatElapsed = (ms: number): string => {
  if (ms < 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const renderToolCardLive = (tool: ActiveTool, caps: Capabilities, now: number): string[] => {
  const sep = caps.unicode ? '·' : '-';
  const spinner = spinnerGlyph(caps, now);
  const elapsed = formatElapsed(now - tool.startedAt);
  const head = `${spinner} ${tool.name} ${sep} ${tool.args}    ${elapsed}`;

  if (tool.preview.length === 0) return [head];

  // Tree-style indent for preview lines. Last preview gets the
  // closing branch glyph; others get the mid-branch.
  const branchMid = caps.unicode ? '├' : '+';
  const branchEnd = caps.unicode ? '└' : '\\';
  const preview = tool.preview.map((line, i, arr) => {
    const branch = i === arr.length - 1 ? branchEnd : branchMid;
    return paint(caps, 'dim', `  ${branch} ${line}`);
  });

  return [head, ...preview];
};
