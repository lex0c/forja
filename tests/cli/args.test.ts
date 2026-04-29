import { describe, expect, test } from 'bun:test';
import { parseArgs, usage } from '../../src/cli/args.ts';

describe('parseArgs', () => {
  test('plain prompt', () => {
    const r = parseArgs(['hello', 'world']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.prompt).toBe('hello world');
    expect(r.args.json).toBe(false);
    expect(r.args.version).toBe(false);
  });

  test('--version (and -v) flag', () => {
    for (const flag of ['--version', '-v']) {
      const r = parseArgs([flag]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.args.version).toBe(true);
    }
  });

  test('--help (and -h) flag', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseArgs([flag]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.args.help).toBe(true);
    }
  });

  test('--json flag', () => {
    const r = parseArgs(['--json', 'do', 'thing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(true);
    expect(r.args.prompt).toBe('do thing');
  });

  test('--plan flag', () => {
    const r = parseArgs(['--plan', 'refactor src/auth.ts']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.plan).toBe(true);
    expect(r.args.prompt).toBe('refactor src/auth.ts');
  });

  test('--plan defaults to false when omitted', () => {
    const r = parseArgs(['hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.plan).toBe(false);
  });

  test('--model with value', () => {
    const r = parseArgs(['--model', 'openai/gpt-4o', 'hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.model).toBe('openai/gpt-4o');
    expect(r.args.prompt).toBe('hi');
  });

  test('--model without value rejects', () => {
    const r = parseArgs(['--model']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--model requires a value');
  });

  test('--model swallows the next arg even if missing prompt', () => {
    const r = parseArgs(['--model', 'foo']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.model).toBe('foo');
    expect(r.args.prompt).toBe('');
  });

  test('--model rejects when next token is another flag', () => {
    const r = parseArgs(['--model', '--json']);
    expect(r.ok).toBe(false);
  });

  test('--max-steps parses positive integer', () => {
    const r = parseArgs(['--max-steps', '7', 'hi']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.maxSteps).toBe(7);
  });

  test('--max-steps rejects non-numeric', () => {
    const r = parseArgs(['--max-steps', 'abc']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('--max-steps must be');
  });

  test('--max-steps rejects zero or negative', () => {
    expect(parseArgs(['--max-steps', '0']).ok).toBe(false);
    expect(parseArgs(['--max-steps', '-1']).ok).toBe(false);
  });

  test('--max-steps rejects decimals (would silently truncate via parseInt)', () => {
    const r = parseArgs(['--max-steps', '3.5']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("got '3.5'");
  });

  test('--max-steps rejects leading-zero / hex / scientific notation', () => {
    expect(parseArgs(['--max-steps', '0x10']).ok).toBe(false);
    expect(parseArgs(['--max-steps', '1e3']).ok).toBe(false);
    expect(parseArgs(['--max-steps', '007']).ok).toBe(false);
  });

  test('unknown flag rejects', () => {
    const r = parseArgs(['--bogus', 'hi']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('unknown flag: --bogus');
  });

  test('mixed flags and prompt', () => {
    const r = parseArgs(['--json', '--model', 'a/b', 'do', '--max-steps', '5', 'thing']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.json).toBe(true);
    expect(r.args.model).toBe('a/b');
    expect(r.args.maxSteps).toBe(5);
    expect(r.args.prompt).toBe('do thing');
  });

  test('empty argv', () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.prompt).toBe('');
  });
});

describe('usage', () => {
  test('mentions every recognized flag', () => {
    const u = usage();
    expect(u).toContain('--version');
    expect(u).toContain('--help');
    expect(u).toContain('--json');
    expect(u).toContain('--plan');
    expect(u).toContain('--model');
    expect(u).toContain('--max-steps');
  });
});
