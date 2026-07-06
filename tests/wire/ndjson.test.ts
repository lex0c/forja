import { describe, expect, test } from 'bun:test';
import { createLineFramer } from '../../src/wire/ndjson.ts';

const enc = new TextEncoder();

describe('createLineFramer line cap', () => {
  test('drops an over-cap COMPLETE line (arriving with its \\n in one chunk), not just partials', () => {
    // The bug: a record that arrives WITH its trailing `\n` in a single chunk was
    // sliced + emitted before the cap check ran, so the cap only bounded
    // unterminated floods — a peer could hand a giant line straight to the parser.
    const lines: string[] = [];
    const overflows: number[] = [];
    const framer = createLineFramer((l) => lines.push(l), {
      lineCap: 16,
      onOverflow: (n) => overflows.push(n),
    });
    framer.push(enc.encode(`${'A'.repeat(40)}\nok\n`));
    expect(lines).toEqual(['ok']); // the over-cap line is dropped, the small one lands
    expect(overflows).toEqual([40]); // diagnostic fired with the dropped length
  });

  test('an over-cap complete line does NOT force a resync — the next line in the same chunk still frames', () => {
    // The complete-line drop already has the boundary, so (unlike the unterminated
    // case) it must NOT enter resync, which would swallow the following good line.
    const lines: string[] = [];
    const framer = createLineFramer((l) => lines.push(l), { lineCap: 8 });
    framer.push(enc.encode(`${'X'.repeat(20)}\ngood\n`));
    expect(lines).toEqual(['good']);
  });

  test('still drops an unterminated over-cap partial + resyncs on the next \\n', () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const framer = createLineFramer((l) => lines.push(l), {
      lineCap: 16,
      onOverflow: (n) => overflows.push(n),
    });
    framer.push(enc.encode('B'.repeat(40))); // no `\n` → partial flood
    framer.push(enc.encode('\nrecovered\n')); // boundary + a fresh line
    expect(lines).toEqual(['recovered']);
    expect(overflows.length).toBe(1);
  });

  test('frames normal in-cap lines unchanged, including boundaries split across chunks', () => {
    const lines: string[] = [];
    const framer = createLineFramer((l) => lines.push(l), { lineCap: 1024 });
    framer.push(enc.encode('hel'));
    framer.push(enc.encode('lo\nwor'));
    framer.push(enc.encode('ld\n'));
    expect(lines).toEqual(['hello', 'world']);
  });

  test('a max-length line exactly at the cap is emitted; one over is dropped', () => {
    const lines: string[] = [];
    const overflows: number[] = [];
    const framer = createLineFramer((l) => lines.push(l), {
      lineCap: 10,
      onOverflow: (n) => overflows.push(n),
    });
    framer.push(enc.encode(`${'a'.repeat(10)}\n`)); // exactly cap → kept
    framer.push(enc.encode(`${'b'.repeat(11)}\n`)); // one over → dropped
    expect(lines).toEqual(['a'.repeat(10)]);
    expect(overflows).toEqual([11]);
  });
});
