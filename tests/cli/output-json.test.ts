import { describe, expect, test } from 'bun:test';
import { createJsonRenderer } from '../../src/cli/output/json.ts';
import type { HarnessEvent } from '../../src/harness/index.ts';

const make = () => {
  const lines: string[] = [];
  const renderer = createJsonRenderer({ out: (s) => lines.push(s) });
  return { renderer, lines };
};

describe('JSON renderer', () => {
  test('every event emits one NDJSON line ending in newline', () => {
    const { renderer, lines } = make();
    const events: HarnessEvent[] = [
      { type: 'session_start', sessionId: 'abc' },
      { type: 'step_start', stepN: 1 },
      {
        type: 'session_finished',
        result: { status: 'done', reason: 'done', sessionId: 'abc', steps: 1, durationMs: 5 },
      },
    ];
    for (const e of events) renderer.onEvent(e);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(line) as { type: string };
      expect(typeof parsed.type).toBe('string');
    }
  });

  test('preserves provider_event StreamEvent shape verbatim', () => {
    const { renderer, lines } = make();
    renderer.onEvent({
      type: 'provider_event',
      event: { kind: 'tool_use_stop', id: 'tu1', final_args: { path: '/x' } },
    });
    const parsed = JSON.parse(lines[0] ?? '{}') as {
      type: string;
      event: { kind: string; id: string; final_args: { path: string } };
    };
    expect(parsed.type).toBe('provider_event');
    expect(parsed.event.kind).toBe('tool_use_stop');
    expect(parsed.event.final_args.path).toBe('/x');
  });

  test('flush is a no-op (no trailing state)', () => {
    const { renderer, lines } = make();
    renderer.flush();
    expect(lines).toEqual([]);
  });
});
