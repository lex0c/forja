import { describe, expect, test } from 'bun:test';
import { createPlainRenderer } from '../../src/cli/output/plain.ts';

interface Capture {
  out: string[];
  err: string[];
}

const make = (useColor = false, maxArgsChars = 200) => {
  const cap: Capture = { out: [], err: [] };
  const renderer = createPlainRenderer({
    useColor,
    out: (s) => cap.out.push(s),
    err: (s) => cap.err.push(s),
    maxArgsChars,
  });
  return { renderer, cap };
};

describe('plain renderer', () => {
  test('session_start writes a marker to stderr', () => {
    const { renderer, cap } = make();
    renderer.onEvent({ type: 'session_start', sessionId: 'abc' });
    expect(cap.err.join('')).toContain('[session abc]');
    expect(cap.out).toEqual([]);
  });

  test('text_delta writes assistant text to stdout', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'hello world' },
    });
    expect(cap.out.join('')).toBe('hello world');
    expect(cap.err.join('')).toBe('');
  });

  test('non-text provider events go nowhere (start/stop are markers, not text)', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'provider_event',
      event: { kind: 'start', message_id: 'm1' },
    });
    renderer.onEvent({
      type: 'provider_event',
      event: { kind: 'stop', reason: 'end_turn' },
    });
    expect(cap.out).toEqual([]);
    expect(cap.err).toEqual([]);
  });

  test('stream errors surface to stderr', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'provider_event',
      event: {
        kind: 'error',
        code: 'tool_args_parse_error',
        message: 'bad json',
        retryable: false,
      },
    });
    expect(cap.err.join('')).toContain('[stream error]');
    expect(cap.err.join('')).toContain('bad json');
  });

  test('tool_invoking writes to stderr with truncated args', () => {
    const { renderer, cap } = make(false, 30);
    renderer.onEvent({
      type: 'tool_invoking',
      toolUseId: 'tu1',
      toolName: 'read_file',
      args: { path: '/very/long/path/that/will/be/truncated/eventually.ts' },
    });
    const out = cap.err.join('');
    expect(out).toContain('→ read_file');
    expect(out).toContain('...');
    expect(out).toContain('more chars');
  });

  test('tool_finished shows ✓ on success and ✗ on failure', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'tool_finished',
      toolUseId: 'tu1',
      toolName: 'echo',
      failed: false,
      durationMs: 12,
    });
    renderer.onEvent({
      type: 'tool_finished',
      toolUseId: 'tu2',
      toolName: 'bash',
      failed: true,
      durationMs: 34,
    });
    const all = cap.err.join('');
    expect(all).toContain('✓ echo');
    expect(all).toContain('✗ bash');
    expect(all).toContain('(12ms)');
    expect(all).toContain('(34ms)');
  });

  test('tool_decided shows deny reason and confirm prompt', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'tool_decided',
      toolUseId: 'tu1',
      decision: { kind: 'deny', reason: 'no rule matched' },
    });
    renderer.onEvent({
      type: 'tool_decided',
      toolUseId: 'tu2',
      decision: { kind: 'confirm', confirmCause: 'policy', prompt: 'Run bash: rm -rf /' },
    });
    const all = cap.err.join('');
    expect(all).toContain('denied: no rule matched');
    expect(all).toContain('confirm required: Run bash: rm -rf /');
  });

  test('tool_decided.allow does NOT print anything (silent on the happy path)', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'tool_decided',
      toolUseId: 'tu1',
      decision: { kind: 'allow', reason: 'matched' },
    });
    expect(cap.err).toEqual([]);
  });

  test('session_finished prints summary with status, steps, duration', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'session_finished',
      result: {
        status: 'done',
        reason: 'done',
        sessionId: 's',
        steps: 3,
        durationMs: 1234,
        usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
        costUsd: 0.0123,
        usageComplete: true,
      },
    });
    const out = cap.err.join('');
    expect(out).toContain('[done/done]');
    expect(out).toContain('3 steps');
    expect(out).toContain('1234ms');
    expect(out).toContain('tokens 100/50');
    expect(out).toContain('$0.0123');
  });

  test('session_finished includes detail when present', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'session_finished',
      result: {
        status: 'error',
        reason: 'maxToolErrors',
        sessionId: 's',
        steps: 1,
        durationMs: 50,
        usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        costUsd: 0,
        usageComplete: true,
        detail: '5 consecutive tool errors',
      },
    });
    const out = cap.err.join('');
    expect(out).toContain('[error/maxToolErrors]');
    expect(out).toContain('5 consecutive tool errors');
  });

  test('session_finished cost format uses 4 decimals under $1, 3 between $1-$100, 2 above', () => {
    const sample = (costUsd: number): string => {
      const { renderer, cap } = make();
      renderer.onEvent({
        type: 'session_finished',
        result: {
          status: 'done',
          reason: 'done',
          sessionId: 's',
          steps: 1,
          durationMs: 1,
          usage: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
          costUsd,
          usageComplete: true,
        },
      });
      return cap.err.join('');
    };
    expect(sample(0.0009)).toContain('$0.0009');
    expect(sample(2.5)).toContain('$2.500');
    expect(sample(2.5)).not.toContain('$2.5000');
    expect(sample(150)).toContain('$150.00');
    expect(sample(150)).not.toContain('$150.000');
  });

  test('session_finished marks tokens and cost as estimates when usageComplete is false', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'session_finished',
      result: {
        status: 'done',
        reason: 'done',
        sessionId: 's',
        steps: 2,
        durationMs: 10,
        usage: { input: 100, output: 20, cache_read: 0, cache_creation: 0 },
        costUsd: 0.005,
        usageComplete: false,
      },
    });
    const out = cap.err.join('');
    // Tilde prefix on both fields signals "lower bound" — at least one
    // turn this session produced output without reporting telemetry.
    expect(out).toContain('tokens ~100/20');
    expect(out).toContain('~$0.0050');
  });

  test('session_finished shows cache columns when non-zero', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'session_finished',
      result: {
        status: 'done',
        reason: 'done',
        sessionId: 's',
        steps: 1,
        durationMs: 10,
        usage: { input: 200, output: 80, cache_read: 1000, cache_creation: 500 },
        costUsd: 0.005,
        usageComplete: true,
      },
    });
    const out = cap.err.join('');
    // One cache form: the compact `cache <read>/<creation>` segment (also the SWE-bench runner's
    // parseMetrics capture). No separate human `(cache_r …, cache_w …)` parenthetical.
    expect(out).toContain('cache 1000/500');
    expect(out).not.toContain('cache_r');
    expect(out).not.toContain('cache_w');
  });

  test('session_finished omits the cache segment when zero', () => {
    // Gated to non-zero — OpenAI / Gemini / ollama have no cache, no clutter. parseMetrics defaults
    // both to 0 when the segment is absent (the same value), so the machine reads it correctly too.
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'session_finished',
      result: {
        status: 'done',
        reason: 'done',
        sessionId: 's',
        steps: 1,
        durationMs: 10,
        usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
        costUsd: 0.0123,
        usageComplete: true,
      },
    });
    const out = cap.err.join('');
    expect(out).not.toContain('cache');
  });

  test('inserts newline between text streaming and tool indicator', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'reasoning...' },
    });
    renderer.onEvent({
      type: 'tool_invoking',
      toolUseId: 'tu1',
      toolName: 'read_file',
      args: {},
    });
    // The inserted newline lands on stdout (it terminates the text line);
    // the tool indicator is on stderr.
    expect(cap.out.join('')).toBe('reasoning...\n');
    expect(cap.err.join('')).toContain('→ read_file');
  });

  test('flush emits trailing newline if streaming text never had one', () => {
    const { renderer, cap } = make();
    renderer.onEvent({
      type: 'provider_event',
      event: { kind: 'text_delta', text: 'no newline at end' },
    });
    renderer.flush();
    expect(cap.out.join('')).toBe('no newline at end\n');
  });

  test('useColor:false produces no ANSI escapes', () => {
    const { renderer, cap } = make(false);
    renderer.onEvent({ type: 'session_start', sessionId: 'abc' });
    renderer.onEvent({
      type: 'tool_finished',
      toolUseId: 'tu1',
      toolName: 'echo',
      failed: false,
      durationMs: 1,
    });
    const all = cap.err.join('');
    // ANSI escapes contain `\x1b[` — assert none present.
    expect(all.includes('\x1b[')).toBe(false);
  });

  test('useColor:true emits ANSI escapes around marks', () => {
    const { renderer, cap } = make(true);
    renderer.onEvent({
      type: 'tool_finished',
      toolUseId: 'tu1',
      toolName: 'echo',
      failed: false,
      durationMs: 1,
    });
    expect(cap.err.join('').includes('\x1b[')).toBe(true);
  });
});
