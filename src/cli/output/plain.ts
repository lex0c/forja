import type { HarnessEvent } from '../../harness/index.ts';
import type { OutputRenderer } from './types.ts';

// Plain-text renderer for one-shot mode. Streams assistant text to stdout
// as it arrives; tool calls and lifecycle events go to stderr so stdout
// stays a clean transcript of what the model said.
//
// ANSI used sparingly and only when the target is a TTY. NO_COLOR honored.
// Stream writers are injectable for testability.
export interface PlainRendererOptions {
  // Use ANSI colors for tool indicators and the final summary.
  useColor: boolean;
  // Sinks for assistant text vs everything else. Default to process
  // streams in production; tests inject string-collecting fakes.
  out?: (s: string) => void;
  err?: (s: string) => void;
  // Cap on how many chars of tool args to show inline. Larger is
  // truncated with `...`. Defaults to 200 — enough to read the path
  // for `read_file({path: ...})`, short enough to keep `write_file`
  // with 10KB of content from scrolling the terminal.
  maxArgsChars?: number;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';

const color = (enable: boolean, code: string, text: string): string =>
  enable ? `${code}${text}${RESET}` : text;

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}... (${s.length - max} more chars)`;

export const createPlainRenderer = (options: PlainRendererOptions): OutputRenderer => {
  const { useColor } = options;
  const out = options.out ?? ((s: string) => process.stdout.write(s));
  const err = options.err ?? ((s: string) => process.stderr.write(s));
  const maxArgsChars = options.maxArgsChars ?? 200;
  let needsLeadingNewline = false;

  return {
    onEvent(event: HarnessEvent) {
      switch (event.type) {
        case 'session_start':
          err(color(useColor, DIM, `[session ${event.sessionId}]\n`));
          break;
        case 'step_start':
          if (event.stepN > 1) err(color(useColor, DIM, `\n[step ${event.stepN}]\n`));
          break;
        case 'provider_event':
          if (event.event.kind === 'text_delta') {
            out(event.event.text);
            needsLeadingNewline = true;
          } else if (event.event.kind === 'error') {
            err(
              color(
                useColor,
                RED,
                `\n[stream error] ${event.event.code}: ${event.event.message}\n`,
              ),
            );
          }
          break;
        case 'tool_invoking': {
          if (needsLeadingNewline) {
            out('\n');
            needsLeadingNewline = false;
          }
          const args = truncate(JSON.stringify(event.args), maxArgsChars);
          err(color(useColor, BLUE, `→ ${event.toolName}`) + color(useColor, DIM, ` ${args}\n`));
          break;
        }
        case 'tool_decided':
          if (event.decision.kind === 'deny') {
            err(color(useColor, RED, `  ✗ denied: ${event.decision.reason}\n`));
          } else if (event.decision.kind === 'confirm') {
            err(color(useColor, YELLOW, `  ⚠ confirm required: ${event.decision.prompt}\n`));
          }
          break;
        case 'tool_finished': {
          const mark = event.failed ? color(useColor, RED, '  ✗') : color(useColor, GREEN, '  ✓');
          const ms = color(useColor, DIM, `(${event.durationMs}ms)`);
          err(`${mark} ${event.toolName} ${ms}\n`);
          break;
        }
        case 'session_finished': {
          if (needsLeadingNewline) {
            out('\n');
            needsLeadingNewline = false;
          }
          const r = event.result;
          const detail = r.detail !== undefined ? ` — ${r.detail}` : '';
          const tag = `[${r.status}/${r.reason}]`;
          const colored =
            r.status === 'done'
              ? color(useColor, GREEN, tag)
              : r.status === 'interrupted'
                ? color(useColor, YELLOW, tag)
                : color(useColor, RED, tag);
          err(`\n${colored} ${r.steps} steps · ${r.durationMs}ms${detail}\n`);
          break;
        }
      }
    },
    flush() {
      if (needsLeadingNewline) {
        out('\n');
        needsLeadingNewline = false;
      }
    },
  };
};
