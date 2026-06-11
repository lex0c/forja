import { describe, expect, test } from 'bun:test';
import type { ReadOutputInput, ReadOutputResult } from '../../src/bg/manager.ts';
import { type BgSummaryReader, buildBgSummary } from '../../src/cli/bg-summary.ts';

// A stub manager that serves a fixed byte buffer per stream, honoring the
// byte-offset contract of the real readOutput: `sinceStdout` is a BYTE
// offset, the returned `stdout` is the UTF-8 decode of the requested byte
// window, `stdoutCursor` is the byte offset just past it, and
// `stdoutPending` is the bytes still beyond. This lets us reproduce the
// multibyte head bug deterministically with no live process.
const stubReader = (stdout: Buffer, stderr: Buffer): BgSummaryReader => {
  const slice = (
    buf: Buffer,
    since: number,
    maxBytes: number,
  ): { text: string; cursor: number; pending: number } => {
    const start = Math.min(since, buf.length);
    const end = Math.min(start + maxBytes, buf.length);
    return {
      text: buf.subarray(start, end).toString('utf8'),
      cursor: end,
      pending: buf.length - end,
    };
  };
  return {
    readOutput: async (_id: string, opts: ReadOutputInput = {}): Promise<ReadOutputResult> => {
      const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
      const o = slice(stdout, opts.sinceStdout ?? 0, max);
      const e = slice(stderr, opts.sinceStderr ?? 0, max);
      return {
        stdout: o.text,
        stderr: e.text,
        stdoutCursor: o.cursor,
        stderrCursor: e.cursor,
        stdoutPending: o.pending,
        stderrPending: e.pending,
        status: 'exited',
        exitCode: 1,
      };
    },
  };
};

describe('buildBgSummary', () => {
  test('silent process yields no summary', async () => {
    const s = await buildBgSummary(stubReader(Buffer.from(''), Buffer.from('')), 'p');
    expect(s).toBeUndefined();
  });

  test('short output is returned whole', async () => {
    const s = await buildBgSummary(stubReader(Buffer.from('all good\n'), Buffer.from('')), 'p');
    expect(s).toBe('all good');
  });

  test('multibyte UTF-8 in the head does not truncate the tail before EOF', async () => {
    // Regression: totals were computed from `stdout.length` (JS code units),
    // but the offsets are bytes. A head full of multibyte chars undercounts
    // the byte total, anchoring the tail read early so the final lines —
    // the failure tail bg_done exists to surface — get dropped.
    //
    // Build a stream well past HEAD+TAIL (500+2000) so the head/elision/tail
    // path runs, front-loaded with 3-byte chars so code units ≠ bytes, and
    // ending in a unique marker that MUST appear.
    const head = '€'.repeat(400); // 1200 bytes, 400 code units
    const filler = 'x'.repeat(3000);
    const marker = 'FINAL-FAILURE-LINE';
    const buf = Buffer.from(`${head}${filler}\n${marker}`, 'utf8');
    const s = await buildBgSummary(stubReader(buf, Buffer.from('')), 'p');
    expect(s).toBeDefined();
    // The real EOF marker survives — the bug would have cut it off.
    expect(s).toContain(marker);
    // And the head is still present (never drop the start).
    expect(s).toContain('€');
    // The elision marker reflects a BYTE count, not code units.
    expect(s).toMatch(/bytes elided/);
  });

  test('stderr is labeled and combined after stdout', async () => {
    const s = await buildBgSummary(
      stubReader(Buffer.from('out line\n'), Buffer.from('err line\n')),
      'p',
    );
    expect(s).toBe('out line\n[stderr]\nerr line');
  });
});
