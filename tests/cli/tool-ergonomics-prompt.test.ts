import { describe, expect, test } from 'bun:test';
import {
  TOOL_ERGONOMICS_PROMPT,
  composeWithToolErgonomics,
} from '../../src/cli/tool-ergonomics-prompt.ts';

describe('tool-ergonomics-prompt', () => {
  test('hint anchors the high-payoff patterns from TOOL_ERGONOMICS.md', () => {
    // The hint MUST name the concrete tools and the patterns
    // that pay off every turn. A regression that softens to
    // generic "be efficient" advice would surface here — the
    // model needs the actionable surface, not abstract framing.
    // grep + offset/limit slicing — biggest token saver.
    expect(TOOL_ERGONOMICS_PROMPT).toContain('grep -n');
    expect(TOOL_ERGONOMICS_PROMPT).toContain('offset');
    expect(TOOL_ERGONOMICS_PROMPT).toContain('limit');
    // Filter-before-stdout — second biggest saver.
    expect(TOOL_ERGONOMICS_PROMPT).toContain('head');
    // Scope conservatism — points at the wildcard anti-pattern.
    expect(TOOL_ERGONOMICS_PROMPT).toContain('find .');
    // Dedicated-tool preference — Forja-specific advantage over
    // ad-hoc bash.
    expect(TOOL_ERGONOMICS_PROMPT).toContain('read_file');
    expect(TOOL_ERGONOMICS_PROMPT).toContain('edit_file');
    // Don't-re-read invariant — explicit cache awareness so
    // the model doesn't burn context on redundant reads.
    expect(TOOL_ERGONOMICS_PROMPT.toLowerCase()).toContain('not read it again');
    // Diagnose-before-retry — the fail-loop preventer.
    expect(TOOL_ERGONOMICS_PROMPT.toLowerCase()).toContain('retry');
  });

  test('hint points at the source-of-truth doc for depth', () => {
    // The base prompt distillation is intentional; deeper
    // patterns live in the spec. Pinning the pointer so a
    // refactor that drops the link surfaces here.
    expect(TOOL_ERGONOMICS_PROMPT).toContain('docs/spec/TOOL_ERGONOMICS.md');
  });

  test('hint stays compact (token-budget guardrail)', () => {
    // Base-prompt section, prepended on every turn. ~80 tokens
    // is the design target; chars are a deterministic proxy.
    // 1500 chars is a generous ceiling — if the section grows
    // past that, it's drifting out of "high-payoff distillation"
    // into "miniature spec doc", which defeats the architecture
    // (full spec exists for that).
    expect(TOOL_ERGONOMICS_PROMPT.length).toBeLessThan(1500);
  });

  test('composeWithToolErgonomics returns the hint alone when downstream is undefined', () => {
    expect(composeWithToolErgonomics(undefined)).toBe(TOOL_ERGONOMICS_PROMPT);
  });

  test('composeWithToolErgonomics returns the hint alone when downstream is empty', () => {
    expect(composeWithToolErgonomics('')).toBe(TOOL_ERGONOMICS_PROMPT);
  });

  test('composeWithToolErgonomics prepends hint with separator when downstream is set', () => {
    const out = composeWithToolErgonomics('You are an expert.');
    expect(out.startsWith(TOOL_ERGONOMICS_PROMPT)).toBe(true);
    expect(out).toContain('---');
    expect(out).toContain('You are an expert.');
    // Separator MUST sit between the two layers — same
    // convention as the parallel-hint composer so a debugger
    // grepping for `---` finds the section boundary
    // consistently.
    const hintEnd = TOOL_ERGONOMICS_PROMPT.length;
    const sepIdx = out.indexOf('---');
    expect(sepIdx).toBeGreaterThan(hintEnd);
    const downstreamIdx = out.indexOf('You are an expert.');
    expect(downstreamIdx).toBeGreaterThan(sepIdx);
  });
});
