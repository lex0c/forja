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

  test('CONSTRAINTS_PROMPT persistence nudge names the surviving mechanisms, not the withdrawn pin_context', () => {
    // pin_context was withdrawn from the model-facing surface (BACKLOG
    // 2026-06-15) because weak models pinned the re-injected guidance
    // block instead of answering. The persistence bullet must NOT
    // resurrect it, and must keep nudging memory_write for facts that
    // outlive the context window.
    expect(CONSTRAINTS_PROMPT).not.toContain('pin_context');
    expect(CONSTRAINTS_PROMPT).toContain('memory_write');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('compaction');
  });

  test('CONSTRAINTS_PROMPT nudges the planning panels so they are not dormant', () => {
    // Same ghost-tool reasoning as pin_context (BACKLOG 2026-06-05):
    // todo_create / working_state_update are re-injected panels that
    // survive compaction but go unused without a prompt nudge. Anchored
    // so a future edit cannot quietly drop the planning incentive.
    expect(CONSTRAINTS_PROMPT).toContain('working_state_update');
    expect(CONSTRAINTS_PROMPT).toContain('todo_create');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('hypotheses');
  });

  test('CONSTRAINTS_PROMPT carries the fix-the-cause rule relocated from static guidance', () => {
    // Moved out of the per-step static guidance block (re-paid uncached at the
    // turn tail every step) into the cached prefix (paid once). Anchored so the
    // move cannot silently drop it on either side.
    expect(CONSTRAINTS_PROMPT).toContain('Fix the cause, not the symptom');
    expect(CONSTRAINTS_PROMPT.toLowerCase()).toContain('suppressions');
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
