import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../src/evals/cli.ts';

describe('parseArgs', () => {
  test('defaults: target=evals/smoke, repeat=1', () => {
    const r = parseArgs([]);
    expect(r.target).toBe('evals/smoke');
    expect(r.repeat).toBe(1);
    expect(r.modelId).toBeUndefined();
    expect(r.perCaseTimeoutMs).toBeUndefined();
  });

  test('positional arg overrides default target', () => {
    expect(parseArgs(['evals/regression']).target).toBe('evals/regression');
  });

  test('--model picks up the next token', () => {
    const r = parseArgs(['--model', 'anthropic/claude-haiku-4-5']);
    expect(r.modelId).toBe('anthropic/claude-haiku-4-5');
  });

  test('--repeat parses positive integer', () => {
    expect(parseArgs(['--repeat', '3']).repeat).toBe(3);
  });

  test('--timeout-ms parses positive number', () => {
    expect(parseArgs(['--timeout-ms', '90000']).perCaseTimeoutMs).toBe(90000);
  });

  test('flags + positional in any order', () => {
    const r = parseArgs(['--model', 'openai/gpt-4o-mini', 'evals/smoke', '--repeat', '2']);
    expect(r.modelId).toBe('openai/gpt-4o-mini');
    expect(r.target).toBe('evals/smoke');
    expect(r.repeat).toBe(2);
  });

  // Regression: --model used to consume argv[++i] blindly. Calling
  // `forja eval --model --repeat 5` would silently bind '--repeat'
  // as the model id (bypassing the registry's "unknown model" check
  // when the model id field isn't validated upstream) or, when
  // --model was the last token, leave modelId undefined and run
  // against the default. Both produced runs against unintended
  // models — invalidating cost/pass-rate baselines without an
  // error visible at parse time.
  test('--model with no value throws', () => {
    expect(() => parseArgs(['--model'])).toThrow(/--model requires a value/);
  });

  test('--model followed by another flag throws (does not swallow)', () => {
    expect(() => parseArgs(['--model', '--repeat', '5'])).toThrow(/--model requires a value/);
  });

  test('--repeat with no value throws', () => {
    expect(() => parseArgs(['--repeat'])).toThrow(/--repeat requires a value/);
  });

  test('--repeat followed by another flag throws', () => {
    expect(() => parseArgs(['--repeat', '--model', 'x'])).toThrow(/--repeat requires a value/);
  });

  test('--timeout-ms with no value throws', () => {
    expect(() => parseArgs(['--timeout-ms'])).toThrow(/--timeout-ms requires a value/);
  });

  test('--timeout-ms followed by another flag throws', () => {
    expect(() => parseArgs(['--timeout-ms', '--model', 'x'])).toThrow(
      /--timeout-ms requires a value/,
    );
  });

  test('--repeat 0 rejected', () => {
    expect(() => parseArgs(['--repeat', '0'])).toThrow(/--repeat must be a positive integer/);
  });

  test('--repeat non-integer rejected', () => {
    expect(() => parseArgs(['--repeat', '1.5'])).toThrow(/--repeat must be a positive integer/);
  });

  test('--timeout-ms 0 rejected', () => {
    expect(() => parseArgs(['--timeout-ms', '0'])).toThrow(
      /--timeout-ms must be a positive number/,
    );
  });

  test('unknown flag throws', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument: --bogus/);
  });
});
