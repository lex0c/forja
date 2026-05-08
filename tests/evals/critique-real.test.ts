import { describe, expect, test } from 'bun:test';
import { runCritiqueRealEval } from '../../src/evals/critique-real.ts';

// Smoke tests for the real-model critique eval runner. Unit-shaped
// (do NOT make live API calls) — coverage focuses on:
//   - ENV gating: no API key → exit 0 with skip note.
//   - Arg parsing: bad --threshold / --max-overhead / --model
//     surface as exit code 2.
//   - Module loads cleanly (catches import errors that would only
//     surface at first invocation).
//
// The actual model behavior is exercised by `bun run eval:critique`
// in environments with ANTHROPIC_API_KEY set — out of scope for
// unit tests because: (a) flaky / slow, (b) costs real money,
// (c) the deterministic suite at tests/critique/eval.test.ts
// already pins engine behavior against fixtures.

const collectIo = () => {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    out: (line: string) => outLines.push(line),
    err: (line: string) => errLines.push(line),
    outLines,
    errLines,
  };
};

describe('critique-real runner — ENV gating', () => {
  test('no ANTHROPIC_API_KEY → exit 0 with skip note', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval([], {
      out: io.out,
      err: io.err,
      apiKey: undefined,
    });
    expect(exitCode).toBe(0);
    expect(io.outLines.join('\n')).toContain('SKIP');
    expect(io.outLines.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  test('empty-string ANTHROPIC_API_KEY also gates as skip', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval([], {
      out: io.out,
      err: io.err,
      apiKey: '',
    });
    expect(exitCode).toBe(0);
    expect(io.outLines.join('\n')).toContain('SKIP');
  });
});

describe('critique-real runner — arg parsing', () => {
  test('unknown flag fails with exit 2 and a usage hint on stderr', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--bogus'], {
      out: io.out,
      err: io.err,
      apiKey: 'sk-fake-but-not-empty',
    });
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain("unknown arg '--bogus'");
  });

  test('invalid --threshold fails with exit 2', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--threshold', '2.5'], {
      out: io.out,
      err: io.err,
      apiKey: 'sk-fake',
    });
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain('--threshold');
  });

  test('invalid --max-overhead fails with exit 2', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--max-overhead', '-100'], {
      out: io.out,
      err: io.err,
      apiKey: 'sk-fake',
    });
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain('--max-overhead');
  });

  test('unknown model fails with exit 2 and lists known ids', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(
      ['--model', 'anthropic/imaginary-future-model'],
      {
        out: io.out,
        err: io.err,
        apiKey: 'sk-fake',
      },
    );
    expect(exitCode).toBe(2);
    const errOut = io.errLines.join('\n');
    expect(errOut).toContain('unknown model');
    // Lists at least one real Anthropic model so the operator
    // can pick the right id.
    expect(errOut).toContain('anthropic/');
  });
});
