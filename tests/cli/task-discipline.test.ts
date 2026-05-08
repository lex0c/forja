import { describe, expect, test } from 'bun:test';
import { composeWithTaskDiscipline } from '../../src/cli/task-discipline.ts';

// Pin the contract: composer always emits the discipline section
// (no opt-out — the guidance applies regardless of whether the
// operator supplied a base prompt). Header text and the load-
// bearing nudges (prefer editing, no premature abstractions, etc)
// are pinned so a softening rewrite shows up at PR review.

describe('composeWithTaskDiscipline', () => {
  test('emits the discipline section when downstream is undefined', () => {
    const out = composeWithTaskDiscipline(undefined);
    expect(out).toContain('# Task discipline');
    expect(out).toContain('Prefer editing existing files over creating new ones');
  });

  test('emits the discipline section when downstream is empty', () => {
    const out = composeWithTaskDiscipline('');
    expect(out).toContain('# Task discipline');
  });

  test('prepends the section to a non-empty downstream with a blank-line separator', () => {
    const out = composeWithTaskDiscipline('caller body');
    expect(out.startsWith('# Task discipline')).toBe(true);
    expect(out.endsWith('caller body')).toBe(true);
    expect(out).toContain('\n\ncaller body');
  });

  test('pins the load-bearing behavioral nudges', () => {
    // These specific phrases drive the output-quality difference.
    // A regression that softens any of them shows up here. The
    // exact wording isn't load-bearing — what matters is that
    // each behavioral rule has SOME presence in the section.
    const out = composeWithTaskDiscipline(undefined);
    expect(out).toContain('Prefer editing');
    expect(out).toContain("Don't introduce abstractions");
    expect(out).toContain('Default to writing no comments');
    expect(out).toContain('the WHY is non-obvious');
    expect(out).toContain("Don't add error handling");
    expect(out).toContain("Don't add backwards-compatibility");
  });

  test('section size is reasonable (~150 tokens / ~1k chars)', () => {
    // Section sits inside cache breakpoint #1 — bigger means
    // more cached input but also more attention budget consumed
    // before the model gets to task-specific instructions. 1500
    // chars is a generous ceiling that still keeps the section
    // ~150 tokens.
    const out = composeWithTaskDiscipline(undefined);
    expect(out.length).toBeLessThan(1500);
  });
});
