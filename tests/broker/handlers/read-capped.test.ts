import { describe, expect, test } from 'bun:test';
import { readCapped } from '../../../src/broker/index.ts';

const streamFrom = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('readCapped — basic', () => {
  test('drains a stream that fits under the cap, no truncation footer', async () => {
    const stream = streamFrom(enc('hello\nworld\n'));
    const r = await readCapped(stream, 1024);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('hello\nworld\n');
  });

  test('empty stream returns empty text + truncated:false', async () => {
    const stream = streamFrom();
    const r = await readCapped(stream, 1024);
    expect(r).toEqual({ text: '', truncated: false });
  });

  test('joins multiple chunks into one string', async () => {
    const stream = streamFrom(enc('one '), enc('two '), enc('three'));
    const r = await readCapped(stream, 1024);
    expect(r.text).toBe('one two three');
    expect(r.truncated).toBe(false);
  });
});

describe('readCapped — truncation', () => {
  test('appends truncation footer when total exceeds cap', async () => {
    // cap=10; total bytes=20 → 10 omitted
    const stream = streamFrom(enc('0123456789ABCDEFGHIJ'));
    const r = await readCapped(stream, 10);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('0123456789\n[... truncated; 10 bytes omitted]');
  });

  test('past-cap chunks are drained (memory bounded) and counted', async () => {
    const stream = streamFrom(enc('first8b!'), enc('cap-hit'), enc('past'));
    // cap=8 → first chunk fits exactly, subsequent chunks (7 + 4 = 11) are dropped
    const r = await readCapped(stream, 8);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('first8b!\n[... truncated; 11 bytes omitted]');
  });

  test('partial chunk at the cap boundary: prefix kept, suffix counted', async () => {
    const stream = streamFrom(enc('abcde'), enc('fghij'));
    // cap=7 → first chunk fits (5 acc), second chunk only 2 of 5 fit
    const r = await readCapped(stream, 7);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('abcdefg\n[... truncated; 3 bytes omitted]');
  });
});

describe('readCapped — UTF-8 boundary safety', () => {
  test('multi-byte sequence straddling chunk boundary decodes correctly', async () => {
    // The em-dash '—' is 3 bytes in UTF-8 (E2 80 94). Split it across
    // two chunks: first chunk ends with E2, second starts with 80 94.
    // Without stream-aware decoding, the first chunk produces U+FFFD;
    // with stream:true the decoder buffers until the sequence completes.
    const dash = enc('—'); // 3 bytes
    const stream = streamFrom(dash.subarray(0, 1), dash.subarray(1));
    const r = await readCapped(stream, 1024);
    expect(r.text).toBe('—');
  });

  test('handles non-ASCII content fully within cap', async () => {
    const stream = streamFrom(enc('café 日本語'));
    const r = await readCapped(stream, 1024);
    expect(r.text).toBe('café 日本語');
    expect(r.truncated).toBe(false);
  });
});

describe('readCapped — stopSignal', () => {
  test('aborted stopSignal cancels the reader, draining what landed before abort', async () => {
    // Stream that emits one chunk then idles — reader will block on the
    // second read() until the abort fires + cancel propagates.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc('initial-chunk'));
        // Deliberately don't close or enqueue more.
      },
      cancel() {
        cancelled = true;
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const r = await readCapped(stream, 1024, ac.signal);
    expect(cancelled).toBe(true);
    expect(r.text).toBe('initial-chunk');
    expect(r.truncated).toBe(false);
  });

  test('pre-aborted stopSignal cancels before any read', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(enc('x'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await readCapped(stream, 1024, ac.signal);
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(1);
  });
});
