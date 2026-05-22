import { describe, expect, test } from 'bun:test';
import { CONSTRAINTS_PROMPT, composeWithConstraints } from '../../src/cli/constraints-prompt.ts';

describe('constraints-prompt', () => {
  test('CONSTRAINTS_PROMPT carries the three §1.6 correctness constraints', () => {
    // The correctness floor: no inventing symbols, evidence over
    // assumption, no silent semantic change. Anchored so a future
    // edit cannot quietly drop one.
    expect(CONSTRAINTS_PROMPT).toContain('# Constraints');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('grep');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('evidence');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('semantic');
  });

  test('CONSTRAINTS_PROMPT states both sides of the security posture', () => {
    // A refusal-only rule over-blocks authorized work; an
    // assist-only rule under-blocks. Both halves must be present.
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('authorized');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('refuse');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('dual-use');
  });

  test('CONSTRAINTS_PROMPT covers hard-to-reverse actions and contradictory goals', () => {
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('hard-to-reverse');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('permission engine');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('contradictory goal');
  });

  test('composeWithConstraints returns the section alone when downstream is undefined', () => {
    expect(composeWithConstraints(undefined)).toBe(CONSTRAINTS_PROMPT);
  });

  test('composeWithConstraints returns the section alone when downstream is empty', () => {
    expect(composeWithConstraints('')).toBe(CONSTRAINTS_PROMPT);
  });

  test('composeWithConstraints prepends the section ahead of downstream, no --- separator', () => {
    const out = composeWithConstraints('# Parallelism\n\nbody');
    expect(out.startsWith(CONSTRAINTS_PROMPT)).toBe(true);
    expect(out).toBe(`${CONSTRAINTS_PROMPT}\n\n# Parallelism\n\nbody`);
  });
});
