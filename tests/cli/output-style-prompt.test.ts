import { describe, expect, test } from 'bun:test';
import {
  OUTPUT_STYLE_PROMPT,
  composeWithOutputStyle,
} from '../../src/cli/output-style-prompt.ts';

describe('output-style-prompt', () => {
  test('anchors the density default — signal per token, not brevity', () => {
    const lower = OUTPUT_STYLE_PROMPT.toLowerCase();
    // The core framing: density, NOT word count.
    expect(lower).toContain('signal per token');
    // Findings-first ordering (the debug/investigation payoff).
    expect(lower).toContain('findings before evidence');
    // The Opus 4.8 re-tuning: silence between tool calls.
    expect(lower).toContain('silence between tool calls');
    // The correctness guard — this clause is load-bearing: it stops
    // the rule from stripping context that matters. A regression that
    // drops it would turn "be dense" into "be terse", losing info in
    // architecture/debug work.
    expect(lower).toContain('never trade information for brevity');
  });

  test('stays compact (always-on prefix token-budget guardrail)', () => {
    // Prepended on every turn inside the stable cache segment. ~55
    // tokens is the design target; chars are a deterministic proxy.
    // 600 chars keeps it a one-paragraph default, not a style essay.
    expect(OUTPUT_STYLE_PROMPT.length).toBeLessThan(600);
  });

  test('returns the hint alone when downstream is undefined', () => {
    expect(composeWithOutputStyle(undefined)).toBe(OUTPUT_STYLE_PROMPT);
  });

  test('returns the hint alone when downstream is empty', () => {
    expect(composeWithOutputStyle('')).toBe(OUTPUT_STYLE_PROMPT);
  });

  test('prepends hint with separator when downstream is set', () => {
    const out = composeWithOutputStyle('You are an expert.');
    expect(out.startsWith(OUTPUT_STYLE_PROMPT)).toBe(true);
    expect(out).toContain('---');
    expect(out).toContain('You are an expert.');
    // Hint → separator → downstream, same convention as the sibling
    // composers so a section boundary is grep-able by `---`.
    const sepIdx = out.indexOf('---');
    expect(sepIdx).toBeGreaterThan(OUTPUT_STYLE_PROMPT.length);
    expect(out.indexOf('You are an expert.')).toBeGreaterThan(sepIdx);
  });
});
