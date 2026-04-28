import type { HarnessEvent } from '../../harness/index.ts';
import type { OutputRenderer } from './types.ts';

// Plain-text renderer for one-shot mode. Streams assistant text to stdout
// as it arrives; tool calls and lifecycle events go to stderr so stdout
// stays a clean transcript of what the model said.
//
// ANSI used sparingly and only when stdout/stderr is a TTY. NO_COLOR is
// honored. Spec §2.3: capability detection.
export interface PlainRendererOptions {
  // Use ANSI colors for tool indicators and the final summary.
  useColor: boolean;
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';

const color = (enable: boolean, code: string, text: string): string =>
  enable ? `${code}${text}${RESET}` : text;

export const createPlainRenderer = (options: PlainRendererOptions): OutputRenderer => {
  const { useColor } = options;
  let needsLeadingNewline = false;

  const writeStderr = (s: string): void => {
    process.stderr.write(s);
  };

  return {
    onEvent(event: HarnessEvent) {
      switch (event.type) {
        case 'session_start':
          writeStderr(color(useColor, DIM, `[session ${event.sessionId}]\n`));
          break;
        case 'step_start':
          if (event.stepN > 1) writeStderr(color(useColor, DIM, `\n[step ${event.stepN}]\n`));
          break;
        case 'provider_event':
          if (event.event.kind === 'text_delta') {
            process.stdout.write(event.event.text);
            needsLeadingNewline = true;
          }
          break;
        case 'tool_invoking': {
          if (needsLeadingNewline) {
            process.stdout.write('\n');
            needsLeadingNewline = false;
          }
          const args = JSON.stringify(event.args);
          writeStderr(
            color(useColor, BLUE, `→ ${event.toolName}`) + color(useColor, DIM, ` ${args}\n`),
          );
          break;
        }
        case 'tool_decided':
          if (event.decision.kind === 'deny') {
            writeStderr(color(useColor, RED, `  ✗ denied: ${event.decision.reason}\n`));
          } else if (event.decision.kind === 'confirm') {
            writeStderr(
              color(useColor, YELLOW, `  ⚠ confirm required: ${event.decision.prompt}\n`),
            );
          }
          break;
        case 'tool_finished': {
          const mark = event.failed ? color(useColor, RED, '  ✗') : color(useColor, GREEN, '  ✓');
          const ms = color(useColor, DIM, `(${event.durationMs}ms)`);
          writeStderr(`${mark} ${event.toolName} ${ms}\n`);
          break;
        }
        case 'session_finished': {
          if (needsLeadingNewline) {
            process.stdout.write('\n');
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
          writeStderr(`\n${colored} ${r.steps} steps · ${r.durationMs}ms${detail}\n`);
          break;
        }
      }
    },
    flush() {
      if (needsLeadingNewline) {
        process.stdout.write('\n');
        needsLeadingNewline = false;
      }
    },
  };
};
