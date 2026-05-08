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

// Pre-baked envs for the model-aware credential gate. Cloud
// families want their own var; passing these directly lets each
// test target a specific gate path.
const ANTHROPIC_ENV: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'sk-fake' };
const OPENAI_ENV: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-fake' };
const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('critique-real runner — credential gate (model-aware)', () => {
  test('default model (anthropic) without ANTHROPIC_API_KEY → SKIP', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval([], {
      out: io.out,
      err: io.err,
      env: EMPTY_ENV,
    });
    expect(exitCode).toBe(0);
    expect(io.outLines.join('\n')).toContain('SKIP');
    // SKIP message names the missing var so the operator knows
    // what to set.
    expect(io.outLines.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  test('empty-string ANTHROPIC_API_KEY counts as missing', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval([], {
      out: io.out,
      err: io.err,
      env: { ANTHROPIC_API_KEY: '' },
    });
    expect(exitCode).toBe(0);
    expect(io.outLines.join('\n')).toContain('SKIP');
  });

  test('--model openai/... with OPENAI_API_KEY (no Anthropic) executes past the gate', async () => {
    // Regression: the previous shape skipped on missing
    // ANTHROPIC_API_KEY before resolving --model, so an operator
    // with only OpenAI credentials saw a false SKIP for
    // openai-family models. Now the gate keys on the resolved
    // model's family — `openai/...` checks for OPENAI_API_KEY,
    // not for Anthropic's. The test uses an unknown openai model
    // id so we trip "unknown model" AFTER the gate (proving the
    // gate let us through) without making a real network call.
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--model', 'openai/imaginary'], {
      out: io.out,
      err: io.err,
      env: OPENAI_ENV,
    });
    // Past the gate (no SKIP); falls to unknown-model exit 2.
    expect(exitCode).toBe(2);
    expect(io.outLines.join('\n')).not.toContain('SKIP');
    expect(io.errLines.join('\n')).toContain('unknown model');
  });

  test('SKIP message names the model id so multi-provider operators see which one needs creds', async () => {
    const io = collectIo();
    await runCritiqueRealEval(['--model', 'anthropic/claude-haiku-4-5'], {
      out: io.out,
      err: io.err,
      env: EMPTY_ENV,
    });
    expect(io.outLines.join('\n')).toContain('anthropic/claude-haiku-4-5');
  });
});

describe('critique-real runner — arg parsing', () => {
  test('unknown flag fails with exit 2 and a usage hint on stderr', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--bogus'], {
      out: io.out,
      err: io.err,
      env: ANTHROPIC_ENV,
    });
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain("unknown arg '--bogus'");
  });

  test('invalid --threshold fails with exit 2', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--threshold', '2.5'], {
      out: io.out,
      err: io.err,
      env: ANTHROPIC_ENV,
    });
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain('--threshold');
  });

  test('invalid --max-overhead fails with exit 2', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--max-overhead', '-100'], {
      out: io.out,
      err: io.err,
      env: ANTHROPIC_ENV,
    });
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain('--max-overhead');
  });

  test('--max-overhead 0 is accepted (engine semantic = watchdog disabled)', async () => {
    // Crosses parseArgs (where 0 is now legal) into the model-
    // resolution path; we trip "unknown model" with a fake
    // anthropic id to confirm parseArgs accepted the 0 without
    // throwing. Without this gate, the runner would have
    // refused a legitimate operator choice that the engine
    // honors.
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(
      ['--max-overhead', '0', '--model', 'anthropic/imaginary'],
      {
        out: io.out,
        err: io.err,
        env: ANTHROPIC_ENV,
      },
    );
    // Bumped past parseArgs; fails on the (now-deferred) unknown-
    // model check, NOT on --max-overhead.
    expect(exitCode).toBe(2);
    expect(io.errLines.join('\n')).toContain('unknown model');
  });

  test('known flag without value surfaces "missing value", not "unknown arg"', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(['--threshold'], {
      out: io.out,
      err: io.err,
      env: ANTHROPIC_ENV,
    });
    expect(exitCode).toBe(2);
    const errOut = io.errLines.join('\n');
    expect(errOut).toContain('missing value for --threshold');
    expect(errOut).not.toContain('unknown arg');
  });

  test('unknown model fails with exit 2 and lists known ids', async () => {
    const io = collectIo();
    const { exitCode } = await runCritiqueRealEval(
      ['--model', 'anthropic/imaginary-future-model'],
      {
        out: io.out,
        err: io.err,
        env: ANTHROPIC_ENV,
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
