import { describe, expect, test } from 'bun:test';
import { PARALLEL_HINT_PROMPT, composeWithParallelHint } from '../../src/cli/parallel-prompt.ts';

describe('parallel-prompt', () => {
  test('PARALLEL_HINT_PROMPT names the parallel-safe tools and the task_async family', () => {
    // Anchoring assertions: the hint MUST cite concrete tool
    // names, otherwise the model is left with "be parallel"
    // abstract advice and no actionable surface.
    expect(PARALLEL_HINT_PROMPT).toContain('read_file');
    expect(PARALLEL_HINT_PROMPT).toContain('grep');
    expect(PARALLEL_HINT_PROMPT).toContain('glob');
    expect(PARALLEL_HINT_PROMPT).toContain('memory_read');
    expect(PARALLEL_HINT_PROMPT).toContain('task_async');
    expect(PARALLEL_HINT_PROMPT).toContain('task_await');
    expect(PARALLEL_HINT_PROMPT).toContain('task_cancel');
    expect(PARALLEL_HINT_PROMPT).toContain('task_list');
  });

  test('PARALLEL_HINT_PROMPT acknowledges sequential dispatch is right when steps depend', () => {
    // The hint must NOT push parallel-everywhere — the model
    // needs to know when sequential is correct, otherwise
    // we'd see broken fan-outs over dependent work.
    expect(PARALLEL_HINT_PROMPT.toLowerCase()).toContain('sequential');
    expect(PARALLEL_HINT_PROMPT.toLowerCase()).toContain('depend');
  });

  test('composeWithParallelHint returns the hint alone when downstream is undefined', () => {
    const out = composeWithParallelHint(undefined);
    expect(out).toBe(PARALLEL_HINT_PROMPT);
  });

  test('composeWithParallelHint returns the hint alone when downstream is empty', () => {
    const out = composeWithParallelHint('');
    expect(out).toBe(PARALLEL_HINT_PROMPT);
  });

  test('composeWithParallelHint prepends hint with separator when downstream is set', () => {
    const out = composeWithParallelHint('You are an expert.');
    expect(out.startsWith(PARALLEL_HINT_PROMPT)).toBe(true);
    expect(out).toContain('---');
    expect(out).toContain('You are an expert.');
    // The separator must SIT BETWEEN the two layers — not be
    // embedded inside the hint or the downstream.
    const hintEnd = PARALLEL_HINT_PROMPT.length;
    const sepIdx = out.indexOf('---');
    expect(sepIdx).toBeGreaterThan(hintEnd);
    const downstreamIdx = out.indexOf('You are an expert.');
    expect(downstreamIdx).toBeGreaterThan(sepIdx);
  });
});
