import { describe, expect, test } from 'bun:test';
import { CONSTRAINTS_PROMPT, composeWithConstraints } from '../../src/cli/constraints-prompt.ts';

describe('constraints-prompt', () => {
  test('CONSTRAINTS_PROMPT carries the §1.6 correctness constraints', () => {
    // The correctness floor: no inventing symbols, investigate
    // call sites before changing a contract, evidence over
    // assumption, no silent semantic change. Anchored so a future
    // edit cannot quietly drop one.
    expect(CONSTRAINTS_PROMPT).toContain('# Constraints');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('grep');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('investigate');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('call sites');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('evidence');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('semantic');
  });

  test('CONSTRAINTS_PROMPT incentivizes asking via clarify over presuming', () => {
    // The anti-presumption gate (STATE_MACHINE §12): the system prompt
    // must point at `clarify` so the model treats asking the operator
    // as a first-class alternative to guessing on a load-bearing
    // ambiguity — not just discover the tool from its description.
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('clarify');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('presume');
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

  test('CONSTRAINTS_PROMPT carries the build-discipline constraint absorbed from task-discipline', () => {
    // The build-discipline floor (no premature abstraction, no
    // error handling for impossible cases, no narrative comments,
    // no back-compat shims, edit-over-rewrite / smallest diff) was
    // folded in here when the standalone `# Task discipline`
    // section was dissolved (2026-06-07). Anchored so a future
    // edit cannot quietly soften or drop it.
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain("build only what's asked");
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('premature abstraction');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('back-compat');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('smallest correct diff');
  });

  test('CONSTRAINTS_PROMPT re-arms pin_context so the shipped tool is not dormant', () => {
    // Regression guard: the only pin_context nudge used to live in
    // the dissolved `# Task discipline` section. Without a prompt
    // mention the tool ships but goes dormant (BACKLOG 2026-06-05),
    // so the re-armed bullet is anchored here.
    expect(CONSTRAINTS_PROMPT).toContain('pin_context');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('compaction');
  });

  test('CONSTRAINTS_PROMPT tells the model to match existing code conventions', () => {
    // Always-present floor against cross-file paradigm drift
    // (functional here, OO there). Explicit project rules ride in
    // AGENTS.md (surfaced lazily by the project pointer); this is
    // the rule for repos that have none — the gap the frontier
    // alignment does not close on its own.
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('match the surrounding code');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('convention');
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
